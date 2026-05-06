"""Smoke tests dos endpoints HTTP (mock onde apropriado para evitar rede)."""
import json


def test_index_serves_html(client):
    res = client.get("/")
    assert res.status_code == 200
    assert b"<html" in res.data.lower() or b"<!doctype" in res.data.lower()


def test_config_endpoint_returns_constants(client, server_module):
    res = client.get("/api/config")
    assert res.status_code == 200
    cfg = res.get_json()
    assert cfg["city_total_jobs"] == server_module.CITY_TOTAL_JOBS
    assert cfg["walking_speed_ms"] == server_module.WALKING_SPEED_MS
    assert cfg["default_ranges_s"] == server_module.DEFAULT_RANGES_S
    assert cfg["uncovered_min_pop"] == server_module.UNCOVERED_MIN_POP


def test_metadata_endpoint(client):
    res = client.get("/api/census-metadata")
    assert res.status_code == 200
    m = res.get_json()
    assert "total_pop" in m
    assert m["total_pop"] > 0


def test_isochrones_missing_coords_returns_400(client):
    res = client.post(
        "/api/isochrones",
        data=json.dumps({"lat": 38.5}),  # sem lng
        content_type="application/json",
    )
    assert res.status_code == 400


def test_isochrones_uses_cache_when_available(client, server_module):
    """Se já houver entrada no cache para `lat,lng|ranges`, devolve from_cache=True
    sem bater no ORS (regra "do not regress" #6: cache só de resultados ORS reais)."""
    # Injectar uma entrada artificial no cache em memória
    fake = [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[0, 0]]]}}]
    key = server_module._isochrone_cache_key(38.99, -7.99, [300, 600])
    server_module._isochrone_cache_set(key, fake)
    try:
        res = client.post(
            "/api/isochrones",
            data=json.dumps({"lat": 38.99, "lng": -7.99, "ranges": [300, 600]}),
            content_type="application/json",
        )
        assert res.status_code == 200
        data = res.get_json()
        assert data.get("from_cache") is True
        assert data["isochrones"] == fake
    finally:
        # Limpar a entrada injectada para não poluir o disco
        with server_module._isochrone_cache_lock:
            server_module.ISOCHRONE_CACHE.pop(key, None)


def test_isochrones_fallback_is_not_cached(client, server_module, mocker):
    """Regra "do not regress": só resultados ORS reais entram no cache em disco.

    Se o ORS falhar (rede/erro/sem chave), o servidor devolve círculos como fallback
    mas **não** os persiste — caso contrário ficariam para sempre como "isócronas reais"
    para aquela localização, mesmo após o ORS voltar a estar disponível.
    """
    # Forçar falha do ORS via mock (None == sem resposta)
    mocker.patch("server._request_with_backoff", return_value=None)
    # Limpar quaisquer entradas existentes para esta coordenada
    coord = (38.111, -7.111)
    key = server_module._isochrone_cache_key(coord[0], coord[1], [300, 600])
    with server_module._isochrone_cache_lock:
        server_module.ISOCHRONE_CACHE.pop(key, None)

    res = client.post(
        "/api/isochrones",
        data=json.dumps({"lat": coord[0], "lng": coord[1], "ranges": [300, 600]}),
        content_type="application/json",
    )
    assert res.status_code == 200
    data = res.get_json()
    # O fallback devolve isócronas mas sem flag from_cache=True
    assert "isochrones" in data
    assert data.get("from_cache") is not True
    # E crucialmente: não pode ter sido inserido no cache
    with server_module._isochrone_cache_lock:
        assert key not in server_module.ISOCHRONE_CACHE


