"""Cálculo de população dentro de isócronas.

Inclui:
- Heurística "preenche o polígono" (``_fill_polygon_for_station``) e o seu wrapper
  ``_augment_buffers_with_urbanizations``.
- Distribuição BGRI→ponto via Voronoi (``_assign_population_voronoi``).
- ``compute_population_response``: orquestra todo o cálculo a partir do payload
  do endpoint, incluindo as urbanizações e as BGRIs não cobertas. Retorna o dict
  pronto a serializar.

A velocidade pedonal ``WALK_SPEED_M_PER_MIN`` é definida aqui (re-exportada por
``server.py`` para os testes que dela dependem) e tem de coincidir com a
constante equivalente no cliente — ver regra "do not regress" #11.
"""
import geopandas as gpd
from shapely.geometry import Point, Polygon, shape
from shapely.ops import unary_union


# Velocidade pedonal de referência usada para a heurística "preenche polígono".
# Coerente com RADIUS_5MIN_M/RADIUS_10MIN_M no servidor (5 km/h ≈ 83.4 m/min).
# Calculada como RADIUS_5MIN_M / 5.0 = 417 / 5 = 83.4 — preserva exatidão histórica.
WALK_SPEED_M_PER_MIN = 417 / 5.0  # 83.4 m/min

# CRS métrico local usado para os cálculos do augment. UTM 29N é adequado
# para Portugal continental e evita o factor de escala de Web Mercator
# (~1.28× a 38.5°N), garantindo que distâncias correspondem a metros reais.
AUGMENT_METRIC_CRS = "EPSG:32629"


def _fill_polygon_for_station(station_metric, buffer_metric, urb_metric,
                              time_budget_min, speed_m_per_min=WALK_SPEED_M_PER_MIN):
    """Heurística "preenche o polígono" para uma urbanização nova.

    Pressuposto: dentro do polígono ``urb_metric`` há malha viária contínua,
    portanto qualquer ponto interior é alcançável desde a fronteira a pé
    em linha reta euclidiana. Quando a isócrona ORS de uma estação atinge a
    fronteira da urb, o tempo restante permite percorrer ``reach`` metros
    dentro do polígono.

    Algoritmo (tudo em CRS métrico, EPSG:3857):
      1. Se a estação está dentro da urb: ``filled = urb ∩ buffer(station, T·v)``.
      2. Caso contrário, ``entry = boundary(urb) ∩ buffer_metric``.
      3. ``t_entry = dist(station, entry) / v``  (tempo até primeira fronteira atingida).
      4. ``reach = (T − t_entry) · v``.
      5. ``filled = urb ∩ buffer(entry, reach)``.

    Devolve geometria Shapely (vazia quando a urb não é tocada por esta
    estação no orçamento ``time_budget_min``).
    """
    if urb_metric.is_empty or buffer_metric.is_empty:
        return Polygon()

    # Estação dentro da urb: usa todo o orçamento de tempo a partir da estação
    if station_metric.within(urb_metric):
        reach = time_budget_min * speed_m_per_min
        return urb_metric.intersection(station_metric.buffer(reach))

    boundary = urb_metric.boundary
    entry = boundary.intersection(buffer_metric)
    if entry.is_empty:
        return Polygon()

    d_entry = station_metric.distance(entry)
    t_entry = d_entry / speed_m_per_min
    t_rest = time_budget_min - t_entry
    if t_rest <= 0:
        return Polygon()

    reach = t_rest * speed_m_per_min
    return urb_metric.intersection(entry.buffer(reach))


