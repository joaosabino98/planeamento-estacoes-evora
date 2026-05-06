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
import time
from dotenv import load_dotenv
import math
from shapely.geometry import Polygon

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
from server_lib.jobs import compute_jobs_response  # noqa: E402
from server_lib.gtfs import parse_gtfs_zip  # noqa: E402


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
    """Estima empregos e índice de mix de usos (H) por isócrona via dados OSM (Overpass API)."""
    response = compute_jobs_response(
        request.json or {},
        request_with_backoff=_request_with_backoff,
        overpass_cache=_OVERPASS_CACHE,
        overpass_ttl_s=_OVERPASS_TTL,
        radius_5min_m=RADIUS_5MIN_M,
        meters_per_degree=METERS_PER_DEGREE,
        active_population_ratio=ACTIVE_POPULATION_RATIO,
    )
    return jsonify(response)


@app.route('/api/import-gtfs', methods=['POST'])
def import_gtfs():
    """Parse GTFS ZIP and return grouped stops by dominant route, filtered to Évora bbox."""
    file = request.files.get('file')
    if not file:
        return jsonify({"error": "Nenhum ficheiro enviado"}), 400
    payload, status = parse_gtfs_zip(file.read())
    return jsonify(payload), status


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

