#!/usr/bin/env python3
"""
Servidor Flask para servir dados de censos e calcular população em isócronas
"""
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import geopandas as gpd
import json
import os
import requests
import csv
import io
import time
from dotenv import load_dotenv
import math
from shapely.geometry import Point, Polygon, shape
from shapely.ops import unary_union

# Carregar variáveis de ambiente do ficheiro .env
load_dotenv()

# ==================== Job Coefficients (OSM → employment estimate) ====================
# Values based on INE SCIE 2021 averages for Portuguese municipalities of Évora's size.
# Format: osm_tag_key → { tag_value: (category, jobs_per_establishment) }
# Special jobs value '__area__' means compute from polygon area × jobs/ha rate.
JOBS_PER_HA = {
    'industrial': 20,   # light industry / logistics
    'commercial': 40,   # offices + retail mix
    'retail':     40,   # retail parks
}

def classify_poi_tags(el_type, tags):
    """Return (category, jobs) or (None, None) if not relevant.
    category ∈ {'commerce', 'services', 'education_health', 'culture_leisure', 'industry'}
    jobs is an integer, or '__area__' for landuse polygons (area-based calculation).
    """
    shop = tags.get('shop')
    if shop:
        if shop in ('supermarket', 'hypermarket'):
            return ('commerce', 25)
        if shop in ('mall', 'department_store'):
            return ('commerce', 80)
        if shop in ('convenience', 'bakery', 'butcher', 'greengrocer', 'fishmonger', 'deli'):
            return ('commerce', 3)
        if shop in ('clothes', 'shoes', 'sports', 'books', 'gift', 'jewelry', 'florist', 'optician'):
            return ('commerce', 5)
        if shop in ('furniture', 'bed', 'kitchen', 'carpet'):
            return ('commerce', 8)
        if shop in ('car', 'car_repair', 'motorcycle', 'bicycle'):
            return ('commerce', 10)
        if shop in ('hardware', 'doityourself', 'garden'):
            return ('commerce', 6)
        if shop in ('electronics', 'computer', 'mobile_phone'):
            return ('commerce', 8)
        return ('commerce', 4)   # generic retail

    amenity = tags.get('amenity')
    if amenity:
        if amenity == 'restaurant':
            return ('commerce', 8)
        if amenity in ('cafe', 'bar', 'pub', 'biergarten'):
            return ('commerce', 3)
        if amenity == 'fast_food':
            return ('commerce', 6)
        if amenity == 'food_court':
            return ('commerce', 20)
        if amenity == 'bank':
            return ('services', 8)
        if amenity == 'post_office':
            return ('services', 15)
        if amenity == 'police':
            return ('services', 25)
        if amenity == 'fire_station':
            return ('services', 15)
        if amenity == 'hospital':
            return ('education_health', 200)
        if amenity in ('clinic', 'doctors'):
            return ('education_health', 8)
        if amenity == 'dentist':
            return ('education_health', 4)
        if amenity == 'pharmacy':
            return ('education_health', 5)
        if amenity == 'veterinary':
            return ('education_health', 3)
        if amenity in ('school', 'language_school'):
            return ('education_health', 25)
        if amenity == 'kindergarten':
            return ('education_health', 8)
        if amenity == 'university':
            return ('education_health', 150)
        if amenity == 'college':
            return ('education_health', 60)
        if amenity in ('theatre', 'arts_centre'):
            return ('culture_leisure', 15)
        if amenity == 'cinema':
            return ('culture_leisure', 12)
        if amenity == 'library':
            return ('culture_leisure', 8)
        if amenity == 'museum':
            return ('culture_leisure', 12)
        if amenity == 'nightclub':
            return ('commerce', 8)
        if amenity in ('fuel', 'car_wash'):
            return ('services', 5)

    office = tags.get('office')
    if office:
        if office in ('government', 'administrative'):
            return ('services', 20)
        if office in ('lawyer', 'accountant', 'insurance', 'financial', 'tax_advisor'):
            return ('services', 6)
        return ('services', 8)

    tourism = tags.get('tourism')
    if tourism == 'hotel':
        return ('commerce', 20)
    if tourism in ('hostel', 'motel', 'apartment'):
        return ('commerce', 8)
    if tourism == 'guest_house':
        return ('commerce', 4)

    leisure = tags.get('leisure')
    if leisure in ('sports_centre', 'fitness_centre', 'stadium'):
        return ('culture_leisure', 15)
    if leisure in ('swimming_pool', 'golf_course'):
        return ('culture_leisure', 10)

    # Landuse polygons (area-based) — only meaningful for way/relation
    if el_type == 'way':
        landuse = tags.get('landuse')
        if landuse == 'industrial':
            return ('industry', '__area__')
        if landuse in ('commercial', 'retail'):
            return ('commerce', '__area__')

    return (None, None)


