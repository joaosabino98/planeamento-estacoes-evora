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
import zipfile
from dotenv import load_dotenv
import math
from shapely.geometry import Point, Polygon, shape
from shapely.ops import unary_union

# Carregar variáveis de ambiente do ficheiro .env
load_dotenv()

# Lógica pura extraída para o pacote ``server_lib`` (re-exportada aqui para
# preservar as importações ``from server import ...`` usadas pelos testes).
from server_lib.jobs_taxonomy import JOBS_PER_HA, classify_poi_tags  # noqa: F401,E402
from server_lib.shannon import compute_shannon_h  # noqa: F401,E402
from server_lib.population import (  # noqa: F401,E402
    WALK_SPEED_M_PER_MIN,
    AUGMENT_METRIC_CRS,
    _fill_polygon_for_station,
    _augment_buffers_with_urbanizations,
    _assign_population_voronoi,
    compute_population_response,
)


app = Flask(__name__, static_folder='static', static_url_path='/static')

# CORS: por defeito permitir qualquer origem; em produção restringir via env CORS_ORIGINS="https://a.com,https://b.com"
_cors_origins = os.getenv('CORS_ORIGINS', '*').strip()
if _cors_origins == '*':
    CORS(app)
else:
    CORS(app, origins=[o.strip() for o in _cors_origins.split(',') if o.strip()])

# Limite de tamanho dos uploads (GTFS pode ser grande — default 50 MB)
app.config['MAX_CONTENT_LENGTH'] = int(os.getenv('MAX_UPLOAD_MB', '50')) * 1024 * 1024

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

# ==================== Constantes Globais (cidade) ====================
CITY_TOTAL_JOBS = int(os.getenv('CITY_TOTAL_JOBS', '23674'))   # SCIE Évora 2021
WALKING_SPEED_MS = 1.39                                          # ~5 km/h
DEFAULT_RANGES_S = [300, 600]                                    # 5 min, 10 min

# ==================== Constantes geométricas / fallback ====================
# Raios usados quando uma estação ainda não tem isócrona ORS (fallback circular).
# Valores fixos (não derivados) para preservar comportamento exato do código original
# antes da refatorização: WALKING_SPEED_MS × DEFAULT_RANGES_S daria 417 / 834 m.
RADIUS_5MIN_M = 417
RADIUS_10MIN_M = 833
# Conversão aproximada metros → graus de latitude (1° lat ≈ 111 km)
METERS_PER_DEGREE = 111000
# Proxy de população ativa (Évora 2021): ≈ 45 % dos residentes
ACTIVE_POPULATION_RATIO = 0.45
# BGRIs com população < UNCOVERED_MIN_POP não entram na lista de não cobertas
UNCOVERED_MIN_POP = 50

# ==================== Overpass Cache (in-memory) ====================
# Cache curto (bbox arredondado) para evitar bater repetidamente no Overpass
# durante recalculations sucessivos.
_OVERPASS_CACHE = {}
_OVERPASS_TTL = float(os.getenv('OVERPASS_TTL_S', '600'))   # 10 min

# ==================== Isochrone Disk Cache ====================
# Only real ORS results are cached — fallback circles are never persisted.
ISOCHRONE_CACHE_FILE = "data/isochrone_cache.json"
ISOCHRONE_CACHE = {}                # OrderedDict-like com política LRU simples
ISOCHRONE_CACHE_MAX = int(os.getenv('ISOCHRONE_CACHE_MAX', '5000'))
_isochrone_cache_lock = __import__('threading').Lock()
_isochrone_cache_dirty = False       # flag para gravação debounced
_isochrone_cache_last_save = 0.0


def _isochrone_cache_key(lat, lng, ranges=None):
    """Stable key rounded to ~1 m precision; inclui ranges para evitar colisões."""
    rng = ','.join(str(int(r)) for r in (ranges or DEFAULT_RANGES_S))
    return f"{round(float(lat), 5)},{round(float(lng), 5)}|{rng}"


def _request_with_backoff(
    url,
    *,
    method='post',
    json=None,
    data=None,
    headers=None,
    timeout=15,
    attempts=3,
    retry_status=(429, 500, 502, 503, 504),
    backoff_base=0.6,
    label=None,
):
    """HTTP request com retry exponencial em rate-limit (429) e 5xx.

    Devolve a última ``Response`` (que pode ser não-OK se todos os retries falharem)
    ou levanta a excepção do `requests` no caso de falha de rede.
    """
    response = None
    tag = label or url.split('/')[2] if '://' in url else (label or url)
    for attempt in range(attempts):
        response = requests.request(
            method, url,
            json=json, data=data, headers=headers, timeout=timeout,
        )
        if response.status_code in retry_status:
            wait = backoff_base * (2 ** attempt)
            print(f"{tag} {response.status_code}, retry em {wait:.1f}s")
            time.sleep(wait)
            continue
        break
    return response


