# Mobilidade e Território (Évora) — agent instructions

Always-on context for AI coding work in this repository.

## Project at a glance

Web tool for **Transit-Oriented Development planning in Évora**. A Flask + GeoPandas backend serves Portuguese census data (BGRI 2021) and computes 5/10 min walking isochrones via OpenRouteService. A vanilla-JS Leaflet frontend lets the user place transit stops grouped by line, view catchments, edit BGRI density, draw new urbanisations, import GTFS feeds, see employment from OSM Overpass POIs (with a Shannon mix-of-uses index), and export a printable coverage report.

## Repository map

| Path | Role |
|---|---|
| `server.py` | Flask API (~1 200 lines): isochrones, population, jobs, GTFS, exports |
| `static/app.js` | Client logic (~2 500 lines): map, state, all features |
| `static/index.html` / `style.css` | UI structure and design system |
| `process_data.py` | One-shot: BGRI `.gpkg` → `data/census_data.geojson` + metadata |
| `data/census_data.geojson` | Pre-processed BGRI polygons (1 667 subsections, EPSG:4326) |
| `data/isochrone_cache.json` | Persisted ORS results (auto-created, gitignored) |
| `BGRI2021_0705/` | Raw INE census data (do not modify) |

For the **detailed architectural reference** (API contracts, state shape, algorithms, function index, design tokens) see [`.github/instructions/architecture.instructions.md`](./instructions/architecture.instructions.md). It is attached automatically when editing source files.

## Language

- All UI strings, comments and user-facing messages are in **European Portuguese**.
- Code identifiers (variables, functions) are in **English**.
- When chatting with the user, respond in Portuguese unless they switch.

## Run locally

```bash
source venv/bin/activate && python3 server.py   # http://localhost:5000
lsof -ti:5000 | xargs kill -9 2>/dev/null       # if port busy
```
ORS API key lives in `.env` (`ORS_API_KEY=…`). Census data must be pre-processed once with `python3 process_data.py`.

## Critical rules — do not regress

These are decisions made deliberately after debugging. Read the full reasoning in the architecture file before changing.

1. **Census layer pane** — always add the BGRI GeoJSON to the custom `censusPane` (z-index 200), never the default `overlayPane`. After adding, call `isochroneLayers.forEach(l => l.bringToFront())`.
2. **Urbanisation population is replacement, not additive** — backend subtracts `urb_union` from census intersections before attributing population.
3. **No floors slider** — urbanisation population formula is exactly `residents_ha × area_ha × (coverage / 100)`. Do not reintroduce a floors factor.
4. **Edit panel is floating** (`position:fixed`), not inside the sidebar. Visibility toggled via `opacity`/`transform`, not `display:none`. Closes on ESC, ✕ button, or empty map click.
5. **No CSV import/export** — project state is one JSON file (`saveProject`/`loadProject`). Do not re-add CSV buttons or routes.
6. **Isochrone fallback (circles) is never cached** — only real ORS results go into `data/isochrone_cache.json`.
7. **Isochrone queue serialises ORS calls** with 350 ms gap. The queue runner is the only path that drives the sequence isochrones → `calculatePopulation(false)` → `calculateJobs()` → `hideStationsLoading()`. Do not call `calculatePopulation()` directly when stations are still missing isochrones.
8. **Global totals deduplicate by union (population) and `osm_id` (jobs)** — per-station values use Voronoi/proximity. Never use simple summation for globals shown in the coverage card or report.
9. **`uncovered_bgris` and Shannon H** — backend always returns `uncovered_bgris` on the population endpoint; `compute_shannon_h()` returns `ratio = 1.0` when `residents = 0` and `jobs > 0` (employment hubs are not "dormitories").
10. **CSS uses design tokens** — never hardcode hex colours, radii, font sizes or spacing in rules; always reference the `:root` variables defined at the top of `style.css`.

## Keep these instructions accurate

**Whenever you change project structure, public APIs, state shape, algorithms, or a "do not regress" rule, update `.github/copilot-instructions.md` and `.github/instructions/architecture.instructions.md` in the same change.** A stale instruction file is worse than none — it teaches the next session to make wrong assumptions.

Trigger an update when any of the following change:
- A Flask route is added, removed, or its payload changes
- A top-level state variable in `app.js` is added, renamed or changes shape
- A function listed in the architecture file is added, removed or renamed
- The population, jobs, Shannon H, or coverage algorithm changes
- A new file or folder is added at the top level
- A bug is fixed in a way that future agents could undo (add it to "do not regress")

If you make such a change without updating the docs, mention it explicitly in your reply.
