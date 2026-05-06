"""Estimativa de empregos por isócrona (POIs OSM via Overpass + urbanizações).

Função principal: ``compute_jobs_response``.

Dependências externas (Overpass, cache em memória) são injetadas pelo route
handler de ``server.py`` para preservar a superfície de teste:
``mocker.patch("server._request_with_backoff", ...)`` continua a funcionar
porque o handler resolve o símbolo no seu próprio módulo e passa-o como
parâmetro a esta função.
"""
import time
import geopandas as gpd
from shapely.geometry import Point, Polygon, shape
from shapely.ops import unary_union

from server_lib.jobs_taxonomy import JOBS_PER_HA, classify_poi_tags
from server_lib.shannon import compute_shannon_h
from server_lib.population import AUGMENT_METRIC_CRS


CATEGORIES = ['commerce', 'services', 'education_health', 'culture_leisure', 'industry']


def _build_overpass_query(bbox_str):
    """Constroi a query Overpass para todas as categorias relevantes."""
    amenity_rx = (
        "restaurant|cafe|bar|pub|biergarten|fast_food|food_court|nightclub|fuel|car_wash|"
        "bank|post_office|police|fire_station|hospital|clinic|doctors|dentist|pharmacy|"
        "veterinary|school|language_school|kindergarten|university|college|"
        "theatre|arts_centre|cinema|library|museum"
    )
    tourism_rx = "hotel|hostel|motel|apartment|guest_house"
    leisure_rx = "sports_centre|fitness_centre|stadium|swimming_pool|golf_course"
    landuse_rx = "industrial|commercial|retail"

    return (
        f'[out:json][timeout:30];\n'
        f'(\n'
        f'  node["shop"]({bbox_str});\n'
        f'  node["amenity"~"{amenity_rx}"]({bbox_str});\n'
        f'  node["office"]({bbox_str});\n'
        f'  node["tourism"~"{tourism_rx}"]({bbox_str});\n'
        f'  node["leisure"~"{leisure_rx}"]({bbox_str});\n'
        f'  way["shop"]({bbox_str});\n'
        f'  way["amenity"~"{amenity_rx}"]({bbox_str});\n'
        f'  way["office"]({bbox_str});\n'
        f'  way["tourism"~"{tourism_rx}"]({bbox_str});\n'
        f'  way["leisure"~"{leisure_rx}"]({bbox_str});\n'
        f'  way["landuse"~"{landuse_rx}"]({bbox_str});\n'
        f');\n'
        f'out body geom;'
    )


def _fetch_overpass_elements(bbox_bounds, *, request_with_backoff, overpass_cache, overpass_ttl_s):
    """Devolve a lista de elementos OSM para a bbox indicada (com cache em memória)."""
    minx, miny, maxx, maxy = bbox_bounds
    bbox_str = f"{miny:.6f},{minx:.6f},{maxy:.6f},{maxx:.6f}"
    bbox_round = (round(miny, 3), round(minx, 3), round(maxy, 3), round(maxx, 3))
    now_ts = time.time()

    cache_entry = overpass_cache.get(bbox_round)
    if cache_entry and (now_ts - cache_entry['t']) < overpass_ttl_s:
        elements = cache_entry['elements']
        print(f"Overpass cache hit ({len(elements)} elementos) para bbox {bbox_round}")
        return elements

    overpass_url = "https://overpass-api.de/api/interpreter"
    overpass_headers = {
        # Overpass devolve 406 sem User-Agent identificável
        'User-Agent': 'planeamento-estacoes-evora/1.0 (https://github.com/; contacto via repositório)',
        'Accept': 'application/json',
    }
    try:
        resp = request_with_backoff(
            overpass_url,
            method='post',
            data={'data': _build_overpass_query(bbox_str)},
            headers=overpass_headers,
            timeout=35,
            retry_status=(429, 502, 503, 504),
            backoff_base=0.8,
            label='Overpass',
        )
        if resp is None:
            return []
        resp.raise_for_status()
        elements = resp.json().get('elements', [])
        print(f"Overpass devolveu {len(elements)} elementos para bbox {bbox_str}")
        overpass_cache[bbox_round] = {'t': now_ts, 'elements': elements}
        if len(overpass_cache) > 64:
            overpass_cache.pop(next(iter(overpass_cache)))
        return elements
    except Exception as e:
        print(f"Overpass API error: {e}")
        return []


