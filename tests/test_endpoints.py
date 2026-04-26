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
