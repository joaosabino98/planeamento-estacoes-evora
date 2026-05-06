"""Classificação de POIs do OSM em categorias de empregos.

Tabela ``JOBS_PER_HA`` para landuse polygons e função ``classify_poi_tags``
que mapeia tags OSM → ``(categoria, empregos_estimados)``.

Valores baseados em médias INE/SCIE 2021 para municípios da dimensão de Évora.
"""

# ==================== Job Coefficients (OSM → employment estimate) ====================
# Format: osm_tag_key → { tag_value: (category, jobs_per_establishment) }
# Special jobs value '__area__' means compute from polygon area × jobs/ha rate.
JOBS_PER_HA = {
    'industrial': 20,   # light industry / logistics
    'commercial': 40,   # offices + retail mix
    'retail':     40,   # retail parks
}


def classify_poi_tags(el_type, tags):
    """Return (category, jobs) or (None, None) if not relevant.
    category ∈ {'commerce', 'services', 'education_health', 'culture_leisure', 'industry'}
    jobs is an integer, or '__area__' for landuse polygons (area-based calculation).
    """
    shop = tags.get('shop')
    if shop:
        if shop in ('supermarket', 'hypermarket'):
            return ('commerce', 25)
        if shop in ('mall', 'department_store'):
            return ('commerce', 80)
        if shop in ('convenience', 'bakery', 'butcher', 'greengrocer', 'fishmonger', 'deli'):
            return ('commerce', 3)
        if shop in ('clothes', 'shoes', 'sports', 'books', 'gift', 'jewelry', 'florist', 'optician'):
            return ('commerce', 5)
        if shop in ('furniture', 'bed', 'kitchen', 'carpet'):
            return ('commerce', 8)
        if shop in ('car', 'car_repair', 'motorcycle', 'bicycle'):
            return ('commerce', 10)
        if shop in ('hardware', 'doityourself', 'garden'):
            return ('commerce', 6)
        if shop in ('electronics', 'computer', 'mobile_phone'):
            return ('commerce', 8)
        return ('commerce', 4)   # generic retail

    amenity = tags.get('amenity')
    if amenity:
        if amenity == 'restaurant':
            return ('commerce', 8)
        if amenity in ('cafe', 'bar', 'pub', 'biergarten'):
            return ('commerce', 3)
        if amenity == 'fast_food':
            return ('commerce', 6)
        if amenity == 'food_court':
            return ('commerce', 20)
        if amenity == 'bank':
            return ('services', 8)
        if amenity == 'post_office':
            return ('services', 15)
        if amenity == 'police':
            return ('services', 25)
        if amenity == 'fire_station':
            return ('services', 15)
        if amenity == 'hospital':
            return ('education_health', 200)
        if amenity in ('clinic', 'doctors'):
            return ('education_health', 8)
        if amenity == 'dentist':
            return ('education_health', 4)
        if amenity == 'pharmacy':
            return ('education_health', 5)
        if amenity == 'veterinary':
            return ('education_health', 3)
        if amenity in ('school', 'language_school'):
            return ('education_health', 25)
        if amenity == 'kindergarten':
            return ('education_health', 8)
        if amenity == 'university':
            return ('education_health', 150)
        if amenity == 'college':
            return ('education_health', 60)
        if amenity in ('theatre', 'arts_centre'):
            return ('culture_leisure', 15)
        if amenity == 'cinema':
            return ('culture_leisure', 12)
        if amenity == 'library':
            return ('culture_leisure', 8)
        if amenity == 'museum':
            return ('culture_leisure', 12)
        if amenity == 'nightclub':
            return ('commerce', 8)
        if amenity in ('fuel', 'car_wash'):
            return ('services', 5)

    office = tags.get('office')
    if office:
        if office in ('government', 'administrative'):
            return ('services', 20)
        if office in ('lawyer', 'accountant', 'insurance', 'financial', 'tax_advisor'):
            return ('services', 6)
        return ('services', 8)

    tourism = tags.get('tourism')
    if tourism == 'hotel':
        return ('commerce', 20)
    if tourism in ('hostel', 'motel', 'apartment'):
        return ('commerce', 8)
    if tourism == 'guest_house':
        return ('commerce', 4)

    leisure = tags.get('leisure')
    if leisure in ('sports_centre', 'fitness_centre', 'stadium'):
        return ('culture_leisure', 15)
    if leisure in ('swimming_pool', 'golf_course'):
        return ('culture_leisure', 10)

    # Landuse polygons (area-based) — only meaningful for way/relation
    if el_type == 'way':
        landuse = tags.get('landuse')
        if landuse == 'industrial':
            return ('industry', '__area__')
        if landuse in ('commercial', 'retail'):
            return ('commerce', '__area__')

    return (None, None)