def load_isochrone_cache():
    """Read the isochrone cache from disk on startup."""
    global ISOCHRONE_CACHE
    if os.path.exists(ISOCHRONE_CACHE_FILE):
        try:
            with open(ISOCHRONE_CACHE_FILE, 'r', encoding='utf-8') as f:
                ISOCHRONE_CACHE = json.load(f)
            print(f"Cache de isócronas carregado: {len(ISOCHRONE_CACHE)} entrada(s)")
        except Exception as e:
            print(f"Aviso: não foi possível ler o cache de isócronas: {e}")
            ISOCHRONE_CACHE = {}
    else:
        ISOCHRONE_CACHE = {}
        print("Cache de isócronas: nenhum ficheiro existente, a começar vazio.")


def _save_isochrone_cache(force=False):
    """Atomically persist the in-memory cache to disk.

    Por defeito, gravações são debounced (mínimo 5 s entre flushes) para reduzir I/O
    quando várias isócronas são calculadas em sequência. ``force=True`` grava imediatamente.
    """
    import tempfile
    global _isochrone_cache_dirty, _isochrone_cache_last_save
    now = time.time()
    with _isochrone_cache_lock:
        _isochrone_cache_dirty = True
        if not force and (now - _isochrone_cache_last_save) < 5.0:
            return
        snapshot = dict(ISOCHRONE_CACHE)
        _isochrone_cache_last_save = now
        _isochrone_cache_dirty = False
    os.makedirs('data', exist_ok=True)
    try:
        fd, tmp_path = tempfile.mkstemp(dir='data', suffix='.json.tmp')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(snapshot, f)
        os.replace(tmp_path, ISOCHRONE_CACHE_FILE)
    except Exception as e:
        print(f"Aviso: falha ao gravar cache de isócronas: {e}")


def _isochrone_cache_set(key, value):
    """Insere no cache aplicando política LRU simples (FIFO eviction)."""
    with _isochrone_cache_lock:
        if key in ISOCHRONE_CACHE:
            ISOCHRONE_CACHE.pop(key)
        ISOCHRONE_CACHE[key] = value
        # Eviction quando excede o limite (Python 3.7+ dicts são ordered)
        while len(ISOCHRONE_CACHE) > ISOCHRONE_CACHE_MAX:
            try:
                ISOCHRONE_CACHE.pop(next(iter(ISOCHRONE_CACHE)))
            except StopIteration:
                break


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
        if METADATA is None:
            METADATA = {}
        METADATA['total_pop'] = int(total_pop)

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
    """Calcula isócronas reais usando OpenRouteService, com cache em disco."""
    data = request.json
    lat = data.get('lat')
    lng = data.get('lng')
    ranges = data.get('ranges', [300, 600])  # 5 min e 10 min em segundos

    if lat is None or lng is None:
        return jsonify({"error": "Coordenadas não fornecidas"}), 400

    cache_key = _isochrone_cache_key(lat, lng, ranges)

    # Cache hit — devolve sem consumir quota ORS
    with _isochrone_cache_lock:
        if cache_key in ISOCHRONE_CACHE:
            return jsonify({"isochrones": ISOCHRONE_CACHE[cache_key], "from_cache": True})

    try:
        url = "https://api.openrouteservice.org/v2/isochrones/foot-walking"
        headers = {
            "Accept": "application/json, application/geo+json",
            "Content-Type": "application/json"
        }
        if ORS_API_KEY:
            headers["Authorization"] = f"Bearer {ORS_API_KEY}"

        body = {
            "locations": [[lng, lat]],  # OpenRouteService usa [lng, lat]
            "range": ranges,            # em segundos
            "range_type": "time"
        }

        # Pequeno retry com backoff para 429/5xx
        response = _request_with_backoff(
            url, method='post', json=body, headers=headers, timeout=15, label='ORS',
        )

        if response is not None and response.status_code == 200:
            result = response.json()
            isochrones = list(result.get('features', []))

            if isochrones:
                # Cache miss com sucesso ORS — persiste em disco (debounced)
                _isochrone_cache_set(cache_key, isochrones)
                _save_isochrone_cache()
                return jsonify({"isochrones": isochrones})

        # API falhou ou não devolveu geometrias — fallback NÃO é guardado em cache
        status = response.status_code if response is not None else 'sem resposta'
        print(f"OpenRouteService retornou status {status}, usando fallback")
        return create_fallback_isochrones(lat, lng, ranges)

    except requests.exceptions.RequestException as e:
        print(f"Erro de conexão com OpenRouteService: {e}")
        return create_fallback_isochrones(lat, lng, ranges)
    except Exception as e:
        print(f"Erro ao obter isócronas: {e}")
        return create_fallback_isochrones(lat, lng, ranges)

