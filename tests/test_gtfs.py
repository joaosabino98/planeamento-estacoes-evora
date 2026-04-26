"""Testes da rota `/api/import-gtfs`.

Constroi um ZIP GTFS mínimo em memória para evitar dependências de
ficheiros externos.
"""
import io
import zipfile


def _build_gtfs_zip(routes_csv, trips_csv, stop_times_csv, stops_csv):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("routes.txt", routes_csv)
        zf.writestr("trips.txt", trips_csv)
        zf.writestr("stop_times.txt", stop_times_csv)
        zf.writestr("stops.txt", stops_csv)
    buf.seek(0)
    return buf


def test_invalid_zip_returns_400(client):
    res = client.post(
        "/api/import-gtfs",
        data={"file": (io.BytesIO(b"not a zip"), "x.zip")},
        content_type="multipart/form-data",
    )
    assert res.status_code == 400


def test_no_file_returns_400(client):
    res = client.post(
        "/api/import-gtfs",
        data={},
        content_type="multipart/form-data",
    )
    assert res.status_code == 400


def test_minimal_gtfs_groups_stops_by_dominant_route(client):
    """Stop S1 tem 2 trips na rota R1 e 1 trip na R2 → fica atribuído a R1."""
    routes = (
        "route_id,route_short_name,route_color\n"
        "R1,Linha A,FF0000\n"
        "R2,Linha B,\n"
    )
    trips = (
        "route_id,trip_id\n"
        "R1,T1\n"
        "R1,T2\n"
        "R2,T3\n"
    )
    stop_times = (
        "trip_id,stop_id,stop_sequence\n"
        "T1,S1,1\n"
        "T2,S1,1\n"
        "T3,S1,1\n"
        "T1,S2,2\n"
        "T1,S3,3\n"   # S3 aparece para ter rota atribuída e ser filtrada por bbox
    )
    # Évora bbox: lat 38.4–38.7, lon −8.1 to −7.6
    stops = (
        "stop_id,stop_name,stop_lat,stop_lon\n"
        "S1,Paragem A,38.5667,-7.9075\n"
        "S2,Paragem B,38.5680,-7.9050\n"
        "S3,Fora,40.0000,-8.5000\n"  # fora do bbox de Évora
    )

    zf = _build_gtfs_zip(routes, trips, stop_times, stops)
    res = client.post(
        "/api/import-gtfs",
        data={"file": (zf, "gtfs.zip")},
        content_type="multipart/form-data",
    )
    assert res.status_code == 200, res.data
    data = res.get_json()

    # R2 fica sem stops (S1 vai para R1 por dominância) → endpoint só devolve R1
    assert data["total_routes"] == 1
    # S3 está fora de Évora → tem de ser saltado
    assert data["skipped_stops"] >= 1
    r1 = next(r for r in data["routes"] if r["route_id"] == "R1")
    # S1 está em ambas as rotas mas predominante em R1
    assert any(s["stop_id"] == "S1" for s in r1["stops"])
    assert r1["color"] == "#FF0000"
    # S2 só aparece em R1
    assert any(s["stop_id"] == "S2" for s in r1["stops"])


def test_gtfs_missing_required_file_returns_400(client):
    """Sem stops.txt o GTFS é incompleto → 400."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("routes.txt", "route_id\nR1\n")
        zf.writestr("trips.txt", "route_id,trip_id\nR1,T1\n")
        zf.writestr("stop_times.txt", "trip_id,stop_id,stop_sequence\nT1,S1,1\n")
    buf.seek(0)

    res = client.post(
        "/api/import-gtfs",
        data={"file": (buf, "gtfs.zip")},
        content_type="multipart/form-data",
    )
    assert res.status_code == 400
