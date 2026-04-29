"""Testes da rota `/api/population-in-isochrones`.

Estes testes batem com os dados reais de censos (BGRI 2021) e cobrem
as regras "do not regress" mais críticas:
  - união (não soma) por grupo
  - subtração de urbanizações antes de atribuir população
  - density_overrides substitui N_INDIVIDUOS
  - uncovered_bgris devolvido sempre
  - per-station population != total quando há sobreposição
"""
import json


def _post(client, payload):
    res = client.post(
        "/api/population-in-isochrones",
        data=json.dumps(payload),
        content_type="application/json",
    )
    assert res.status_code == 200, res.data
    return res.get_json()


def test_empty_points_returns_zero(client):
    data = _post(client, {"points": []})
    assert data["total_population"] == 0
    assert data["points"] == []
    assert data["groups"] == []


def test_single_point_evora_center_snapshot(client, evora_center_point):
    """Smoke-test do caso real validado manualmente: Praça do Giraldo, fallback circular.

    Os valores podem variar marginalmente com a versão do GEOS — usamos
    bandas largas e não igualdade exata.
    """
    data = _post(client, {"points": [evora_center_point]})
    # Centro de Évora deve cobrir milhares de habitantes em 5+10 min
    assert 1000 < data["total_population"] < 10000
    # Per-station total = 5min + 10min para um único ponto
    p = data["points"][0]
    assert p["population_total"] == p["population_5min"] + p["population_10min"]
    # Globals devolvem groups[] com o group_id passado
    assert any(g["id"] == "g1" for g in data["groups"])


def test_uncovered_bgris_always_returned(client, evora_center_point):
    """Regra "do not regress" #9: `uncovered_bgris` está sempre presente."""
    data = _post(client, {"points": [evora_center_point]})
    assert "uncovered_bgris" in data
    assert "uncovered_total_count" in data
    # Évora tem zonas rurais sem cobertura → deve haver não cobertas
    assert data["uncovered_total_count"] > 0
    # Default limit é 30
    assert len(data["uncovered_bgris"]) <= 30
    # Cada item tem população >= 50 (UNCOVERED_MIN_POP)
    for b in data["uncovered_bgris"]:
        assert b["population"] >= 50
        assert "lat" in b and "lng" in b


def test_uncovered_limit_querystring_capped(client, evora_center_point):
    res = client.post(
        "/api/population-in-isochrones?uncovered_limit=5",
        data=json.dumps({"points": [evora_center_point]}),
        content_type="application/json",
    )
    data = res.get_json()
    assert len(data["uncovered_bgris"]) <= 5


def test_group_total_equals_global_for_single_group(client, evora_center_point):
    """Regra "do not regress" #8: com um único grupo, totals do grupo == global."""
    data = _post(client, {"points": [evora_center_point]})
    g1 = next(g for g in data["groups"] if g["id"] == "g1")
    assert g1["total_population_5min"] == data["total_population_5min"]
    assert g1["total_population_10min"] == data["total_population_10min"]
    assert g1["total_population"] == data["total_population"]


def test_group_totals_use_union_not_sum_per_station(client):
    """Duas estações próximas no mesmo grupo: união < soma das estações.

    Esta era a regressão concreta que motivou a fix dos `groups[]` em v2.0.3.
    """
    payload = {
        "points": [
            {"id": 1, "lat": 38.5667, "lng": -7.9075, "group_id": "linha_a"},
            {"id": 2, "lat": 38.5680, "lng": -7.9080, "group_id": "linha_a"},  # ~150 m
        ]
    }
    data = _post(client, payload)
    g = next(g for g in data["groups"] if g["id"] == "linha_a")
    # Soma ingénua das population por estação: tem de ser >= ao total por união
    naive_sum = sum(p["population_5min"] + p["population_10min"] for p in data["points"])
    union_total = g["total_population"]
    # Por união nunca pode ser maior que a soma ingénua
    assert union_total <= naive_sum
    # E como há sobreposição de isócronas, deve ser estritamente menor
    assert union_total < naive_sum