def create_fallback_isochrones(lat, lng, ranges):
    """Cria isócronas usando círculos como fallback"""
    isochrones = []
    for range_seconds in ranges:
        # Calcular raio em metros e converter para graus (1° lat ≈ 111 km)
        radius_m = range_seconds * WALKING_SPEED_MS
        radius_deg = radius_m / METERS_PER_DEGREE

        center = [lng, lat]
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


# WALK_SPEED_M_PER_MIN, AUGMENT_METRIC_CRS, _fill_polygon_for_station,
# _augment_buffers_with_urbanizations e _assign_population_voronoi vivem em
# ``server_lib.population`` e são re-exportados no topo deste módulo.


@app.route('/api/population-in-isochrones', methods=['POST'])
def calculate_population():
    """Calcula população dentro de isócronas, evitando duplicações em sobreposições"""
    global CENSUS_DATA, POP_COLUMN

    if CENSUS_DATA is None:
        load_census_data()
    if CENSUS_DATA is None:
        return jsonify({"error": "Dados não carregados"}), 500

    data = request.json or {}

    try:
        uncovered_limit = int(request.args.get('uncovered_limit', '30'))
    except (TypeError, ValueError):
        uncovered_limit = 30
    uncovered_limit = max(1, min(uncovered_limit, 500))

    response = compute_population_response(
        data,
        census_data=CENSUS_DATA,
        pop_column=POP_COLUMN,
        radius_5min_m=RADIUS_5MIN_M,
        radius_10min_m=RADIUS_10MIN_M,
        uncovered_min_pop=UNCOVERED_MIN_POP,
        uncovered_limit=uncovered_limit,
    )
    return jsonify(response)