def _parse_pois(elements):
    """Converte elementos OSM brutos em registos POI utilizáveis."""
    pois = []
    for el in elements:
        tags = el.get('tags', {})
        el_type = el.get('type', 'node')

        if el_type == 'node':
            lon_el = el.get('lon')
            lat_el = el.get('lat')
        else:
            geom_pts = el.get('geometry', [])
            if not geom_pts:
                continue
            lon_el = sum(p['lon'] for p in geom_pts) / len(geom_pts)
            lat_el = sum(p['lat'] for p in geom_pts) / len(geom_pts)

        if lon_el is None or lat_el is None:
            continue

        category, jobs_val = classify_poi_tags(el_type, tags)
        if category is None:
            continue

        # Landuse polígonais usam área × jobs/ha
        if jobs_val == '__area__':
            geom_pts = el.get('geometry', [])
            if len(geom_pts) >= 3:
                try:
                    coords = [(p['lon'], p['lat']) for p in geom_pts]
                    poly = Polygon(coords)
                    gdf_poly = gpd.GeoDataFrame([1], geometry=[poly], crs='EPSG:4326')
                    gdf_metric = gdf_poly.to_crs('EPSG:3857')
                    area_m2 = gdf_metric.geometry.iloc[0].area
                    area_ha = area_m2 / 10000
                    landuse = tags.get('landuse', 'industrial')
                    jpha = JOBS_PER_HA.get(landuse, 20)
                    jobs_val = max(1, round(area_ha * jpha))
                except Exception:
                    jobs_val = 20
            else:
                jobs_val = 20

        pois.append({
            'point':    Point(lon_el, lat_el),
            'lon':      lon_el,
            'lat':      lat_el,
            'category': category,
            'jobs':     int(jobs_val),
            'name':     tags.get('name', ''),
            'osm_id':   f"{el_type}_{el.get('id', '')}",
        })
    return pois


def _preprocess_urbanizations(new_urbanizations):
    """Devolve (urb_filter_polys_wgs, urb_contributors).

    - ``urb_filter_polys_wgs``: lista de polígonos WGS84 de TODAS as urbs com
      geometria válida — usada para descartar POIs OSM dentro delas (anti-dupla
      contagem com a estimativa paramétrica).
    - ``urb_contributors``: apenas as que efetivamente contribuem com empregos
      (``jobs_ha>0`` e ``coverage>0``), já em CRS métrico, com ``total_jobs`` e
      ``mix`` normalizado pré-calculados.
    """
    urb_filter_polys_wgs = []
    contrib_wgs_list = []
    contrib_meta = []

    if not new_urbanizations:
        return urb_filter_polys_wgs, []

    for u in new_urbanizations:
        try:
            g = shape(u.get('geometry'))
            if g.is_empty or g.area <= 0:
                continue
        except Exception:
            continue
        urb_filter_polys_wgs.append(g)
        jobs_ha = float(u.get('jobs_ha') or 0)
        coverage = float(u.get('coverage') or 0) / 100.0
        if jobs_ha <= 0 or coverage <= 0:
            continue  # filtra POIs mas não contribui com empregos
        mix_raw = u.get('mix') or {}
        mix = {c: max(0.0, float(mix_raw.get(c, 0))) for c in CATEGORIES}
        s_mix = sum(mix.values())
        if s_mix > 0:
            mix = {c: mix[c] / s_mix for c in CATEGORIES}
        else:
            mix = {c: 1.0 / len(CATEGORIES) for c in CATEGORIES}
        contrib_wgs_list.append(g)
        contrib_meta.append({'jobs_ha': jobs_ha, 'coverage': coverage, 'mix': mix})

    if not contrib_wgs_list:
        return urb_filter_polys_wgs, []

    urb_contributors = []
    try:
        metric_geoms = list(
            gpd.GeoDataFrame(geometry=contrib_wgs_list, crs="EPSG:4326")
               .to_crs(AUGMENT_METRIC_CRS).geometry
        )
        for g_m, meta in zip(metric_geoms, contrib_meta):
            area_m2 = g_m.area
            if area_m2 <= 0:
                continue
            area_ha = area_m2 / 10000.0
            urb_contributors.append({
                'geom_metric': g_m,
                'area_m2':     area_m2,
                'total_jobs':  meta['jobs_ha'] * area_ha * meta['coverage'],
                'mix':         meta['mix'],
            })
    except Exception as e:
        print(f"Aviso: falha no pré-processamento de urbanizações para empregos: {e}")
        urb_contributors = []

    return urb_filter_polys_wgs, urb_contributors


