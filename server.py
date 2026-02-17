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
from shapely.geometry import Point, shape
from shapely.ops import unary_union

# Carregar variáveis de ambiente do ficheiro .env
load_dotenv()

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
                pop_value = row[POP_COLUMN] * area_ratio
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
                        pop_value = row[POP_COLUMN] * area_ratio
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
                pop_value = row[POP_COLUMN] * area_ratio
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
                        pop_value = row[POP_COLUMN] * area_ratio
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
    
    return jsonify({
        "total_population_5min": round(total_pop_5min),
        "total_population_10min": round(total_pop_10min),
        "total_population": round(total_pop_5min + total_pop_10min),
        "points": results
    })

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
    writer.writerow(['id', 'lat', 'lng', 'population_5min', 'population_10min', 'population_total'])
    
    # Dados
    for point in points:
        writer.writerow([
            point.get('id', ''),
            point.get('lat', ''),
            point.get('lng', ''),
            point.get('population_5min', 0),
            point.get('population_10min', 0),
            point.get('population_total', 0)
        ])
    
    # Criar resposta
    output.seek(0)
    response = app.response_class(
        output.getvalue(),
        mimetype='text/csv',
        headers={'Content-Disposition': 'attachment; filename=estacoes.csv'}
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
                    'lng': float(row.get('lng', 0))
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

