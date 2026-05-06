# Mobilidade e Território (Évora) — agent instructions

Always-on context for AI coding work in this repository.

## Project at a glance

Web tool for **Transit-Oriented Development planning in Évora**. A Flask + GeoPandas backend serves Portuguese census data (BGRI 2021) and computes 5/10 min walking isochrones via OpenRouteService. A vanilla-JS Leaflet frontend lets the user place transit stops grouped by line, view catchments, edit BGRI density, draw new urbanisations, import GTFS feeds, see employment from OSM Overpass POIs (with a Shannon mix-of-uses index), and export a printable coverage report.

## Repository map

| Path | Role |
|---|---|
| `server.py` | Flask app (~890 lines): app instance, ISOCHRONE/Overpass caches, ORS networking with backoff, route handlers — thin orchestration on top of `server_lib/` |
| `server_lib/` | Pure Python package: `jobs_taxonomy.py` (OSM→category mapping + JOBS_PER_HA), `shannon.py` (compute_shannon_h), `population.py` (WALK_SPEED_M_PER_MIN, fill-polygon heuristic, Voronoi assignment, `compute_population_response`) |
| `static/app.js` | Client logic (~2 500 lines): map, state, all features |
| `static/index.html` / `style.css` | UI structure and design system |
| `process_data.py` | One-shot: BGRI `.gpkg` → `data/census_data.geojson` + metadata |
| `tests/` | pytest suite (backend only) — run with `pytest -q` |
| `data/census_data.geojson` | Pre-processed BGRI polygons (1 667 subsections, EPSG:4326) |
| `data/isochrone_cache.json` | Persisted ORS results (auto-created, gitignored) |
| `BGRI2021_0705/` | Raw INE census data (do not modify) |

For the **detailed architectural reference** (API contracts, state shape, algorithms, function index, design tokens) see [`.github/instructions/architecture.instructions.md`](./instructions/architecture.instructions.md). It is attached automatically when editing source files.

## Language

- All UI strings, in-code comments and user-facing messages are in **European Portuguese**.
- Code identifiers (variables, functions, file names) are in **English**.
- The **`README.md`** is written in **European Portuguese** (it targets end users).
- All files under **`.github/`** — including `copilot-instructions.md` and every `*.instructions.md`, `*.prompt.md`, `SKILL.md`, `AGENTS.md` and YAML frontmatter — are written in **English**, except for technical proper nouns (e.g. `Mobilidade e Território`, `Évora`, `Cenário Urbano` when referring to the UI tab) and quoted UI strings shown to the user. Mixing languages in instruction files makes them harder to scan and is treated as a regression.
- When chatting with the user, respond in Portuguese unless they switch.

## Run locally

```bash
source venv/bin/activate && python3 server.py   # http://localhost:5000
lsof -ti:5000 | xargs kill -9 2>/dev/null       # if port busy
```
ORS API key lives in `.env` (`ORS_API_KEY=…`). Census data must be pre-processed once with `python3 process_data.py`.

## Tests

Backend has a pytest suite in `tests/` (~39 tests, ~1.5 s). It guards the server's "do not regress" rules: Shannon H, POI classification, isochrone cache key, population-route snapshot (against the real BGRI 2021 data), GTFS import and HTTP endpoints (including that the circular fallback is never cached).

```bash
source venv/bin/activate && pytest -q          # full suite
pytest tests/test_population.py -v             # single file
pip install -r requirements-dev.txt            # install test deps
```

There are no frontend tests and no CI configured — run the suite locally before each relevant commit.

## Workflow at the end of every implementation or code change

Whenever you finish a non-trivial change (refactor, fix, new feature):

1. **Hunt for latent bugs or dead code** introduced by the change and remove/fix them (unused variables, unreachable branches, orphan imports, helpers that lost their callers).
2. **Write or update tests** if the change touches logic that is covered — or should be covered — by `tests/`. Every new "do not regress" rule must translate into a test.
3. **Run `pytest -q`** and confirm everything is green. Do not commit with red tests.
4. **Validate that the server starts** (`python3 server.py`) and run a quick smoke test (e.g. `curl /api/config`) to make sure there are no import errors or 500s on basic routes.
5. **Update `.github/copilot-instructions.md`, `.github/instructions/architecture.instructions.md` and `README.md`** when applicable (see "Keep these instructions accurate" below).

## Critical rules — do not regress

Most **backend** rules are already guarded by tests in `tests/` — just run `pytest -q` to verify (e.g. union in `groups[]`, fallback never cached, ranges in the cache key, Shannon ratio=1 when `residents=0`, `uncovered_bgris` always present, urbanisation replacement). **If a test fails, that is a regression; do not "fix" it by changing the assert without understanding why.**

