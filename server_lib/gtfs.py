"""Importação GTFS — extrai paragens agrupadas por linha dominante.

Função principal: ``parse_gtfs_zip(file_bytes)``.

Lê routes/trips/stop_times/stops do ficheiro ZIP, atribui a cada paragem a sua
linha "dominante" (a com mais viagens), e devolve as paragens agrupadas por
linha, filtradas pela bbox do município de Évora.

Não levanta — devolve sempre ``(payload, status_code)`` onde ``payload`` é um
dict serializável e ``status_code`` ∈ {200, 400, 500}. O caller (Flask) só faz
``jsonify``.
"""
import csv
import io
import zipfile

# Bounding box do município de Évora — usada para filtrar paragens fora da área.
LAT_MIN, LAT_MAX = 38.4, 38.7
LON_MIN, LON_MAX = -8.1, -7.6

# Limite defensivo para feeds gigantes — evita problemas de memória ao iterar
# stop_times.txt (que pode ter milhões de linhas em feeds nacionais).
MAX_STOPTIMES_ROWS = 500_000


def parse_gtfs_zip(file_bytes):
    """Processa um ZIP GTFS e devolve ``(payload, status_code)``.

    Em sucesso: ``({'routes': [...], 'total_routes': n, 'total_stops': m,
    'skipped_stops': k}, 200)``.
    Em erro de validação: ``({'error': '...'}, 400)``.
    Em erro inesperado: ``({'error': '...'}, 500)``.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            names = zf.namelist()

            def read_gtfs_csv(fname):
                for n in names:
                    if n.endswith(fname):
                        with zf.open(n) as f:
                            text = f.read().decode('utf-8-sig')
                        return list(csv.DictReader(io.StringIO(text)))
                return []

            routes_rows    = read_gtfs_csv('routes.txt')
            trips_rows     = read_gtfs_csv('trips.txt')
            stoptimes_rows = read_gtfs_csv('stop_times.txt')
            stops_rows     = read_gtfs_csv('stops.txt')

        if not (routes_rows and trips_rows and stoptimes_rows and stops_rows):
            return {"error": "Ficheiro GTFS incompleto — routes/trips/stop_times/stops em falta"}, 400

        # route_id → {name, color}
        route_info = {}
        for r in routes_rows:
            rid = r.get('route_id', '').strip()
            if not rid:
                continue
            name = (r.get('route_short_name') or r.get('route_long_name') or rid).strip()
            raw_color = r.get('route_color', '').strip()
            color = '#' + raw_color if raw_color and len(raw_color) == 6 else None
            route_info[rid] = {'name': name, 'color': color}

        # trip_id → route_id
        trip_to_route = {}
        for t in trips_rows:
            tid = t.get('trip_id', '').strip()
            rid = t.get('route_id', '').strip()
            if tid and rid:
                trip_to_route[tid] = rid

        # Contagem de viagens por (stop_id, route_id) — limitada a MAX_STOPTIMES_ROWS.
        stop_route_counts = {}
        for i, st in enumerate(stoptimes_rows):
            if i >= MAX_STOPTIMES_ROWS:
                break
            sid = st.get('stop_id', '').strip()
            tid = st.get('trip_id', '').strip()
            rid = trip_to_route.get(tid)
            if not sid or not rid:
                continue
            if sid not in stop_route_counts:
                stop_route_counts[sid] = {}
            stop_route_counts[sid][rid] = stop_route_counts[sid].get(rid, 0) + 1

        # Linha "dominante" de cada paragem = a com mais viagens.
        stop_primary_route = {
            sid: max(counts, key=counts.get)
            for sid, counts in stop_route_counts.items()
        }

        # stop_id → {name, lat, lon}
        stops_dict = {}
        for s in stops_rows:
            sid = s.get('stop_id', '').strip()
            try:
                lat = float(s.get('stop_lat', 0))
                lon = float(s.get('stop_lon', 0))
            except (ValueError, TypeError):
                continue
            stops_dict[sid] = {
                'name': (s.get('stop_name') or sid).strip(),
                'lat':  lat,
                'lon':  lon,
            }

        # Agrupa paragens pela linha dominante, aplicando filtro bbox.
        route_stops = {}
        skipped = 0
        for sid, rid in stop_primary_route.items():
            if sid not in stops_dict:
                skipped += 1
                continue
            s = stops_dict[sid]
            if not (LAT_MIN <= s['lat'] <= LAT_MAX and LON_MIN <= s['lon'] <= LON_MAX):
                skipped += 1
                continue
            if rid not in route_stops:
                route_stops[rid] = []
            route_stops[rid].append({
                'stop_id': sid,
                'name':    s['name'],
                'lat':     s['lat'],
                'lng':     s['lon'],
            })

        result_routes = []
        for rid, stop_list in route_stops.items():
            info = route_info.get(rid, {'name': rid, 'color': None})
            result_routes.append({
                'route_id': rid,
                'name':     info['name'],
                'color':    info['color'],
                'stops':    stop_list,
            })
        result_routes.sort(key=lambda r: r['name'])

        total_stops = sum(len(r['stops']) for r in result_routes)
        return {
            'routes':        result_routes,
            'total_routes':  len(result_routes),
            'total_stops':   total_stops,
            'skipped_stops': skipped,
        }, 200

    except zipfile.BadZipFile:
        return {"error": "Ficheiro inválido — não é um ZIP GTFS válido"}, 400
    except Exception as e:
        return {"error": f"Erro ao processar GTFS: {str(e)}"}, 500