@app.route('/api/jobs-in-isochrones', methods=['POST'])
def jobs_in_isochrones():
    """Estima empregos e índice de mix de usos (H) por isócrona via dados OSM (Overpass API).

    Aceita opcionalmente ``new_urbanizations``: cada urbanização contribui com
    empregos paramétricos (``jobs_ha × area_ha × coverage``) distribuídos pelo
    ``mix`` (proporção das 5 categorias). Para evitar dupla contagem, os POIs
    do OSM que caem dentro do polígono de qualquer urbanização são descartados;
    a contribuição da urbanização para uma estação é proporcional à fração
    da urbanização coberta pela isócrona de 5 min dessa estação.
    """
    data = request.json
    stations_data = data.get('stations', [])
    new_urbanizations = data.get('new_urbanizations', []) or []

    if not stations_data:
        return jsonify({'stations': []})

    # ── 1. Build per-station isochrone geometries (WGS84) ──────────────────
    radius_5min_deg  = RADIUS_5MIN_M  / METERS_PER_DEGREE   # fallback circle in degrees
    radius_10min_deg = RADIUS_10MIN_M / METERS_PER_DEGREE

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

    # ── 3. Overpass API call (com cache em memória por bbox arredondado) ──
    elements = []
    bbox_round = (round(miny, 3), round(minx, 3), round(maxy, 3), round(maxx, 3))
    cache_entry = _OVERPASS_CACHE.get(bbox_round)
    now_ts = time.time()
    if cache_entry and (now_ts - cache_entry['t']) < _OVERPASS_TTL:
        elements = cache_entry['elements']
        print(f"Overpass cache hit ({len(elements)} elementos) para bbox {bbox_round}")
    else:
        try:
            overpass_url = "https://overpass-api.de/api/interpreter"
            overpass_headers = {
                # Overpass devolve 406 sem User-Agent identificável
                'User-Agent': 'planeamento-estacoes-evora/1.0 (https://github.com/; contacto via repositório)',
                'Accept': 'application/json',
            }
            resp = _request_with_backoff(
                overpass_url,
                method='post',
                data={'data': overpass_query},
                headers=overpass_headers,
                timeout=35,
                retry_status=(429, 502, 503, 504),
                backoff_base=0.8,
                label='Overpass',
            )
            if resp is not None:
                resp.raise_for_status()
                elements = resp.json().get('elements', [])
                print(f"Overpass devolveu {len(elements)} elementos para bbox {bbox_str}")
                _OVERPASS_CACHE[bbox_round] = {'t': now_ts, 'elements': elements}
                if len(_OVERPASS_CACHE) > 64:
                    _OVERPASS_CACHE.pop(next(iter(_OVERPASS_CACHE)))
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
            'osm_id':   f"{el_type}_{el.get('id', '')}",
        })

    # ── 5. Per-station aggregation ─────────────────────────────────────────
    results = []
    CATEGORIES = ['commerce', 'services', 'education_health', 'culture_leisure', 'industry']

    # ── 5a. Pré-processamento das urbanizações ────────────────────────────
    # ``urb_filter_polys_wgs`` agrega todos os polígonos válidos (WGS84) e é
    # usado apenas para descartar POIs OSM dentro deles (evita dupla contagem
    # com a estimativa paramétrica). ``urb_contributors`` guarda apenas as
    # urbanizações que de facto contribuem com empregos (``jobs_ha>0`` e
    # ``coverage>0``), já em CRS métrico, com ``total_jobs`` e ``mix``
    # normalizado.
    urb_filter_polys_wgs = []
    urb_contributors = []
    if new_urbanizations:
        contrib_wgs_list = []
        contrib_meta = []
        for u in new_urbanizations:
            try:
                g = shape(u.get('geometry'))
                if g.is_empty or g.area <= 0:
                    continue
            except Exception:
                continue
            urb_filter_polys_wgs.append(g)
            jobs_ha = float(u.get('jobs_ha') or 0)
            coverage = float(u.get('coverage') or 0) / 100.0
            if jobs_ha <= 0 or coverage <= 0:
                continue  # filtra POIs mas não contribui com empregos
            mix_raw = u.get('mix') or {}
            mix = {c: max(0.0, float(mix_raw.get(c, 0))) for c in CATEGORIES}
            s_mix = sum(mix.values())
            if s_mix > 0:
                mix = {c: mix[c] / s_mix for c in CATEGORIES}
            else:
                mix = {c: 1.0 / len(CATEGORIES) for c in CATEGORIES}
            contrib_wgs_list.append(g)
            contrib_meta.append({'jobs_ha': jobs_ha, 'coverage': coverage, 'mix': mix})

        if contrib_wgs_list:
            try:
                metric_geoms = list(
                    gpd.GeoDataFrame(geometry=contrib_wgs_list, crs="EPSG:4326")
                       .to_crs(AUGMENT_METRIC_CRS).geometry
                )
                for g_m, meta in zip(metric_geoms, contrib_meta):
                    area_m2 = g_m.area
                    if area_m2 <= 0:
                        continue
                    area_ha = area_m2 / 10000.0
                    urb_contributors.append({
                        'geom_metric': g_m,
                        'area_m2':     area_m2,
                        'total_jobs':  meta['jobs_ha'] * area_ha * meta['coverage'],
                        'mix':         meta['mix'],
                    })
            except Exception as e:
                print(f"Aviso: falha no pré-processamento de urbanizações para empregos: {e}")
                urb_contributors = []

    urb_union_wgs = unary_union(urb_filter_polys_wgs) if urb_filter_polys_wgs else None

    # Pré-projeção das isócronas para CRS métrico (só necessária se houver urbs
    # contribuintes — partilhada entre o loop por estação e a totalização global).
    station_geom5_metric = []
    if urb_contributors:
        try:
            station_geom5_metric = list(
                gpd.GeoDataFrame(geometry=[sg['geom_5'] for sg in station_geoms], crs="EPSG:4326")
                   .to_crs(AUGMENT_METRIC_CRS).geometry
            )
        except Exception as e:
            print(f"Aviso: falha na projeção das isócronas para CRS métrico: {e}")
            station_geom5_metric = []

    for sg_idx, sg in enumerate(station_geoms):
        geom = sg['geom_5']
        # Descartar POIs dentro de qualquer urbanização (evita dupla contagem
        # com a estimativa paramétrica baseada em jobs_ha).
        if urb_union_wgs is not None:
            station_pois = [p for p in pois
                            if geom.contains(p['point']) and not urb_union_wgs.contains(p['point'])]
        else:
            station_pois = [p for p in pois if geom.contains(p['point'])]

        breakdown = {c: 0.0 for c in CATEGORIES}
        for p in station_pois:
            cat = p['category']
            if cat in breakdown:
                breakdown[cat] += p['jobs']

        jobs_from_pois = sum(breakdown.values())

        # Contribuição das urbanizações: prorated pela fração da urb dentro da isócrona 5min.
        jobs_from_urb = 0.0
        if urb_contributors and station_geom5_metric:
            geom_m = station_geom5_metric[sg_idx]
            for r in urb_contributors:
                try:
                    inter = geom_m.intersection(r['geom_metric'])
                    if inter.is_empty:
                        continue
                    frac = inter.area / r['area_m2']
                    if frac <= 0:
                        continue
                    add = r['total_jobs'] * frac
                    jobs_from_urb += add
                    for c in CATEGORIES:
                        breakdown[c] += add * r['mix'][c]
                except Exception:
                    continue

        jobs_total = sum(breakdown.values())
        poi_count  = len(station_pois)
        residents  = sg['pop_5min'] or 0

        h_norm, classification = compute_shannon_h(residents, breakdown)

        # Self-sufficiency index: jobs / active population proxy
        active_pop = residents * ACTIVE_POPULATION_RATIO
        if active_pop > 0:
            self_sufficiency = round(jobs_total / active_pop, 3)
        elif jobs_total > 0:
            self_sufficiency = 1.0  # sem residentes mas com emprego → auto-suficiência máxima
        else:
            self_sufficiency = 0.0

        poi_list = [
            {'lat': p['lat'], 'lng': p['lon'], 'category': p['category'],
             'name': p['name'], 'jobs': p['jobs'], 'osm_id': p['osm_id']}
            for p in station_pois
        ]

        results.append({
            'id':                   sg['id'],
            'jobs_total':           round(jobs_total),
            'jobs_breakdown':       {k: round(v) for k, v in breakdown.items()},
            'jobs_from_pois':       round(jobs_from_pois),
            'jobs_from_urbanizations': round(jobs_from_urb),
            'shannon_h':            h_norm,
            'tod_classification':   classification,
            'self_sufficiency':     self_sufficiency,
            'poi_count':            poi_count,
            'low_coverage_warning': poi_count < 5,
            'pois':                 poi_list,
        })

    # ── 6. Total agregado de empregos cobertos pela rede ──────────────────
    # Soma única e deduplicada: cada POI conta uma vez (filtrado pela união
    # das isócronas 5 min, e descartado se cair dentro de qualquer urbanização);
    # cada urbanização contribui prorated pela fração coberta pela mesma união.
    # Permite ao frontend mostrar o total directamente, sem dedup local.
    total_jobs_covered = 0.0
    if station_geoms:
        try:
            stations_union_wgs = unary_union([sg['geom_5'] for sg in station_geoms])
            for p in pois:
                if not stations_union_wgs.contains(p['point']):
                    continue
                if urb_union_wgs is not None and urb_union_wgs.contains(p['point']):
                    continue
                total_jobs_covered += p['jobs']
            if urb_contributors and station_geom5_metric:
                stations_union_metric = unary_union(station_geom5_metric)
                for r in urb_contributors:
                    inter = stations_union_metric.intersection(r['geom_metric'])
                    if inter.is_empty:
                        continue
                    frac = inter.area / r['area_m2']
                    if frac > 0:
                        total_jobs_covered += r['total_jobs'] * frac
        except Exception as e:
            print(f"Aviso: falha no cálculo do total de empregos cobertos: {e}")

    return jsonify({
        'stations': results,
        'total_jobs_covered': round(total_jobs_covered),
    })