def compute_shannon_h(residents, breakdown):
    """Compute normalised Shannon entropy H for land-use mix.
    residents: int — population in isochrone
    breakdown: dict with keys commerce, services, education_health, culture_leisure, industry
    Returns (h_norm [0..1], tod_classification string)
    """
    cats = {
        'residents':        max(0, residents),
        'commerce':         max(0, breakdown.get('commerce', 0)),
        'services':         max(0, breakdown.get('services', 0)),
        'education_health': max(0, breakdown.get('education_health', 0)),
        'culture_leisure':  max(0, breakdown.get('culture_leisure', 0)),
        'industry':         max(0, breakdown.get('industry', 0)),
    }
    total = sum(cats.values())
    if total == 0:
        return (0.0, 'Sem dados')

    n_positive = sum(1 for v in cats.values() if v > 0)
    if n_positive < 2:
        return (0.0, 'Mono-funcional')

    h = 0.0
    for v in cats.values():
        if v > 0:
            p = v / total
            h -= p * math.log(p)

    h_max = math.log(n_positive)
    h_norm = h / h_max if h_max > 0 else 0.0

    # TOD classification
    jobs_total = sum(v for k, v in cats.items() if k != 'residents')
    ratio = jobs_total / residents if residents > 0 else 0
    if h_norm >= 0.6:
        classification = 'TOD maduro'
    elif h_norm >= 0.4 and ratio >= 0.2:
        classification = 'Misto equilibrado'
    elif ratio >= 0.5:
        classification = 'Nó de emprego'
    elif h_norm >= 0.3:
        classification = 'Misto desequilibrado'
    else:
        classification = 'Dormitório'

    return (round(h_norm, 3), classification)

app = Flask(__name__, static_folder='static', static_url_path='/static')
CORS(app)

# API Key do OpenRouteService
# Definida no ficheiro .env (ver .env.example)
ORS_API_KEY = os.getenv('ORS_API_KEY')
if not ORS_API_KEY:
    print("AVISO: ORS_API_KEY não definida! Copia .env.example para .env e adiciona a tua chave.")
    print("       Obter chave em: https://openrouteservice.org/dev/#/signup")

# Carregar dados de censos
CENSUS_DATA = None
POP_COLUMN = None
METADATA = None

def load_census_data():
    """Carrega dados de censos na memória"""
    global CENSUS_DATA, POP_COLUMN, METADATA
    
    census_file = "data/census_data.geojson"
    metadata_file = "data/metadata.json"
    
    if not os.path.exists(census_file):
        return {"error": "Dados de censos não processados. Execute: python3 process_data.py"}
    
    CENSUS_DATA = gpd.read_file(census_file)
    
    if os.path.exists(metadata_file):
        with open(metadata_file, "r", encoding="utf-8") as f:
            METADATA = json.load(f)
            POP_COLUMN = METADATA.get("pop_column")
    
    # Se não houver coluna de população definida, procurar
    if not POP_COLUMN or POP_COLUMN not in CENSUS_DATA.columns:
        # Prioridade: N_INDIVIDUOS
        if 'N_INDIVIDUOS' in CENSUS_DATA.columns:
            POP_COLUMN = 'N_INDIVIDUOS'
        else:
            pop_cols = [col for col in CENSUS_DATA.columns if 'INDIVIDUOS' in col.upper() or 'POP' in col.upper() or 'HABITANTES' in col.upper()]
            if pop_cols:
                POP_COLUMN = pop_cols[0]
            else:
                # Usar primeira coluna numérica (não ideal)
                numeric_cols = CENSUS_DATA.select_dtypes(include=['int64', 'float64']).columns.tolist()
                numeric_cols = [col for col in numeric_cols if 'SHAPE' not in col and 'OBJECTID' not in col and 'ID' not in col]
                if numeric_cols:
                    POP_COLUMN = numeric_cols[0]
                    print(f"AVISO: Usando '{POP_COLUMN}' como população (pode não ser correto!)")
    
    print(f"Dados carregados: {len(CENSUS_DATA)} features")
    print(f"Coluna de população: {POP_COLUMN}")
    if POP_COLUMN and POP_COLUMN in CENSUS_DATA.columns:
        total_pop = CENSUS_DATA[POP_COLUMN].sum()
        print(f"População total nos dados: {total_pop:,.0f}")

@app.route('/')
def index():
    """Serve a página principal"""
    return send_from_directory('static', 'index.html')

@app.route('/api/census-metadata')
def get_metadata():
    """Retorna metadados dos dados de censos"""
    if METADATA:
        return jsonify(METADATA)
    return jsonify({"error": "Metadados não disponíveis"})

