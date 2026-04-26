"""Pytest configuration and shared fixtures.

Garante que o módulo `server` é importável a partir da raiz do projeto e
expõe um cliente Flask reaproveitando os dados de censos reais (carregados
uma única vez por sessão).
"""
import os
import sys

import pytest

# Permite `import server` a partir de qualquer cwd
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


@pytest.fixture(scope="session")
def server_module():
    """Importa o servidor uma única vez e carrega o GeoDataFrame de censos."""
    import server  # noqa: WPS433
    if server.CENSUS_DATA is None:
        server.load_census_data()
    return server


@pytest.fixture()
def client(server_module):
    """Cliente Flask em modo de teste."""
    server_module.app.config["TESTING"] = True
    with server_module.app.test_client() as c:
        yield c


@pytest.fixture()
def evora_center_point():
    """Ponto canónico (Praça do Giraldo) usado em snapshots de população."""
    return {"id": 1, "lat": 38.5667, "lng": -7.9075, "group_id": "g1"}