@app.route('/api/import-gtfs', methods=['POST'])
def import_gtfs():
    """Parse GTFS ZIP and return grouped stops by dominant route, filtered to Évora bbox."""
    file = request.files.get('file')
    if not file:
        return jsonify({"error": "Nenhum ficheiro enviado"}), 400

    # Bounding box for Évora municipality
    LAT_MIN, LAT_MAX = 38.4, 38.7
    LON_MIN, LON_MAX = -8.1, -7.6

    try:
        content = file.read()
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            names = zf.namelist()

            def read_gtfs_csv(fname):
                for n in names:
                    if n.endswith(fname):
                        with zf.open(n) as f:
                            text = f.read().decode('utf-8-sig')
                        return list(csv.DictReader(io.StringIO(text)))
                return []

            routes_rows    = read_gtfs_csv('routes.txt')
            trips_rows     = read_gtfs_csv('trips.txt')
            stoptimes_rows = read_gtfs_csv('stop_times.txt')
            stops_rows     = read_gtfs_csv('stops.txt')

        if not (routes_rows and trips_rows and stoptimes_rows and stops_rows):
            return jsonify({"error": "Ficheiro GTFS incompleto — routes/trips/stop_times/stops em falta"}), 400

        # Build route_id → {name, color}
        route_info = {}
        for r in routes_rows:
            rid = r.get('route_id', '').strip()
            if not rid:
                continue
            name = (r.get('route_short_name') or r.get('route_long_name') or rid).strip()
            raw_color = r.get('route_color', '').strip()
            color = '#' + raw_color if raw_color and len(raw_color) == 6 else None
            route_info[rid] = {'name': name, 'color': color}

        # Map trip_id → route_id
        trip_to_route = {}
        for t in trips_rows:
            tid = t.get('trip_id', '').strip()
            rid = t.get('route_id', '').strip()
            if tid and rid:
                trip_to_route[tid] = rid

        # Count trips per (stop_id, route_id) — cap rows to avoid memory issues
        stop_route_counts = {}
        MAX_ROWS = 500_000
        for i, st in enumerate(stoptimes_rows):
            if i >= MAX_ROWS:
                break
            sid = st.get('stop_id', '').strip()
            tid = st.get('trip_id', '').strip()
            rid = trip_to_route.get(tid)
            if not sid or not rid:
                continue
            if sid not in stop_route_counts:
                stop_route_counts[sid] = {}
            stop_route_counts[sid][rid] = stop_route_counts[sid].get(rid, 0) + 1

        # Primary route per stop = route with most trips through it
        stop_primary_route = {
            sid: max(counts, key=counts.get)
            for sid, counts in stop_route_counts.items()
        }

        # Build stop_id → {name, lat, lon}
        stops_dict = {}
        for s in stops_rows:
            sid = s.get('stop_id', '').strip()
            try:
                lat = float(s.get('stop_lat', 0))
                lon = float(s.get('stop_lon', 0))
            except (ValueError, TypeError):
                continue
            stops_dict[sid] = {
                'name': (s.get('stop_name') or sid).strip(),
                'lat': lat, 'lon': lon
            }

        # Group stops by primary route, applying bbox filter
        route_stops = {}
        skipped = 0
        for sid, rid in stop_primary_route.items():
            if sid not in stops_dict:
                skipped += 1
                continue
            s = stops_dict[sid]
            if not (LAT_MIN <= s['lat'] <= LAT_MAX and LON_MIN <= s['lon'] <= LON_MAX):
                skipped += 1
                continue
            if rid not in route_stops:
                route_stops[rid] = []
            route_stops[rid].append({
                'stop_id': sid,
                'name':    s['name'],
                'lat':     s['lat'],
                'lng':     s['lon']
            })

        # Build response
        result_routes = []
        for rid, stop_list in route_stops.items():
            info = route_info.get(rid, {'name': rid, 'color': None})
            result_routes.append({
                'route_id': rid,
                'name':     info['name'],
                'color':    info['color'],
                'stops':    stop_list
            })
        result_routes.sort(key=lambda r: r['name'])

        total_stops = sum(len(r['stops']) for r in result_routes)
        return jsonify({
            'routes':       result_routes,
            'total_routes': len(result_routes),
            'total_stops':  total_stops,
            'skipped_stops': skipped
        })

    except zipfile.BadZipFile:
        return jsonify({"error": "Ficheiro inválido — não é um ZIP GTFS válido"}), 400
    except Exception as e:
        return jsonify({"error": f"Erro ao processar GTFS: {str(e)}"}), 500


@app.route('/api/config')
def get_config():
    """Configuração partilhada entre servidor e cliente (constantes da cidade)."""
    return jsonify({
        'city_total_jobs': CITY_TOTAL_JOBS,
        'walking_speed_ms': WALKING_SPEED_MS,
        'default_ranges_s': DEFAULT_RANGES_S,
        'uncovered_min_pop': UNCOVERED_MIN_POP,
    })


if __name__ == '__main__':
    print("Carregando dados de censos...")
    load_census_data()
    load_isochrone_cache()
    debug_mode = os.getenv('FLASK_DEBUG', '0') == '1'
    port = int(os.getenv('PORT', '5000'))
    print(f"Servidor iniciando em http://localhost:{port} (debug={debug_mode})")
    app.run(debug=debug_mode, port=port)