@app.route('/api/census-geojson')
def get_census_geojson():
    """Serve census data as GeoJSON for the scenario layer"""
    global CENSUS_DATA, POP_COLUMN
    if CENSUS_DATA is None:
        load_census_data()
    if CENSUS_DATA is None:
        return jsonify({"error": "Dados não carregados"}), 500

    # Ensure WGS84
    gdf = CENSUS_DATA.to_crs("EPSG:4326") if CENSUS_DATA.crs != "EPSG:4326" else CENSUS_DATA
    return app.response_class(
        gdf.to_json(),
        mimetype='application/json'
    )

@app.route('/api/isochrones', methods=['POST'])
def get_isochrones():
    """Calcula isócronas reais usando OpenRouteService"""
    data = request.json
    lat = data.get('lat')
    lng = data.get('lng')
    ranges = data.get('ranges', [300, 600])  # 5 min e 10 min em segundos
    
    if not lat or not lng:
        return jsonify({"error": "Coordenadas não fornecidas"}), 400
    
    try:
        # OpenRouteService API
        url = "https://api.openrouteservice.org/v2/isochrones/foot-walking"
        
        headers = {
            "Accept": "application/json, application/geo+json",
            "Content-Type": "application/json"
        }
        
        # Adicionar API key se disponível
        if ORS_API_KEY:
            headers["Authorization"] = f"Bearer {ORS_API_KEY}"
        
        body = {
            "locations": [[lng, lat]],  # OpenRouteService usa [lng, lat]
            "range": ranges,  # em segundos
            "range_type": "time"
        }
        
        response = requests.post(url, json=body, headers=headers, timeout=15)
        
        if response.status_code == 200:
            result = response.json()
            
            # Converter para formato GeoJSON
            isochrones = []
            if 'features' in result:
                for feature in result['features']:
                    isochrones.append(feature)
            
            if isochrones:
                return jsonify({"isochrones": isochrones})
        
        # Se chegou aqui, a API falhou ou não retornou dados
        print(f"OpenRouteService retornou status {response.status_code}, usando fallback")
        return create_fallback_isochrones(lat, lng, ranges)
        
    except requests.exceptions.RequestException as e:
        print(f"Erro de conexão com OpenRouteService: {e}")
        # Fallback: usar círculos
        return create_fallback_isochrones(lat, lng, ranges)
    except Exception as e:
        print(f"Erro ao obter isócronas: {e}")
        # Fallback: usar círculos
        return create_fallback_isochrones(lat, lng, ranges)

def create_fallback_isochrones(lat, lng, ranges):
    """Cria isócronas usando círculos como fallback"""
    import math
    
    # Velocidade a pé: ~5 km/h = ~1.39 m/s
    speed_ms = 1.39
    
    isochrones = []
    for range_seconds in ranges:
        # Calcular raio em metros
        radius_m = range_seconds * speed_ms
        
        # Converter para graus (aproximação)
        # 1 grau de latitude ≈ 111 km
        radius_deg = radius_m / 111000
        
        # Criar círculo usando Turf.js (será feito no frontend se necessário)
        # Por agora, retornamos um círculo simples
        center = [lng, lat]
        # Vamos criar um polígono circular simples
        import math
        num_points = 64
        points = []
        for i in range(num_points):
            angle = 2 * math.pi * i / num_points
            dx = radius_deg * math.cos(angle)
            dy = radius_deg * math.sin(angle)
            points.append([center[0] + dx, center[1] + dy])
        points.append(points[0])  # Fechar o polígono
        
        isochrone = {
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [points]
            },
            "properties": {
                "value": range_seconds
            }
        }
        isochrones.append(isochrone)
    
    return jsonify({"isochrones": isochrones})