def _augment_buffers_with_urbanizations(point_info, all_5min_buffers, all_10min_buffers,
                                        new_urbanization_features, census_crs):
    """Aplica a heurística "preenche o polígono" a todas as urbanizações.

    Mutates ``point_info`` in-place (substituindo ``buffer_5min``/``buffer_10min``)
    e devolve listas de buffers atualizadas para reconstrução das uniões.
    Falha silenciosa em caso de erro: as urbanizações apenas não estendem
    a catchment, mas a chamada de população continua a funcionar.
    """
    if not new_urbanization_features or not point_info:
        return all_5min_buffers, all_10min_buffers

    try:
        urb_geoms_wgs = []
        for urb_f in new_urbanization_features:
            try:
                g = shape(urb_f['geometry'])
                if not g.is_empty and g.area > 0:
                    urb_geoms_wgs.append(g)
            except Exception:
                pass
        if not urb_geoms_wgs:
            return all_5min_buffers, all_10min_buffers

        urb_metric_geoms = list(
            gpd.GeoDataFrame(geometry=urb_geoms_wgs, crs="EPSG:4326")
              .to_crs(AUGMENT_METRIC_CRS).geometry
        )

        buf5_metric = list(
            gpd.GeoDataFrame(geometry=[pi['buffer_5min'] for pi in point_info], crs=census_crs)
              .to_crs(AUGMENT_METRIC_CRS).geometry
        )
        buf10_metric = list(
            gpd.GeoDataFrame(geometry=[pi['buffer_10min'] for pi in point_info], crs=census_crs)
              .to_crs(AUGMENT_METRIC_CRS).geometry
        )
        station_pts_metric = list(
            gpd.GeoDataFrame(
                geometry=[Point(pi['lng'], pi['lat']) for pi in point_info],
                crs="EPSG:4326"
            ).to_crs(AUGMENT_METRIC_CRS).geometry
        )

        new_buf5_metric = []
        new_buf10_metric = []
        for idx, pi in enumerate(point_info):
            aug5 = buf5_metric[idx]
            aug10 = buf10_metric[idx]
            for urb_m in urb_metric_geoms:
                f5 = _fill_polygon_for_station(station_pts_metric[idx], buf5_metric[idx], urb_m, 5.0)
                f10 = _fill_polygon_for_station(station_pts_metric[idx], buf10_metric[idx], urb_m, 10.0)
                if not f5.is_empty:
                    aug5 = aug5.union(f5)
                if not f10.is_empty:
                    aug10 = aug10.union(f10)
            new_buf5_metric.append(aug5)
            new_buf10_metric.append(aug10)

        back5 = list(
            gpd.GeoDataFrame(geometry=new_buf5_metric, crs=AUGMENT_METRIC_CRS)
              .to_crs(census_crs).geometry
        )
        back10 = list(
            gpd.GeoDataFrame(geometry=new_buf10_metric, crs=AUGMENT_METRIC_CRS)
              .to_crs(census_crs).geometry
        )
        for i, pi in enumerate(point_info):
            pi['buffer_5min'] = back5[i]
            pi['buffer_10min'] = back10[i]

        return [pi['buffer_5min'] for pi in point_info], [pi['buffer_10min'] for pi in point_info]
    except Exception as e:
        print(f"Aviso: falha no augment 'preenche polígono': {e}")
        return all_5min_buffers, all_10min_buffers


def _assign_population_voronoi(census_subset, point_info, point_populations,
                               get_pop, slot, get_intersection):
    """Atribui população BGRI→pontos resolvendo sobreposições por proximidade.

    Para cada linha de censos em ``census_subset``:
      1. recolhe os pontos cuja área a atribuir (devolvida por
         ``get_intersection(row, point_data)``) intersecta esta BGRI;
      2. se só houver um, atribui-lhe a fração proporcional à área;
      3. se houver vários, divide a BGRI atribuindo cada zona de sobreposição
         ao ponto mais próximo do centroide dessa zona (Voronoi por proximidade).

    O resultado é acumulado em ``point_populations[id][slot]``. Esta função
    é usada para os anéis de 5 min e 10 min — a diferença está na função
    ``get_intersection`` passada pelo chamador.
    """
    for _, row in census_subset.iterrows():
        if row.geometry.area <= 0:
            continue

        intersecting = []
        for pi in point_info:
            inter = get_intersection(row, pi)
            if not inter.is_empty and inter.area > 0:
                intersecting.append({'point_data': pi, 'intersection': inter})

        if not intersecting:
            continue

        if len(intersecting) == 1:
            pd = intersecting[0]['point_data']
            inter = intersecting[0]['intersection']
            ratio = inter.area / row.geometry.area
            point_populations[pd['id']][slot] += get_pop(row) * ratio
            continue

        # Sobreposição: para cada ponto, remover as zonas onde outro ponto
        # está mais perto do centroide do overlap.
        for item in intersecting:
            pid = item['point_data']['id']
            unique = item['intersection']
            for other in intersecting:
                if other['point_data']['id'] == pid:
                    continue
                if not unique.intersects(other['intersection']):
                    continue
                overlap = unique.intersection(other['intersection'])
                if overlap.is_empty:
                    continue
                centroid = overlap.centroid
                d_self = item['point_data']['point'].distance(centroid)
                d_other = other['point_data']['point'].distance(centroid)
                if d_other < d_self:
                    unique = unique.difference(overlap)

            if not unique.is_empty and unique.area > 0:
                ratio = unique.area / row.geometry.area
                point_populations[pid][slot] += get_pop(row) * ratio


