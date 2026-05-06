"""Índice de Shannon normalizado (mix de usos) e classificação TOD.

``compute_shannon_h`` é determinístico e puro — partilhado pelo cálculo de
empregos por estação (``server_lib.jobs``).
"""
import math


def compute_shannon_h(residents, breakdown):
    """Compute normalised Shannon entropy H for land-use mix.
    residents: int — population in isochrone
    breakdown: dict with keys commerce, services, education_health, culture_leisure, industry
    Returns (h_norm [0..1], tod_classification string)
    """
    cats = {
        'residents':        max(0, residents),
        'commerce':         max(0, breakdown.get('commerce', 0)),
        'services':         max(0, breakdown.get('services', 0)),
        'education_health': max(0, breakdown.get('education_health', 0)),
        'culture_leisure':  max(0, breakdown.get('culture_leisure', 0)),
        'industry':         max(0, breakdown.get('industry', 0)),
    }
    total = sum(cats.values())
    if total == 0:
        return (0.0, 'Sem dados')

    n_positive = sum(1 for v in cats.values() if v > 0)
    if n_positive < 2:
        return (0.0, 'Mono-funcional')

    h = 0.0
    for v in cats.values():
        if v > 0:
            p = v / total
            h -= p * math.log(p)

    h_max = math.log(n_positive)
    h_norm = h / h_max if h_max > 0 else 0.0

    # Perfil funcional
    jobs_total = sum(v for k, v in cats.items() if k != 'residents')
    if residents > 0:
        ratio = jobs_total / residents
    elif jobs_total > 0:
        ratio = 1.0  # sem residentes mas com emprego → nó de emprego
    else:
        ratio = 0.0
    if h_norm >= 0.6:
        classification = 'Centralidade multifuncional'
    elif h_norm >= 0.4 and ratio >= 0.2:
        classification = 'Misto equilibrado'
    elif ratio >= 0.5:
        classification = 'Nó de emprego'
    elif h_norm >= 0.3:
        classification = 'Misto desequilibrado'
    else:
        classification = 'Dormitório'

    return (round(h_norm, 3), classification)
