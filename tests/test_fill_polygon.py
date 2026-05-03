"""Testes unitários da heurística "preenche o polígono".

A função `_fill_polygon_for_station` é pura: dado um ponto-estação, um
buffer (isócrona ORS, em CRS métrico) e um polígono de urbanização, devolve
a porção do polígono que fica alcançável dentro do orçamento de tempo
assumindo malha viária interna contínua.

Estes testes não tocam o ORS nem os censos.
"""
from shapely.geometry import Point, Polygon

from server import _fill_polygon_for_station, WALK_SPEED_M_PER_MIN


def _square(cx, cy, half):
    return Polygon([
        (cx - half, cy - half),
        (cx + half, cy - half),
        (cx + half, cy + half),
        (cx - half, cy + half),
    ])


def test_urb_not_touched_returns_empty():
    """Estação cuja isócrona não toca a urb → fill vazio."""
    station = Point(0, 0)
    buf = station.buffer(100)              # 100 m
    urb = _square(500, 0, 50)              # urb a 500 m, fora do buffer
    out = _fill_polygon_for_station(station, buf, urb, time_budget_min=5.0)
    assert out.is_empty


def test_small_urb_fully_filled():
    """Urb pequena adjacente ao buffer e dentro do alcance restante → toda preenchida."""
    station = Point(0, 0)
    buf = station.buffer(300)              # 300 m
    # Urb de 50 m de lado, encostada à fronteira do buffer
    urb = _square(310, 0, 50)
    out = _fill_polygon_for_station(station, buf, urb, time_budget_min=5.0)
    # 5 min × 75 m/min = 375 m total; t_entry ≈ 260/75 ≈ 3.5 min;
    # t_rest ≈ 1.5 min → reach ≈ 110 m, mais que suficiente para uma urb de 100 m
    assert not out.is_empty
    assert abs(out.area - urb.area) / urb.area < 0.05


def test_long_urb_partially_filled():
    """Urb comprida onde o reach esgota a meio → só parte preenchida."""
    station = Point(0, 0)
    buf = station.buffer(300)
    # Urb de 1000 m de comprido começando aos 290 m (sobrepõe ligeiramente o buf)
    urb = Polygon([(290, -50), (1290, -50), (1290, 50), (290, 50)])
    out = _fill_polygon_for_station(station, buf, urb, time_budget_min=5.0)
    assert not out.is_empty
    # Deve cobrir bem menos que a urb inteira (1000 × 100 = 100 000 m²)
    assert out.area < urb.area * 0.5
    # Mas tem de cobrir pelo menos a parte imediatamente adjacente
    assert out.area > 0


def test_station_inside_urb_uses_full_budget():
    """Estação dentro da urb → reach = T × v a partir da estação."""
    station = Point(0, 0)
    buf = station.buffer(300)
    # Urb grande centrada na estação
    urb = _square(0, 0, 1000)
    out = _fill_polygon_for_station(station, buf, urb, time_budget_min=5.0)
    expected_reach = 5.0 * WALK_SPEED_M_PER_MIN  # 375 m
    # A área de fill é um disco de raio 375 m intersetado com a urb (grande):
    # essencialmente o disco. Tolerância porque o disco é discretizado.
    expected_area = 3.14159 * expected_reach ** 2
    assert abs(out.area - expected_area) / expected_area < 0.05


def test_reach_zero_when_entry_at_buffer_edge_for_short_T():
    """Se o tempo gasto a chegar à urb consome todo T, fill é vazio.

    Quando o ponto da urb mais próximo da estação está exactamente no limite
    do buffer ORS (d_entry == T × v), t_rest = 0 e o reach é zero.
    """
    station = Point(0, 0)
    T = 5.0
    radius = T * WALK_SPEED_M_PER_MIN  # 375 m
    buf = station.buffer(radius)
    # Urb cujo bordo esquerdo está exactamente em x = 375 (= radius)
    # → entry é tangencial, d_entry = radius, t_rest = 0
    urb = _square(radius + 50, 0, 50)  # centro 425, bordo esquerdo 375
    out = _fill_polygon_for_station(station, buf, urb, time_budget_min=T)
    assert out.is_empty or out.area < 1.0


def test_10min_fills_more_than_5min():
    """O escalão 10 min cobre mais área da mesma urb que 5 min (caso típico)."""
    station = Point(0, 0)
    buf5 = station.buffer(300)
    buf10 = station.buffer(700)
    urb = _square(500, 0, 200)  # urb 400 m de lado a 500 m da estação
    f5 = _fill_polygon_for_station(station, buf5, urb, 5.0)
    f10 = _fill_polygon_for_station(station, buf10, urb, 10.0)
    assert f10.area > f5.area