@app.route('/api/population-in-isochrones', methods=['POST'])
def calculate_population():
    """Calcula população dentro de isócronas, evitando duplicações em sobreposições"""
    global CENSUS_DATA, POP_COLUMN
    
    if CENSUS_DATA is None:
        load_census_data()
    
    if CENSUS_DATA is None:
        return jsonify({"error": "Dados não carregados"}), 500
    
    data = request.json
    points = data.get('points', [])  # [{lat, lng, id, isochrones?}]
    density_overrides = data.get('density_overrides', {})  # { bgriId: { densityType, populationOverride } }
    new_urbanization_features = data.get('new_urbanization_features', [])  # GeoJSON Feature list
    
    if not points:
        return jsonify({
            "total_population": 0,
            "total_population_5min": 0,
            "total_population_10min": 0,
            "points": []
        })
    
    # Velocidade a pé: ~5 km/h = ~83 m/min = ~1.39 m/s
    # 5 minutos = 300 segundos, 10 minutos = 600 segundos
    # Raio aproximado: 5 min = ~417 metros, 10 min = ~833 metros
    radius_5min = 417  # metros (fallback)
    radius_10min = 833  # metros (fallback)
    
    # Preparar dados dos pontos e suas isócronas
    point_info = []
    all_5min_buffers = []
    all_10min_buffers = []
    
    for point_data in points:
        lat = point_data['lat']
        lng = point_data['lng']
        # Preservar o ID original, convertendo para int se necessário
        point_id_raw = point_data.get('id')
        if point_id_raw is None:
            point_id = len(point_info)
        else:
            # Tentar converter para int, mas manter original se falhar
            try:
                point_id = int(point_id_raw)
            except (ValueError, TypeError):
                point_id = point_id_raw
        
        # Criar ponto em WGS84
        point_wgs84 = Point(lng, lat)
        point_gdf_wgs84 = gpd.GeoDataFrame([1], geometry=[point_wgs84], crs="EPSG:4326")
        
        # Converter para CRS métrico (Web Mercator) para criar buffers precisos em metros
        point_gdf_metric = point_gdf_wgs84.to_crs("EPSG:3857")
        point_metric = point_gdf_metric.geometry.iloc[0]
        
        # Converter ponto para CRS dos dados de censos para cálculos de distância
        point_gdf_census = point_gdf_wgs84.to_crs(CENSUS_DATA.crs)
        point_census = point_gdf_census.geometry.iloc[0]
        
        # Verificar se há isócronas reais fornecidas
        isochrones = point_data.get('isochrones')
        
        if isochrones and len(isochrones) >= 2:
            # Usar isócronas reais
            try:
                # Converter isócronas GeoJSON para Shapely
                iso_5min_geom = shape(isochrones[0]['geometry'])
                iso_10min_geom = shape(isochrones[1]['geometry'])
                
                # Converter para o CRS dos dados de censos
                iso_5min_gdf = gpd.GeoDataFrame([1], geometry=[iso_5min_geom], crs="EPSG:4326")
                iso_10min_gdf = gpd.GeoDataFrame([1], geometry=[iso_10min_geom], crs="EPSG:4326")
                
                if CENSUS_DATA.crs != "EPSG:4326":
                    iso_5min_gdf = iso_5min_gdf.to_crs(CENSUS_DATA.crs)
                    iso_10min_gdf = iso_10min_gdf.to_crs(CENSUS_DATA.crs)
                
                buffer_5min = iso_5min_gdf.geometry.iloc[0]
                buffer_10min = iso_10min_gdf.geometry.iloc[0]
            except Exception as e:
                print(f"Erro ao processar isócronas reais, usando fallback: {e}")
                # Fallback para círculos
                buffer_5min_metric = point_metric.buffer(radius_5min)
                buffer_10min_metric = point_metric.buffer(radius_10min)
                buffer_gdf_5 = gpd.GeoDataFrame([1], geometry=[buffer_5min_metric], crs="EPSG:3857")
                buffer_gdf_10 = gpd.GeoDataFrame([1], geometry=[buffer_10min_metric], crs="EPSG:3857")
                buffer_5min = buffer_gdf_5.to_crs(CENSUS_DATA.crs).geometry.iloc[0]
                buffer_10min = buffer_gdf_10.to_crs(CENSUS_DATA.crs).geometry.iloc[0]
        else:
            # Usar círculos como fallback
            buffer_5min_metric = point_metric.buffer(radius_5min)
            buffer_10min_metric = point_metric.buffer(radius_10min)
            buffer_gdf_5 = gpd.GeoDataFrame([1], geometry=[buffer_5min_metric], crs="EPSG:3857")
            buffer_gdf_10 = gpd.GeoDataFrame([1], geometry=[buffer_10min_metric], crs="EPSG:3857")
            buffer_5min = buffer_gdf_5.to_crs(CENSUS_DATA.crs).geometry.iloc[0]
            buffer_10min = buffer_gdf_10.to_crs(CENSUS_DATA.crs).geometry.iloc[0]
        
        point_info.append({
            'id': point_id,
            'lat': lat,
            'lng': lng,
            'point': point_census,
            'buffer_5min': buffer_5min,
            'buffer_10min': buffer_10min
        })
        all_5min_buffers.append(buffer_5min)
        all_10min_buffers.append(buffer_10min)
    
    # Calcular população evitando duplicações
    results = []
    total_pop_5min = 0
    total_pop_10min = 0
    
    # Inicializar população para cada ponto
    point_populations = {p['id']: {'5min': 0, '10min': 0} for p in point_info}

    # Helper: get population for a census row (respecting density overrides)
    def get_pop_for_row(row):
        bgri_id = None
        for col in ['BGRI2021', 'SUBSECCAO', 'OBJECTID']:
            if col in row.index:
                bgri_id = str(row[col])
                break
        if bgri_id and bgri_id in density_overrides:
            return density_overrides[bgri_id].get('populationOverride', row[POP_COLUMN])
        return row[POP_COLUMN]
    
    if POP_COLUMN and POP_COLUMN in CENSUS_DATA.columns:
        # Criar união de todas as isócronas para encontrar todas as áreas de censo afetadas
        union_5min = unary_union(all_5min_buffers) if all_5min_buffers else None
        union_10min = unary_union(all_10min_buffers) if all_10min_buffers else None
        
        # Encontrar todas as áreas de censo que intersectam com qualquer isócrona
        if union_5min:
            census_in_any_5min = CENSUS_DATA[CENSUS_DATA.geometry.intersects(union_5min)].copy()
        else:
            census_in_any_5min = gpd.GeoDataFrame()
        
        if union_10min:
            census_in_any_10min = CENSUS_DATA[CENSUS_DATA.geometry.intersects(union_10min)].copy()
        else:
            census_in_any_10min = gpd.GeoDataFrame()
        
        # Processar área de 5 minutos
        for idx, row in census_in_any_5min.iterrows():
            # Encontrar todos os pontos cujas isócronas de 5 min intersectam esta área de censo
            intersecting_points = []
            for point_idx, point_data in enumerate(point_info):
                intersection = row.geometry.intersection(point_data['buffer_5min'])
                if not intersection.is_empty and intersection.area > 0:
                    intersecting_points.append({
                        'point_idx': point_idx,
                        'point_data': point_data,
                        'intersection': intersection
                    })
            
            if not intersecting_points:
                continue
            
            # Se há apenas um ponto, atribuir diretamente
            if len(intersecting_points) == 1:
                point_data = intersecting_points[0]['point_data']
                intersection = intersecting_points[0]['intersection']
                area_ratio = intersection.area / row.geometry.area if row.geometry.area > 0 else 1.0
                pop_value = get_pop_for_row(row) * area_ratio
                point_populations[point_data['id']]['5min'] += pop_value
            else:
                # Há sobreposição - dividir a área de censo entre os pontos mais próximos
                # Para cada parte da interseção, determinar qual ponto está mais próximo
                # Para cada ponto que intersecta, calcular a parte única (sem sobreposição)
                for i, item in enumerate(intersecting_points):
                    point_id = item['point_data']['id']
                    intersection = item['intersection']
                    
                    # Remover partes que já foram atribuídas a outros pontos mais próximos
                    unique_intersection = intersection
                    for other_item in intersecting_points:
                        if other_item['point_data']['id'] != point_id:
                            other_intersection = other_item['intersection']
                            # Verificar se há sobreposição
                            if unique_intersection.intersects(other_intersection):
                                # Determinar qual ponto está mais próximo do centroide da sobreposição
                                overlap = unique_intersection.intersection(other_intersection)
                                if not overlap.is_empty:
                                    overlap_centroid = overlap.centroid
                                    dist_current = item['point_data']['point'].distance(overlap_centroid)
                                    dist_other = other_item['point_data']['point'].distance(overlap_centroid)
                                    
                                    # Se o outro ponto está mais próximo, remover a sobreposição
                                    if dist_other < dist_current:
                                        unique_intersection = unique_intersection.difference(overlap)
                    
                    # Atribuir população da parte única
                    if not unique_intersection.is_empty and unique_intersection.area > 0:
                        area_ratio = unique_intersection.area / row.geometry.area if row.geometry.area > 0 else 1.0
                        pop_value = get_pop_for_row(row) * area_ratio
                        point_populations[point_id]['5min'] += pop_value
        
        # Processar área de 10 minutos (apenas a parte que não está em 5 min)
        for idx, row in census_in_any_10min.iterrows():
            # Encontrar todos os pontos cujas isócronas de 10 min intersectam esta área de censo
            intersecting_points = []
            for point_idx, point_data in enumerate(point_info):
                intersection_10min = row.geometry.intersection(point_data['buffer_10min'])
                if not intersection_10min.is_empty and intersection_10min.area > 0:
                    # Remover a parte que já está na área de 5 min deste ponto
                    intersection_5min = row.geometry.intersection(point_data['buffer_5min'])
                    if not intersection_5min.is_empty:
                        intersection_secondary = intersection_10min.difference(intersection_5min)
                    else:
                        intersection_secondary = intersection_10min
                    
                    if not intersection_secondary.is_empty and intersection_secondary.area > 0:
                        intersecting_points.append({
                            'point_idx': point_idx,
                            'point_data': point_data,
                            'intersection': intersection_secondary
                        })
            
            if not intersecting_points:
                continue
            
            # Se há apenas um ponto, atribuir diretamente
            if len(intersecting_points) == 1:
                point_data = intersecting_points[0]['point_data']
                intersection = intersecting_points[0]['intersection']
                area_ratio = intersection.area / row.geometry.area if row.geometry.area > 0 else 1.0
                pop_value = get_pop_for_row(row) * area_ratio
                point_populations[point_data['id']]['10min'] += pop_value
            else:
                # Há sobreposição - dividir a área de censo entre os pontos mais próximos
                # Para cada parte da interseção, determinar qual ponto está mais próximo
                # Para cada ponto que intersecta, calcular a parte única (sem sobreposição)
                for i, item in enumerate(intersecting_points):
                    point_id = item['point_data']['id']
                    intersection = item['intersection']
                    
                    # Remover partes que já foram atribuídas a outros pontos mais próximos
                    unique_intersection = intersection
                    for other_item in intersecting_points:
                        if other_item['point_data']['id'] != point_id:
                            other_intersection = other_item['intersection']
                            # Verificar se há sobreposição
                            if unique_intersection.intersects(other_intersection):
                                # Determinar qual ponto está mais próximo do centroide da sobreposição
                                overlap = unique_intersection.intersection(other_intersection)
                                if not overlap.is_empty:
                                    overlap_centroid = overlap.centroid
                                    dist_current = item['point_data']['point'].distance(overlap_centroid)
                                    dist_other = other_item['point_data']['point'].distance(overlap_centroid)
                                    
                                    # Se o outro ponto está mais próximo, remover a sobreposição
                                    if dist_other < dist_current:
                                        unique_intersection = unique_intersection.difference(overlap)
                    
                    # Atribuir população da parte única
                    if not unique_intersection.is_empty and unique_intersection.area > 0:
                        area_ratio = unique_intersection.area / row.geometry.area if row.geometry.area > 0 else 1.0
                        pop_value = get_pop_for_row(row) * area_ratio
                        point_populations[point_id]['10min'] += pop_value
        
        # Criar resultados finais
        for point_data in point_info:
            point_id = point_data['id']
            pop_5min = point_populations[point_id]['5min']
            pop_10min = point_populations[point_id]['10min']
            
            total_pop_5min += pop_5min
            total_pop_10min += pop_10min
            
            results.append({
                "id": point_id,
                "lat": point_data['lat'],
                "lng": point_data['lng'],
                "population_5min": round(pop_5min),
                "population_10min": round(pop_10min),
                "population_total": round(pop_5min + pop_10min)
            })

    # Add new urbanization populations — attribute to the nearest station's 5-min catchment
    for urb_feature in new_urbanization_features:
        try:
            urb_pop = urb_feature.get('properties', {}).get('estimated_pop', 0)
            if urb_pop <= 0:
                continue
            urb_geom = shape(urb_feature['geometry'])
            urb_centroid = urb_geom.centroid
            # Find the nearest station
            best_id = None
            best_dist = float('inf')
            for pi in point_info:
                d = pi['point'].distance(
                    gpd.GeoDataFrame([1], geometry=[Point(urb_centroid.x, urb_centroid.y)], crs="EPSG:4326")
                        .to_crs(CENSUS_DATA.crs).geometry.iloc[0]
                ) if CENSUS_DATA.crs != "EPSG:4326" else pi['point'].distance(Point(urb_centroid.x, urb_centroid.y))
                if d < best_dist:
                    best_dist = d
                    best_id = pi['id']
            if best_id is not None:
                # Add to the nearest station result
                for r in results:
                    if r['id'] == best_id:
                        r['population_5min'] += round(urb_pop)
                        r['population_total'] += round(urb_pop)
                        total_pop_5min += urb_pop
                        break
        except Exception as e:
            print(f"Erro ao processar urbanização: {e}")
    
    return jsonify({
        "total_population_5min": round(total_pop_5min),
        "total_population_10min": round(total_pop_10min),
        "total_population": round(total_pop_5min + total_pop_10min),
        "points": results
    })