def test_density_override_replaces_population(client, server_module):
    """`density_overrides[bgri]` substitui N_INDIVIDUOS para esse BGRI."""
    # Encontrar um BGRI real próximo do centro (qualquer um com população)
    pop_col = server_module.POP_COLUMN
    sample = server_module.CENSUS_DATA[server_module.CENSUS_DATA[pop_col] > 100].iloc[0]
    bgri_id = str(sample.get("BGRI2021", sample.get("SUBSECCAO", sample.get("OBJECTID", ""))))
    centroid = sample.geometry.centroid
    # Forçar reproject se necessário
    lat_lng = (centroid.y, centroid.x)

    base = _post(client, {"points": [{"id": 1, "lat": lat_lng[0], "lng": lat_lng[1], "group_id": "g"}]})
    overridden = _post(client, {
        "points": [{"id": 1, "lat": lat_lng[0], "lng": lat_lng[1], "group_id": "g"}],
        "density_overrides": {bgri_id: {"populationOverride": 99999}},
    })
    # Override muito acima do real → total tem de subir
    assert overridden["total_population"] > base["total_population"]


def test_urbanization_adds_population_to_5min(client):
    """Urbanização nova com `estimated_pop` é atribuída à estação mais próxima
    e entra no totals_5min global (regra "do not regress" #2 + #8)."""
    point = {"id": 1, "lat": 38.5667, "lng": -7.9075, "group_id": "g1"}
    base = _post(client, {"points": [point]})

    # Polígono pequeno (~50 m de lado) ao lado do centro
    urb = {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-7.9080, 38.5670],
                [-7.9075, 38.5670],
                [-7.9075, 38.5675],
                [-7.9080, 38.5675],
                [-7.9080, 38.5670],
            ]],
        },
        "properties": {"estimated_pop": 5000, "name": "test_urb"},
    }
    with_urb = _post(client, {
        "points": [point],
        "new_urbanization_features": [urb],
    })
    delta = with_urb["total_population_5min"] - base["total_population_5min"]
    # Pelo menos a maior parte dos 5000 hab atribuídos têm de aparecer
    assert delta >= 4000
    # E o cartão do grupo também tem de subir consistentemente
    g_base = next(g for g in base["groups"] if g["id"] == "g1")
    g_urb  = next(g for g in with_urb["groups"] if g["id"] == "g1")
    assert g_urb["total_population_5min"] >= g_base["total_population_5min"] + 4000


def test_per_station_5min_voronoi_distributed_not_collapsed(client):
    """Regressão: no ramo de sobreposição múltipla do anel de 5 min, o
    código antigo usava `point_data` poluído pelo loop exterior — toda a
    população da BGRI partilhada por 2+ estações ia para a *última* estação
    do `point_info`. Agora cada estação fica com a sua fatia Voronoi.

    Configuração: 3 estações próximas (~150 m entre si) no centro de Évora.
    Espera-se que `population_5min` seja repartido entre todas, não que
    fique concentrado numa só.
    """
    payload = {
        "points": [
            {"id": 1, "lat": 38.5667, "lng": -7.9075, "group_id": "g"},
            {"id": 2, "lat": 38.5680, "lng": -7.9080, "group_id": "g"},
            {"id": 3, "lat": 38.5660, "lng": -7.9060, "group_id": "g"},
        ]
    }
    data = _post(client, payload)
    pops = {p["id"]: p["population_5min"] for p in data["points"]}
    # Todas as 3 têm de receber população em 5 min (estão num miolo denso)
    assert all(v > 0 for v in pops.values()), pops
    # Nenhuma deve concentrar > 80% do total das três (sinal do bug antigo)
    total5 = sum(pops.values())
    assert total5 > 0
    assert max(pops.values()) / total5 < 0.8, pops