def test_jobs_endpoint_handles_overpass_failure_gracefully(client, mocker):
    """Se o Overpass falhar, o endpoint devolve 200 com 0 empregos (não 500)."""
    mocker.patch("server._request_with_backoff", return_value=None)
    res = client.post(
        "/api/jobs-in-isochrones",
        data=json.dumps({
            "stations": [{
                "id": "s1", "lat": 38.5667, "lng": -7.9075,
                "isochrones": None, "population_5min": 1000,
            }],
        }),
        content_type="application/json",
    )
    assert res.status_code == 200
    data = res.get_json()
    assert len(data["stations"]) == 1
    assert data["stations"][0]["jobs_total"] == 0
    # Sem residentes nem empregos → self-sufficiency = 0; com residentes só → 0
    assert data["stations"][0]["self_sufficiency"] == 0.0


def test_jobs_endpoint_self_sufficiency_one_when_residents_zero(client, mocker, server_module):
    """Regra "do not regress" #9: residents=0 + jobs>0 → self_sufficiency = 1.0."""
    # Mock do Overpass para devolver um POI que cai dentro do fallback circular
    fake_response = mocker.Mock()
    fake_response.status_code = 200
    fake_response.json.return_value = {"elements": [
        {"type": "node", "id": 1, "lat": 38.5667, "lon": -7.9075,
         "tags": {"amenity": "hospital"}},
    ]}
    fake_response.raise_for_status = lambda: None
    mocker.patch("server._request_with_backoff", return_value=fake_response)
    # Garantir que o cache em memória do Overpass não tem entrada para este bbox
    server_module._OVERPASS_CACHE.clear()

    res = client.post(
        "/api/jobs-in-isochrones",
        data=json.dumps({
            "stations": [{
                "id": "s1", "lat": 38.5667, "lng": -7.9075,
                "isochrones": None, "population_5min": 0,
            }],
        }),
        content_type="application/json",
    )
    data = res.get_json()
    s = data["stations"][0]
    assert s["jobs_total"] > 0
    assert s["self_sufficiency"] == 1.0


def test_jobs_endpoint_urbanization_adds_jobs_and_filters_pois(client, mocker, server_module):
    """Uma urbanização que sobrepõe a isócrona (a) descarta POIs do OSM dentro do polígono
    para evitar dupla contagem e (b) adiciona empregos paramétricos prorated pela área
    de interseção, distribuídos pelo mix declarado."""
    # POI na origem da estação — ficará dentro do polígono da urbanização
    fake_response = mocker.Mock()
    fake_response.status_code = 200
    fake_response.json.return_value = {"elements": [
        {"type": "node", "id": 1, "lat": 38.5667, "lon": -7.9075,
         "tags": {"amenity": "hospital"}},  # 200 emp
    ]}
    fake_response.raise_for_status = lambda: None
    mocker.patch("server._request_with_backoff", return_value=fake_response)
    server_module._OVERPASS_CACHE.clear()

    # Polígono ~500m × 500m centrado na estação (cobre toda a isócrona fallback de 5min ~417m)
    d = 0.005  # ~555m em latitude
    poly = [
        [-7.9075 - d, 38.5667 - d],
        [-7.9075 + d, 38.5667 - d],
        [-7.9075 + d, 38.5667 + d],
        [-7.9075 - d, 38.5667 + d],
        [-7.9075 - d, 38.5667 - d],
    ]
    res = client.post(
        "/api/jobs-in-isochrones",
        data=json.dumps({
            "stations": [{
                "id": "s1", "lat": 38.5667, "lng": -7.9075,
                "isochrones": None, "population_5min": 100,
            }],
            "new_urbanizations": [{
                "id": 1, "geometry": {"type": "Polygon", "coordinates": [poly]},
                "jobs_ha": 100, "coverage": 50,
                "mix": {"commerce": 1, "services": 0, "education_health": 0,
                        "culture_leisure": 0, "industry": 0},
            }],
        }),
        content_type="application/json",
    )
    assert res.status_code == 200
    s = res.get_json()["stations"][0]
    # POI do hospital (educ/saúde) foi descartado por estar dentro do polígono
    assert s["jobs_breakdown"]["education_health"] == 0
    assert s["poi_count"] == 0
    # Empregos paramétricos: jobs_ha=100, area~30ha, coverage=0.5 → ~1500 empregos totais
    # da urb; isócrona de 5min cobre apenas uma fração (círculo de ~417m dentro de quadrado
    # de ~555m de meio-lado) → frac < 1 mas significativa.
    assert s["jobs_from_urbanizations"] > 0
    assert s["jobs_from_pois"] == 0
    assert s["jobs_breakdown"]["commerce"] == s["jobs_total"]  # mix 100% comércio