The list below covers only decisions **without automated coverage** (frontend, CSS, infra, UI/product). See [`architecture.instructions.md`](./instructions/architecture.instructions.md) for full reasoning.

1. **Census layer pane** — add the BGRI GeoJSON to `censusPane` (z-index 200), never to `overlayPane`. After adding, call `isochroneLayers.forEach(l => l.bringToFront())`.
1.1. **Route pane** — group routes (`group.route.{trunk,variants}`) must always be drawn on `routePane` (z-index 450, between `overlayPane` 400 and `shadowPane` 500). Do not fall back to `overlayPane` (they would hide behind isochrones) or `markerPane` (they would cover the pins). Each route is rendered as a translucent white casing (`weight + 4`, opacity 0.55) followed by the coloured line.
1.2. **Routes are visual only** — `group.route` does not enter `calculatePopulation()`, `calculateJobs()` or `computeOverlaps()`. Stops do not have to touch the route geometry (the pin defines the catchment; the route only describes the path). Operational length = `length(trunk) × 2 + Σ length(variants)`.
2. **No floors slider** — urbanisation population is exactly `residents_ha × area_ha × (coverage / 100)`. Do not reintroduce a floors factor.
3. **Edit panel is floating** (`position:fixed`), not inside the sidebar. Visibility is toggled via `opacity`/`transform`, not `display:none`. Closes on ESC, ✕, or empty-map click.
4. **No CSV import/export** — the project is a single JSON file (`saveProject`/`loadProject`). Do not reintroduce CSV buttons.
5. **Isochrone queue** serialises ORS calls with a 350 ms gap. The queue runner is the only path that orchestrates `isochrones → calculatePopulation(false) → calculateJobs() → hideStationsLoading()`. Do not call `calculatePopulation()` directly while stations still lack isochrones.
6. **CSS uses design tokens** — never hardcode hex/radii/font-size/font-weight/line-height/letter-spacing/spacing. Use the `:root` variables defined in `style.css` (including the typography scale: `--font-xxs…--font-3xl`, `--font-h1`, `--fw-regular…--fw-extrabold`, `--lh-tight/--lh-snug/--lh-normal`, `--ls-tight/--ls-wide/--ls-wider`) or the `.t-*` utility classes. Numeric columns (metric values in cards, summary tables, station stats) must use `font-variant-numeric: tabular-nums` (`.tabular-nums` helper) so digits align vertically.
7. **"Covered population" is always 5 min** — both the coverage card and the report use `total_population_5min` (not 5+10) divided by `cityTotalPop`.
8. **Server runs with `debug=False` by default** — gated by `FLASK_DEBUG=1`. Do not reintroduce an unconditional `app.run(debug=True)` (it exposes the Werkzeug debugger).
9. **`toast(msg, type)` for non-blocking notifications** — `alert(...)` is reserved for hard errors. Prefer toast for confirmations, GTFS results, recalc done, etc.
10. **Globals/per-station population** — per-station uses Voronoi/proximity to the centroid; globals and per-group use union. Aggregated totals (coverage card, report, `groups[]`) **never** sum `population_5min + population_10min` per station. *(The backend side is covered by `tests/test_population.py`; the per-station calculation in the frontend — e.g. individual cards — is not, hence it stays listed.)*
11. **"Fill polygon" walking speed must match on both ends** — `WALK_SPEED_M_PER_MIN` on the server (`server.py`) and `WALK_SPEED_KM_PER_MIN` on the client (`static/app.js`) represent the same pedestrian speed (5 km/h ≈ 83.4 m/min, derived from `RADIUS_5MIN_M / 5`). Changing one without the other introduces visible discrepancies between what the user sees on the map and the numbers shown in the cards.

## Keep these instructions accurate

**Whenever you change project structure, public APIs, state shape, algorithms, or a "do not regress" rule, update `.github/copilot-instructions.md`, `.github/instructions/architecture.instructions.md` and `README.md` in the same change.** A stale instruction file is worse than none — it teaches the next session to make wrong assumptions, and a stale README misleads users.

Trigger an update when any of the following change:
- A Flask route is added, removed, or its payload changes
- A top-level state variable in `app.js` is added, renamed or changes shape
- A function listed in the architecture file is added, removed or renamed
- The population, jobs, Shannon H, or coverage algorithm changes
- A new file or folder is added at the top level
- A new environment variable or configuration option is introduced (must appear in the README "Configuração por variáveis de ambiente" table)
- A user-facing feature is added, removed, or changes behaviour (must appear in the README "Funcionalidades" section)
- A bug is fixed in a way that future agents could undo (add it to "do not regress")

If you make such a change without updating all three docs, mention it explicitly in your reply.