def compute_jobs_response(payload, *, request_with_backoff, overpass_cache, overpass_ttl_s,
                          radius_5min_m, meters_per_degree, active_population_ratio):
    """Calcula empregos por estação (POIs OSM + urbanizações).

    ``payload`` é o dict do request. Devolve o dict serializável que o endpoint
    expõe — não toca em Flask. Constantes da cidade são injetadas pelo caller.
    """
    stations_data = payload.get('stations', [])
    new_urbanizations = payload.get('new_urbanizations', []) or []

    if not stations_data:
        return {'stations': []}

    # ── 1. Construir geometrias por estação (WGS84) ───────────────────────
    radius_5min_deg = radius_5min_m / meters_per_degree

    station_geoms = []
    all_geoms = []
    for s in stations_data:
        lat, lng = s['lat'], s['lng']
        isochrones = s.get('isochrones')
        try:
            if isochrones and len(isochrones) >= 1:
                geom_5 = shape(isochrones[0]['geometry'])
            else:
                geom_5 = Point(lng, lat).buffer(radius_5min_deg)
        except Exception:
            geom_5 = Point(lng, lat).buffer(radius_5min_deg)

        station_geoms.append({
            'id':       s['id'],
            'lat':      lat,
            'lng':      lng,
            'geom_5':   geom_5,
            'pop_5min': s.get('population_5min', 0),
        })
        all_geoms.append(geom_5)

    # ── 2. Overpass (com cache) ────────────────────────────────────────────
    union_all = unary_union(all_geoms)
    elements = _fetch_overpass_elements(
        union_all.bounds,
        request_with_backoff=request_with_backoff,
        overpass_cache=overpass_cache,
        overpass_ttl_s=overpass_ttl_s,
    )
    pois = _parse_pois(elements)

    # ── 3. Urbanizações (pré-processamento) ───────────────────────────────
    urb_filter_polys_wgs, urb_contributors = _preprocess_urbanizations(new_urbanizations)
    urb_union_wgs = unary_union(urb_filter_polys_wgs) if urb_filter_polys_wgs else None

    # Pré-projeção das isócronas para CRS métrico (apenas se houver urbs contribuintes)
    station_geom5_metric = []
    if urb_contributors:
        try:
            station_geom5_metric = list(
                gpd.GeoDataFrame(geometry=[sg['geom_5'] for sg in station_geoms], crs="EPSG:4326")
                   .to_crs(AUGMENT_METRIC_CRS).geometry
            )
        except Exception as e:
            print(f"Aviso: falha na projeção das isócronas para CRS métrico: {e}")
            station_geom5_metric = []

    # ── 4. Agregação por estação ──────────────────────────────────────────
    results = []
    for sg_idx, sg in enumerate(station_geoms):
        geom = sg['geom_5']
        # Descartar POIs dentro de qualquer urbanização (anti-dupla contagem).
        if urb_union_wgs is not None:
            station_pois = [p for p in pois
                            if geom.contains(p['point']) and not urb_union_wgs.contains(p['point'])]
        else:
            station_pois = [p for p in pois if geom.contains(p['point'])]

        breakdown = {c: 0.0 for c in CATEGORIES}
        for p in station_pois:
            cat = p['category']
            if cat in breakdown:
                breakdown[cat] += p['jobs']

        jobs_from_pois = sum(breakdown.values())

        # Contribuição das urbanizações: prorated pela fração da urb dentro da iso 5min.
        jobs_from_urb = 0.0
        if urb_contributors and station_geom5_metric:
            geom_m = station_geom5_metric[sg_idx]
            for r in urb_contributors:
                try:
                    inter = geom_m.intersection(r['geom_metric'])
                    if inter.is_empty:
                        continue
                    frac = inter.area / r['area_m2']
                    if frac <= 0:
                        continue
                    add = r['total_jobs'] * frac
                    jobs_from_urb += add
                    for c in CATEGORIES:
                        breakdown[c] += add * r['mix'][c]
                except Exception:
                    continue

        jobs_total = sum(breakdown.values())
        poi_count = len(station_pois)
        residents = sg['pop_5min'] or 0

        h_norm, classification = compute_shannon_h(residents, breakdown)

        active_pop = residents * active_population_ratio
        if active_pop > 0:
            self_sufficiency = round(jobs_total / active_pop, 3)
        elif jobs_total > 0:
            self_sufficiency = 1.0  # sem residentes mas com emprego → auto-suficiência máxima
        else:
            self_sufficiency = 0.0

        poi_list = [
            {'lat': p['lat'], 'lng': p['lon'], 'category': p['category'],
             'name': p['name'], 'jobs': p['jobs'], 'osm_id': p['osm_id']}
            for p in station_pois
        ]

        results.append({
            'id':                      sg['id'],
            'jobs_total':              round(jobs_total),
            'jobs_breakdown':          {k: round(v) for k, v in breakdown.items()},
            'jobs_from_pois':          round(jobs_from_pois),
            'jobs_from_urbanizations': round(jobs_from_urb),
            'shannon_h':               h_norm,
            'tod_classification':      classification,
            'self_sufficiency':        self_sufficiency,
            'poi_count':               poi_count,
            'low_coverage_warning':    poi_count < 5,
            'pois':                    poi_list,
        })

    # ── 5. Total agregado de empregos cobertos pela rede ──────────────────
    # Soma única e deduplicada: cada POI conta uma vez (filtrado pela união
    # das isócronas 5 min, e descartado se cair dentro de qualquer urbanização);
    # cada urbanização contribui prorated pela fração coberta pela mesma união.
    total_jobs_covered = 0.0
    if station_geoms:
        try:
            stations_union_wgs = unary_union([sg['geom_5'] for sg in station_geoms])
            for p in pois:
                if not stations_union_wgs.contains(p['point']):
                    continue
                if urb_union_wgs is not None and urb_union_wgs.contains(p['point']):
                    continue
                total_jobs_covered += p['jobs']
            if urb_contributors and station_geom5_metric:
                stations_union_metric = unary_union(station_geom5_metric)
                for r in urb_contributors:
                    inter = stations_union_metric.intersection(r['geom_metric'])
                    if inter.is_empty:
                        continue
                    frac = inter.area / r['area_m2']
                    if frac > 0:
                        total_jobs_covered += r['total_jobs'] * frac
        except Exception as e:
            print(f"Aviso: falha no cálculo do total de empregos cobertos: {e}")

    return {
        'stations': results,
        'total_jobs_covered': round(total_jobs_covered),
    }