def test_jobs_endpoint_urbanization_outside_isochrone_no_contribution(client, mocker, server_module):
    """Urbanização longe da estação não contribui com empregos (frac=0)."""
    mocker.patch("server._request_with_backoff", return_value=None)  # sem POIs
    server_module._OVERPASS_CACHE.clear()

    # Polígono a ~10km da estação
    d = 0.005
    far_lng, far_lat = -7.80, 38.60
    poly = [
        [far_lng - d, far_lat - d],
        [far_lng + d, far_lat - d],
        [far_lng + d, far_lat + d],
        [far_lng - d, far_lat + d],
        [far_lng - d, far_lat - d],
    ]
    res = client.post(
        "/api/jobs-in-isochrones",
        data=json.dumps({
            "stations": [{
                "id": "s1", "lat": 38.5667, "lng": -7.9075,
                "isochrones": None, "population_5min": 100,
            }],
            "new_urbanizations": [{
                "id": 1, "geometry": {"type": "Polygon", "coordinates": [poly]},
                "jobs_ha": 100, "coverage": 50,
                "mix": {"commerce": 1, "services": 0, "education_health": 0,
                        "culture_leisure": 0, "industry": 0},
            }],
        }),
        content_type="application/json",
    )
    s = res.get_json()["stations"][0]
    assert s["jobs_from_urbanizations"] == 0
    assert s["jobs_total"] == 0


def test_jobs_endpoint_total_jobs_covered_dedup_across_stations(client, mocker, server_module):
    """O total agregado ``total_jobs_covered`` conta cada POI uma só vez mesmo
    quando duas estações vizinhas têm isócronas sobrepostas (a soma per-station
    duplicaria). Este invariante substituiu a dedup por ``osm_id`` no frontend."""
    fake_response = mocker.Mock()
    fake_response.status_code = 200
    # Único POI no ponto comum às duas estações (ambas a ~50m de distância).
    fake_response.json.return_value = {"elements": [
        {"type": "node", "id": 42, "lat": 38.5670, "lon": -7.9075,
         "tags": {"amenity": "restaurant"}},  # commerce/food, 4 emp
    ]}
    fake_response.raise_for_status = lambda: None
    mocker.patch("server._request_with_backoff", return_value=fake_response)
    server_module._OVERPASS_CACHE.clear()

    res = client.post(
        "/api/jobs-in-isochrones",
        data=json.dumps({
            "stations": [
                {"id": "a", "lat": 38.5667, "lng": -7.9075,
                 "isochrones": None, "population_5min": 100},
                {"id": "b", "lat": 38.5673, "lng": -7.9075,
                 "isochrones": None, "population_5min": 100},
            ],
        }),
        content_type="application/json",
    )
    body = res.get_json()
    a, b = body["stations"]
    # Ambas as estações vêem o POI (per-station é correto somar local).
    assert a["jobs_from_pois"] > 0 and b["jobs_from_pois"] > 0
    # O total agregado é a soma deduplicada — igual ao que UMA estação reporta.
    assert body["total_jobs_covered"] == a["jobs_from_pois"]
    # E é estritamente menor que a soma per-station (sem dedup duplicaria).
    assert body["total_jobs_covered"] < a["jobs_from_pois"] + b["jobs_from_pois"]


