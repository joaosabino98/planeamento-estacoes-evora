"""Testes para `_isochrone_cache_key(lat, lng, ranges)`.

Regra "do not regress" #12: a chave inclui ranges, caso contrário
diferentes janelas temporais colidem em disco.
"""


def test_key_includes_ranges_separator(server_module):
    key = server_module._isochrone_cache_key(38.5, -7.9)
    assert "|" in key, "chave tem de separar lat,lng de ranges com '|'"


def test_default_ranges_used_when_omitted(server_module):
    default = server_module._isochrone_cache_key(38.5, -7.9)
    explicit = server_module._isochrone_cache_key(38.5, -7.9, [300, 600])
    assert default == explicit


def test_different_ranges_yield_different_keys(server_module):
    """Se ranges diferentes produzissem a mesma chave, isócronas de 5/10 e 7/14
    iriam sobrepor-se em disco (regressão histórica)."""
    a = server_module._isochrone_cache_key(38.5, -7.9, [300, 600])
    b = server_module._isochrone_cache_key(38.5, -7.9, [420, 840])
    assert a != b


def test_lat_lng_rounded_to_five_decimals(server_module):
    """Coordenadas a ~1 m de distância colapsam para a mesma chave."""
    a = server_module._isochrone_cache_key(38.566700, -7.907500)
    b = server_module._isochrone_cache_key(38.566701, -7.907501)
    assert a == b


def test_far_apart_coords_differ(server_module):
    a = server_module._isochrone_cache_key(38.5, -7.9)
    b = server_module._isochrone_cache_key(38.6, -7.9)
    assert a != b