@app.route('/api/jobs-in-isochrones', methods=['POST'])
def jobs_in_isochrones():
    """Estima empregos e índice de mix de usos (H) por isócrona via dados OSM (Overpass API)."""
    data = request.json
    stations_data = data.get('stations', [])

    if not stations_data:
        return jsonify({'stations': []})

    # ── 1. Build per-station isochrone geometries (WGS84) ──────────────────
    radius_5min_deg  = 417  / 111000   # fallback circle in degrees
    radius_10min_deg = 833  / 111000

    station_geoms = []
    all_geoms = []

    for s in stations_data:
        lat, lng = s['lat'], s['lng']
        isochrones = s.get('isochrones')
        try:
            if isochrones and len(isochrones) >= 1:
                geom_5 = shape(isochrones[0]['geometry'])
            else:
                geom_5 = Point(lng, lat).buffer(radius_5min_deg)
        except Exception:
            geom_5 = Point(lng, lat).buffer(radius_5min_deg)

        station_geoms.append({
            'id':          s['id'],
            'lat':         lat,
            'lng':         lng,
            'geom_5':      geom_5,
            'pop_5min':    s.get('population_5min', 0),
        })
        all_geoms.append(geom_5)

    # ── 2. Bounding box for Overpass query ─────────────────────────────────
    union_all = unary_union(all_geoms)
    minx, miny, maxx, maxy = union_all.bounds   # lon_min, lat_min, lon_max, lat_max
    # Overpass bbox: south,west,north,east
    bbox_str = f"{miny:.6f},{minx:.6f},{maxy:.6f},{maxx:.6f}"

    amenity_rx = (
        "restaurant|cafe|bar|pub|biergarten|fast_food|food_court|nightclub|fuel|car_wash|"
        "bank|post_office|police|fire_station|hospital|clinic|doctors|dentist|pharmacy|"
        "veterinary|school|language_school|kindergarten|university|college|"
        "theatre|arts_centre|cinema|library|museum"
    )
    tourism_rx  = "hotel|hostel|motel|apartment|guest_house"
    leisure_rx  = "sports_centre|fitness_centre|stadium|swimming_pool|golf_course"
    landuse_rx  = "industrial|commercial|retail"

    overpass_query = (
        f'[out:json][timeout:30];\n'
        f'(\n'
        f'  node["shop"]({bbox_str});\n'
        f'  node["amenity"~"{amenity_rx}"]({bbox_str});\n'
        f'  node["office"]({bbox_str});\n'
        f'  node["tourism"~"{tourism_rx}"]({bbox_str});\n'
        f'  node["leisure"~"{leisure_rx}"]({bbox_str});\n'
        f'  way["shop"]({bbox_str});\n'
        f'  way["amenity"~"{amenity_rx}"]({bbox_str});\n'
        f'  way["office"]({bbox_str});\n'
        f'  way["tourism"~"{tourism_rx}"]({bbox_str});\n'
        f'  way["leisure"~"{leisure_rx}"]({bbox_str});\n'
        f'  way["landuse"~"{landuse_rx}"]({bbox_str});\n'
        f');\n'
        f'out body geom;'
    )

    # ── 3. Overpass API call ───────────────────────────────────────────────
    elements = []
    try:
        overpass_url = "https://overpass-api.de/api/interpreter"
        resp = requests.post(overpass_url, data={'data': overpass_query}, timeout=35)
        resp.raise_for_status()
        elements = resp.json().get('elements', [])
        print(f"Overpass returned {len(elements)} elements for bbox {bbox_str}")
    except Exception as e:
        print(f"Overpass API error: {e}")

    # ── 4. Parse elements into POI list ────────────────────────────────────
    pois = []
    for el in elements:
        tags = el.get('tags', {})
        el_type = el.get('type', 'node')

        # Coordinates
        if el_type == 'node':
            lon_el = el.get('lon')
            lat_el = el.get('lat')
        else:
            # way: use centroid of geometry array if present, else skip
            geom_pts = el.get('geometry', [])
            if not geom_pts:
                continue
            lon_el = sum(p['lon'] for p in geom_pts) / len(geom_pts)
            lat_el = sum(p['lat'] for p in geom_pts) / len(geom_pts)

        if lon_el is None or lat_el is None:
            continue

        category, jobs_val = classify_poi_tags(el_type, tags)
        if category is None:
            continue

        # Area-based computation for landuse polygons
        if jobs_val == '__area__':
            geom_pts = el.get('geometry', [])
            if len(geom_pts) >= 3:
                try:
                    coords = [(p['lon'], p['lat']) for p in geom_pts]
                    poly = Polygon(coords)
                    # Approximate area in m² via metric projection
                    gdf_poly = gpd.GeoDataFrame([1], geometry=[poly], crs='EPSG:4326')
                    gdf_metric = gdf_poly.to_crs('EPSG:3857')
                    area_m2 = gdf_metric.geometry.iloc[0].area
                    area_ha = area_m2 / 10000
                    landuse = tags.get('landuse', 'industrial')
                    jpha = JOBS_PER_HA.get(landuse, 20)
                    jobs_val = max(1, round(area_ha * jpha))
                except Exception:
                    jobs_val = 20   # fallback
            else:
                jobs_val = 20

        pois.append({
            'point':    Point(lon_el, lat_el),
            'lon':      lon_el,
            'lat':      lat_el,
            'category': category,
            'jobs':     int(jobs_val),
            'name':     tags.get('name', ''),
        })

    # ── 5. Per-station aggregation ─────────────────────────────────────────
    results = []
    CATEGORIES = ['commerce', 'services', 'education_health', 'culture_leisure', 'industry']

    for sg in station_geoms:
        geom = sg['geom_5']
        station_pois = [p for p in pois if geom.contains(p['point'])]

        breakdown = {c: 0 for c in CATEGORIES}
        for p in station_pois:
            cat = p['category']
            if cat in breakdown:
                breakdown[cat] += p['jobs']

        jobs_total = sum(breakdown.values())
        poi_count  = len(station_pois)
        residents  = sg['pop_5min'] or 0

        h_norm, classification = compute_shannon_h(residents, breakdown)

        # Self-sufficiency index: jobs / active population proxy
        active_pop = residents * 0.45   # ~45% of residents are economically active (Évora 2021)
        self_sufficiency = round(jobs_total / active_pop, 3) if active_pop > 0 else 0.0

        poi_list = [
            {'lat': p['lat'], 'lng': p['lon'], 'category': p['category'],
             'name': p['name'], 'jobs': p['jobs']}
            for p in station_pois
        ]

        results.append({
            'id':                   sg['id'],
            'jobs_total':           jobs_total,
            'jobs_breakdown':       {k: round(v) for k, v in breakdown.items()},
            'shannon_h':            h_norm,
            'tod_classification':   classification,
            'self_sufficiency':     self_sufficiency,
            'poi_count':            poi_count,
            'low_coverage_warning': poi_count < 5,
            'pois':                 poi_list,
        })

    return jsonify({'stations': results})


