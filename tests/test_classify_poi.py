"""Testes para `classify_poi_tags(el_type, tags)`.

Cobertura mínima das ramificações relevantes — não exaustiva.
"""


def test_unknown_tags_returns_none(server_module):
    cat, jobs = server_module.classify_poi_tags("node", {})
    assert (cat, jobs) == (None, None)


def test_supermarket_is_commerce(server_module):
    cat, jobs = server_module.classify_poi_tags("node", {"shop": "supermarket"})
    assert cat == "commerce"
    assert isinstance(jobs, int) and jobs > 0


def test_hospital_is_education_health_with_high_jobs(server_module):
    cat, jobs = server_module.classify_poi_tags("node", {"amenity": "hospital"})
    assert cat == "education_health"
    assert jobs >= 50


def test_school_is_education_health(server_module):
    cat, jobs = server_module.classify_poi_tags("node", {"amenity": "school"})
    assert cat == "education_health"


def test_cafe_is_commerce(server_module):
    cat, jobs = server_module.classify_poi_tags("node", {"amenity": "cafe"})
    assert cat == "commerce"


def test_library_is_culture_leisure(server_module):
    cat, jobs = server_module.classify_poi_tags("node", {"amenity": "library"})
    assert cat == "culture_leisure"


def test_landuse_returns_area_marker(server_module):
    """Polígonos de landuse devolvem '__area__' para cálculo posterior por área."""
    cat, jobs = server_module.classify_poi_tags("way", {"landuse": "industrial"})
    assert cat == "industry"
    assert jobs == "__area__"
