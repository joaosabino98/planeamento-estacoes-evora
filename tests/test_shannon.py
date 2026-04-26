"""Testes para `compute_shannon_h(residents, breakdown)`.

Estes testes blindam regras documentadas em `architecture.instructions.md`
("Shannon H classification table" e "do not regress" sobre `residents=0`).
"""


def _h(server_module, residents, **breakdown):
    """Helper: retorna (h_norm, classification) preenchendo categorias em falta com 0."""
    full = {
        "commerce": 0,
        "services": 0,
        "education_health": 0,
        "culture_leisure": 0,
        "industry": 0,
        **breakdown,
    }
    return server_module.compute_shannon_h(residents, full)


def test_no_data_returns_zero_and_label(server_module):
    h, cls = _h(server_module, 0)
    assert h == 0.0
    assert cls == "Sem dados"


def test_single_category_is_monofuncional(server_module):
    # Apenas residentes
    h, cls = _h(server_module, 100)
    assert h == 0.0
    assert cls == "Mono-funcional"


def test_residents_zero_with_jobs_classifies_as_employment_node(server_module):
    """Regra 'do not regress': residents=0 e jobs>0 → ratio=1.0 → Nó de emprego/Centralidade."""
    h, cls = _h(server_module, 0, commerce=50, services=50)
    # H ≥ 0.6 (duas categorias balanceadas) → centralidade
    assert h >= 0.6
    assert cls in {"Centralidade multifuncional", "Misto equilibrado", "Nó de emprego"}


def test_centralidade_multifuncional_threshold(server_module):
    # Mistura balanceada de várias categorias dá H elevado
    h, cls = _h(
        server_module,
        residents=100,
        commerce=80,
        services=80,
        education_health=80,
        culture_leisure=80,
    )
    assert h >= 0.60
    assert cls == "Centralidade multifuncional"


def test_dormitorio_low_mix_low_jobs(server_module):
    # Muitos residentes, poucos empregos → ratio < 0.5 e H baixo
    h, cls = _h(server_module, residents=1000, commerce=10)
    assert cls == "Dormitório"


def test_employment_hub_high_ratio(server_module):
    # Poucos residentes mas muitos empregos numa só categoria → H baixo, ratio>=0.5
    h, cls = _h(server_module, residents=10, commerce=200)
    assert cls == "Nó de emprego"


def test_h_bounded_zero_to_one(server_module):
    """H normalizado tem de estar sempre em [0, 1]."""
    cases = [
        (0, {}),
        (1000, {"commerce": 1}),
        (1, {"commerce": 1, "services": 1, "industry": 1}),
        (50, {"commerce": 50, "services": 50, "education_health": 50,
              "culture_leisure": 50, "industry": 50}),
    ]
    for residents, bd in cases:
        h, _ = _h(server_module, residents, **bd)
        assert 0.0 <= h <= 1.0