@app.route('/api/export-points', methods=['POST'])
def export_points():
    """Exporta pontos para CSV"""
    data = request.json
    points = data.get('points', [])
    
    if not points:
        return jsonify({"error": "Nenhum ponto para exportar"}), 400
    
    # Criar CSV em memória
    output = io.StringIO()
    writer = csv.writer(output)
    
    # Cabeçalho
    writer.writerow(['id', 'lat', 'lng', 'group_id', 'group_name', 'population_5min', 'population_10min', 'population_total'])
    
    # Dados
    for point in points:
        writer.writerow([
            point.get('id', ''),
            point.get('lat', ''),
            point.get('lng', ''),
            point.get('group_id', ''),
            point.get('group_name', ''),
            point.get('population_5min', 0),
            point.get('population_10min', 0),
            point.get('population_total', 0)
        ])
    
    # Criar resposta
    output.seek(0)
    response = app.response_class(
        output.getvalue(),
        mimetype='text/csv',
        headers={'Content-Disposition': 'attachment; filename=territorio_evora.csv'}
    )
    
    return response

@app.route('/api/import-points', methods=['POST'])
def import_points():
    """Importa pontos de um arquivo CSV"""
    if 'file' not in request.files:
        return jsonify({"error": "Nenhum arquivo enviado"}), 400
    
    file = request.files['file']
    
    if file.filename == '':
        return jsonify({"error": "Nenhum arquivo selecionado"}), 400
    
    if not file.filename.endswith('.csv'):
        return jsonify({"error": "Arquivo deve ser CSV"}), 400
    
    try:
        # Ler CSV
        stream = io.StringIO(file.stream.read().decode("UTF8"), newline=None)
        csv_reader = csv.DictReader(stream)
        
        points = []
        base_id = int(time.time() * 1000)
        for idx, row in enumerate(csv_reader):
            try:
                point_id = row.get('id', '').strip()
                if point_id and point_id.isdigit():
                    point_id = int(point_id)
                else:
                    point_id = base_id + idx
                
                point = {
                    'id': point_id,
                    'lat': float(row.get('lat', 0)),
                    'lng': float(row.get('lng', 0)),
                    'group_name': row.get('group_name', '').strip() or None
                }
                points.append(point)
            except (ValueError, KeyError) as e:
                print(f"Erro ao processar linha: {row}, erro: {e}")
                continue
        
        if not points:
            return jsonify({"error": "Nenhum ponto válido encontrado no CSV"}), 400
        
        return jsonify({
            "success": True,
            "points": points,
            "count": len(points)
        })
    
    except Exception as e:
        return jsonify({"error": f"Erro ao processar CSV: {str(e)}"}), 500

if __name__ == '__main__':
    print("Carregando dados de censos...")
    load_census_data()
    print("Servidor iniciando em http://localhost:5000")
    app.run(debug=True, port=5000)