def _fallback_circle_buffers(point_metric, radius_5min_m, radius_10min_m, census_crs):
    """Buffers circulares em metros, projetados para o CRS dos censos."""
    buffer_5min_metric = point_metric.buffer(radius_5min_m)
    buffer_10min_metric = point_metric.buffer(radius_10min_m)
    buffer_gdf_5 = gpd.GeoDataFrame([1], geometry=[buffer_5min_metric], crs="EPSG:3857")
    buffer_gdf_10 = gpd.GeoDataFrame([1], geometry=[buffer_10min_metric], crs="EPSG:3857")
    return (
        buffer_gdf_5.to_crs(census_crs).geometry.iloc[0],
        buffer_gdf_10.to_crs(census_crs).geometry.iloc[0],
    )


def compute_population_response(payload, *, census_data, pop_column,
                                radius_5min_m, radius_10min_m,
                                uncovered_min_pop, uncovered_limit):
    """Calcula população dentro de isócronas, evitando duplicações.

    ``payload`` é o dict do request (já com defaults aplicados pelo caller).
    Devolve o dict serializável que o endpoint expõe. Não toca em Flask.
    """
    points = payload.get('points', [])
    density_overrides = payload.get('density_overrides', {}) or {}
    new_urbanization_features = payload.get('new_urbanization_features', []) or []

    if not points:
        return {
            "total_population": 0,
            "total_population_5min": 0,
            "total_population_10min": 0,
            "points": [],
            "groups": [],
            "uncovered_bgris": [],
            "uncovered_total_count": 0,
        }

    # Preparar dados dos pontos e suas isócronas
    point_info = []
    all_5min_buffers = []
    all_10min_buffers = []

    for point_data in points:
        lat = point_data['lat']
        lng = point_data['lng']
        # Preservar o ID original, convertendo para int se necessário
        point_id_raw = point_data.get('id')
        if point_id_raw is None:
            point_id = len(point_info)
        else:
            try:
                point_id = int(point_id_raw)
            except (ValueError, TypeError):
                point_id = point_id_raw

        # Criar ponto em WGS84
        point_wgs84 = Point(lng, lat)
        point_gdf_wgs84 = gpd.GeoDataFrame([1], geometry=[point_wgs84], crs="EPSG:4326")

        # Converter para CRS métrico (Web Mercator) para criar buffers precisos em metros
        point_gdf_metric = point_gdf_wgs84.to_crs("EPSG:3857")
        point_metric = point_gdf_metric.geometry.iloc[0]

        # Converter ponto para CRS dos dados de censos para cálculos de distância
        point_gdf_census = point_gdf_wgs84.to_crs(census_data.crs)
        point_census = point_gdf_census.geometry.iloc[0]

        # Verificar se há isócronas reais fornecidas
        isochrones = point_data.get('isochrones')

        if isochrones and len(isochrones) >= 2:
            try:
                iso_5min_geom = shape(isochrones[0]['geometry'])
                iso_10min_geom = shape(isochrones[1]['geometry'])

                iso_5min_gdf = gpd.GeoDataFrame([1], geometry=[iso_5min_geom], crs="EPSG:4326")
                iso_10min_gdf = gpd.GeoDataFrame([1], geometry=[iso_10min_geom], crs="EPSG:4326")

                if census_data.crs != "EPSG:4326":
                    iso_5min_gdf = iso_5min_gdf.to_crs(census_data.crs)
                    iso_10min_gdf = iso_10min_gdf.to_crs(census_data.crs)

                buffer_5min = iso_5min_gdf.geometry.iloc[0]
                buffer_10min = iso_10min_gdf.geometry.iloc[0]
            except Exception as e:
                print(f"Erro ao processar isócronas reais, usando fallback: {e}")
                buffer_5min, buffer_10min = _fallback_circle_buffers(
                    point_metric, radius_5min_m, radius_10min_m, census_data.crs
                )
        else:
            buffer_5min, buffer_10min = _fallback_circle_buffers(
                point_metric, radius_5min_m, radius_10min_m, census_data.crs
            )

        point_info.append({
            'id': point_id,
            'lat': lat,
            'lng': lng,
            'group_id': point_data.get('group_id'),
            'point': point_census,
            'buffer_5min': buffer_5min,
            'buffer_10min': buffer_10min
        })
        all_5min_buffers.append(buffer_5min)
        all_10min_buffers.append(buffer_10min)

    # Heurística "preenche o polígono"
    all_5min_buffers, all_10min_buffers = _augment_buffers_with_urbanizations(
        point_info, all_5min_buffers, all_10min_buffers,
        new_urbanization_features, census_data.crs,
    )

    results = []
    total_pop_5min = 0
    total_pop_10min = 0
    point_populations = {p['id']: {'5min': 0, '10min': 0} for p in point_info}

    def get_pop_for_row(row):
        bgri_id = None
        for col in ['BGRI2021', 'SUBSECCAO', 'OBJECTID']:
            if col in row.index:
                bgri_id = str(row[col])
                break
        if bgri_id and bgri_id in density_overrides:
            return density_overrides[bgri_id].get('populationOverride', row[pop_column])
        return row[pop_column]

    union_5min = None
    union_10min = None
    secondary_zone = None

    if pop_column and pop_column in census_data.columns:
        union_5min = unary_union(all_5min_buffers) if all_5min_buffers else None
        union_10min = unary_union(all_10min_buffers) if all_10min_buffers else None

        if union_5min:
            census_in_any_5min = census_data[census_data.geometry.intersects(union_5min)].copy()
        else:
            census_in_any_5min = gpd.GeoDataFrame()

        if union_10min:
            census_in_any_10min = census_data[census_data.geometry.intersects(union_10min)].copy()
        else:
            census_in_any_10min = gpd.GeoDataFrame()

        # Anel 5 min: interseção direta com buffer_5min de cada estação
        _assign_population_voronoi(
            census_in_any_5min,
            point_info,
            point_populations,
            get_pop_for_row,
            slot='5min',
            get_intersection=lambda row, pi: row.geometry.intersection(pi['buffer_5min']),
        )

        # Anel 10 min: buffer_10min menos buffer_5min próprio
        def _ring_10min(row, pi):
            inter10 = row.geometry.intersection(pi['buffer_10min'])
            if inter10.is_empty:
                return inter10
            inter5 = row.geometry.intersection(pi['buffer_5min'])
            return inter10.difference(inter5) if not inter5.is_empty else inter10

        _assign_population_voronoi(
            census_in_any_10min,
            point_info,
            point_populations,
            get_pop_for_row,
            slot='10min',
            get_intersection=_ring_10min,
        )

        for point_data in point_info:
            point_id = point_data['id']
            pop_5min = point_populations[point_id]['5min']
            pop_10min = point_populations[point_id]['10min']
            results.append({
                "id": point_id,
                "lat": point_data['lat'],
                "lng": point_data['lng'],
                "population_5min": round(pop_5min),
                "population_10min": round(pop_10min),
                "population_total": round(pop_5min + pop_10min)
            })

        # Totais globais via união (sem dupla contagem entre grupos)
        for _, row in census_in_any_5min.iterrows():
            if row.geometry.area > 0:
                try:
                    inter = row.geometry.intersection(union_5min)
                    if not inter.is_empty:
                        total_pop_5min += get_pop_for_row(row) * inter.area / row.geometry.area
                except Exception:
                    pass

        if union_10min is not None:
            if union_5min is not None:
                try:
                    secondary_zone = union_10min.difference(union_5min)
                except Exception:
                    secondary_zone = union_10min
            else:
                secondary_zone = union_10min

        if secondary_zone is not None and not getattr(secondary_zone, 'is_empty', True):
            for _, row in census_in_any_10min.iterrows():
                if row.geometry.area > 0:
                    try:
                        inter = row.geometry.intersection(secondary_zone)
                        if not inter.is_empty and inter.area > 0:
                            total_pop_10min += get_pop_for_row(row) * inter.area / row.geometry.area
                    except Exception:
                        pass

    # Urbanizações: distribui a população líquida (sem dupla contagem com BGRI)
    urb_processed = []  # [{'geom': shapely, 'density': hab/m²}]
    for urb_feature in new_urbanization_features:
        try:
            estimated_pop = float(urb_feature.get('properties', {}).get('estimated_pop', 0) or 0)
            if estimated_pop <= 0:
                continue
            urb_geom_wgs = shape(urb_feature['geometry'])
            urb_gdf = gpd.GeoDataFrame([1], geometry=[urb_geom_wgs], crs="EPSG:4326")
            if census_data.crs != "EPSG:4326":
                urb_gdf = urb_gdf.to_crs(census_data.crs)
            urb_geom = urb_gdf.geometry.iloc[0]
            if urb_geom.is_empty or urb_geom.area <= 0:
                continue

            # 1. Deduzir população BGRI já contabilizada na sobreposição
            bgri_overlap_pop = 0.0
            try:
                overlapping_bgris = census_data[census_data.geometry.intersects(urb_geom)]
                for _, brow in overlapping_bgris.iterrows():
                    if brow.geometry.area <= 0:
                        continue
                    inter = brow.geometry.intersection(urb_geom)
                    if inter.is_empty or inter.area <= 0:
                        continue
                    bgri_overlap_pop += get_pop_for_row(brow) * (inter.area / brow.geometry.area)
            except Exception as e:
                print(f"Aviso: falha a calcular sobreposição BGRI da urbanização: {e}")

            net_pop = max(0.0, estimated_pop - bgri_overlap_pop)
            if net_pop <= 0:
                continue
            d_urb = net_pop / urb_geom.area  # densidade líquida (hab/m²)

            # 2. Atribuição per-estação por proximidade (Voronoi)
            slices_5 = []
            slices_10 = []
            for pi in point_info:
                try:
                    i5 = urb_geom.intersection(pi['buffer_5min'])
                    i10 = urb_geom.intersection(pi['buffer_10min'])
                    ring10 = i10.difference(i5) if not i5.is_empty else i10
                    if not i5.is_empty and i5.area > 0:
                        slices_5.append({'pi': pi, 'inter': i5})
                    if not ring10.is_empty and ring10.area > 0:
                        slices_10.append({'pi': pi, 'inter': ring10})
                except Exception:
                    pass

            def _voronoi_resolve(items):
                for item in items:
                    unique = item['inter']
                    for other in items:
                        if other is item:
                            continue
                        if not unique.intersects(other['inter']):
                            continue
                        overlap = unique.intersection(other['inter'])
                        if overlap.is_empty or overlap.area <= 0:
                            continue
                        cen = overlap.centroid
                        if other['pi']['point'].distance(cen) < item['pi']['point'].distance(cen):
                            unique = unique.difference(overlap)
                    item['unique'] = unique

            _voronoi_resolve(slices_5)
            _voronoi_resolve(slices_10)

            for item in slices_5:
                u = item.get('unique')
                if u is None or u.is_empty or u.area <= 0:
                    continue
                point_populations[item['pi']['id']]['5min'] += d_urb * u.area
            for item in slices_10:
                u = item.get('unique')
                if u is None or u.is_empty or u.area <= 0:
                    continue
                point_populations[item['pi']['id']]['10min'] += d_urb * u.area

            for r in results:
                pid = r['id']
                pop5 = point_populations[pid]['5min']
                pop10 = point_populations[pid]['10min']
                r['population_5min'] = round(pop5)
                r['population_10min'] = round(pop10)
                r['population_total'] = round(pop5 + pop10)

            # 3. Totais globais via união das isócronas
            if union_5min is not None:
                try:
                    gi5 = urb_geom.intersection(union_5min)
                    if not gi5.is_empty:
                        total_pop_5min += d_urb * gi5.area
                except Exception:
                    pass
            if secondary_zone is not None and not getattr(secondary_zone, 'is_empty', True):
                try:
                    gi10 = urb_geom.intersection(secondary_zone)
                    if not gi10.is_empty:
                        total_pop_10min += d_urb * gi10.area
                except Exception:
                    pass

            urb_processed.append({'geom': urb_geom, 'density': d_urb})
        except Exception as e:
            print(f"Erro ao processar urbanização: {e}")

    # ── Per-group totals via união ──
    groups_totals = []
    if pop_column and pop_column in census_data.columns:
        buffers_by_group = {}
        for pi in point_info:
            gid = pi.get('group_id')
            if gid is None:
                continue
            slot = buffers_by_group.setdefault(gid, {'b5': [], 'b10': []})
            slot['b5'].append(pi['buffer_5min'])
            slot['b10'].append(pi['buffer_10min'])

        for gid, slot in buffers_by_group.items():
            try:
                gu5 = unary_union(slot['b5']) if slot['b5'] else None
                gu10 = unary_union(slot['b10']) if slot['b10'] else None
                gpop5 = 0.0
                gpop10 = 0.0
                if gu5 is not None and not getattr(gu5, 'is_empty', True):
                    sub5 = census_data[census_data.geometry.intersects(gu5)]
                    for _, row in sub5.iterrows():
                        if row.geometry.area > 0:
                            inter = row.geometry.intersection(gu5)
                            if not inter.is_empty:
                                gpop5 += get_pop_for_row(row) * inter.area / row.geometry.area
                if gu10 is not None and not getattr(gu10, 'is_empty', True):
                    secondary = gu10.difference(gu5) if (gu5 is not None and not getattr(gu5, 'is_empty', True)) else gu10
                    if not getattr(secondary, 'is_empty', True):
                        sub10 = census_data[census_data.geometry.intersects(secondary)]
                        for _, row in sub10.iterrows():
                            if row.geometry.area > 0:
                                inter = row.geometry.intersection(secondary)
                                if not inter.is_empty:
                                    gpop10 += get_pop_for_row(row) * inter.area / row.geometry.area
                if urb_processed:
                    g_secondary = None
                    if gu10 is not None and not getattr(gu10, 'is_empty', True):
                        g_secondary = (gu10.difference(gu5)
                                       if (gu5 is not None and not getattr(gu5, 'is_empty', True))
                                       else gu10)
                    for u in urb_processed:
                        try:
                            if gu5 is not None and not getattr(gu5, 'is_empty', True):
                                gi5 = u['geom'].intersection(gu5)
                                if not gi5.is_empty and gi5.area > 0:
                                    gpop5 += u['density'] * gi5.area
                            if g_secondary is not None and not getattr(g_secondary, 'is_empty', True):
                                gi10 = u['geom'].intersection(g_secondary)
                                if not gi10.is_empty and gi10.area > 0:
                                    gpop10 += u['density'] * gi10.area
                        except Exception:
                            pass
                groups_totals.append({
                    'id': gid,
                    'total_population_5min': round(gpop5),
                    'total_population_10min': round(gpop10),
                    'total_population': round(gpop5 + gpop10),
                })
            except Exception as e:
                print(f"Aviso: falha ao calcular totais para grupo {gid}: {e}")

    # ── BGRIs sem cobertura ──
    uncovered_bgris = []
    uncovered_total_count = 0
    if pop_column and pop_column in census_data.columns:
        all_coverage = union_10min if union_10min is not None else union_5min
        if all_coverage is not None:
            try:
                covered_mask = census_data.geometry.intersects(all_coverage)
                uncovered_df = census_data[~covered_mask].copy()
            except Exception as e:
                print(f"Aviso: falha ao calcular BGRIs não cobertas: {e}")
                uncovered_df = gpd.GeoDataFrame()
        else:
            uncovered_df = census_data.copy()

        if len(uncovered_df) > 0 and pop_column in uncovered_df.columns:
            uncovered_df = uncovered_df[uncovered_df[pop_column] >= uncovered_min_pop]
            uncovered_total_count = int(len(uncovered_df))
            uncovered_df = uncovered_df.sort_values(pop_column, ascending=False)
            for _, row in uncovered_df.head(uncovered_limit).iterrows():
                bgri_id = str(row.get('BGRI2021', row.get('SUBSECCAO', row.get('OBJECTID', ''))))
                centroid = row.geometry.centroid
                shape_area = row.get('SHAPE_Area', None)
                area_ha = round(float(shape_area) / 10000, 1) if shape_area else None
                uncovered_bgris.append({
                    'id': bgri_id,
                    'population': int(row[pop_column]),
                    'lat': round(centroid.y, 5),
                    'lng': round(centroid.x, 5),
                    'area_ha': area_ha,
                })

    return {
        "total_population_5min": round(total_pop_5min),
        "total_population_10min": round(total_pop_10min),
        "total_population": round(total_pop_5min + total_pop_10min),
        "points": results,
        "groups": groups_totals,
        "uncovered_bgris": uncovered_bgris,
        "uncovered_total_count": uncovered_total_count,
    }
