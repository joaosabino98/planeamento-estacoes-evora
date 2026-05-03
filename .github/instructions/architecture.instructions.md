---
description: "Use when modifying server.py, static/app.js, static/index.html, static/style.css, or process_data.py — full architectural reference for the Mobilidade e Território (Évora) TOD planning tool: API contracts, frontend state, population/jobs/isochrone algorithms, Leaflet pane order, design tokens, and known regressions to avoid."
applyTo: "server.py, static/**, process_data.py"
---

# Architecture reference

Detailed technical reference. Read [`copilot-instructions.md`](../copilot-instructions.md) first for the project overview and high-level rules. **Update this file whenever the items it documents change.**

---

## Backend API

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Serves `static/index.html` |
| `/api/census-geojson` | GET | Full census GeoJSON (streamed) |
| `/api/census-metadata` | GET | `{pop_column, total_pop, total_features, bounds, columns}` |
| `/api/config` | GET | Shared client/server constants (`city_total_jobs`, `walking_speed_ms`, `default_ranges_s`, `uncovered_min_pop`) |
| `/api/isochrones` | POST | `{lat, lng, ranges?}` → ORS isochrones (cached on disk keyed by `lat,lng|ranges`; circle fallback never cached; retry on 429/5xx) |
| `/api/population-in-isochrones` | POST | Population calc + uncovered BGRIs (querystring `?uncovered_limit=N` — default 30, max 500) |
| `/api/jobs-in-isochrones` | POST | Overpass POI lookup (10-min in-memory bbox cache), Shannon H, TOD classification |
| `/api/import-gtfs` | POST | Multipart `.zip` GTFS → grouped stops by dominant route |

### `/api/population-in-isochrones`

Request:
```json
{
  "points": [{ "id", "lat", "lng", "group_id", "isochrones": [geojson5min, geojson10min] }],
  "density_overrides": { "<bgriId>": { "densityType": 2, "populationOverride": 340 } },
  "new_urbanization_features": [
    { "type": "Feature", "geometry": {…},
      "properties": { "estimatedPop": 500, "diffuse": true } }
  ]
}
```

Response (extra fields beyond per-point totals):
```json
{
  "total_population_5min": 4200,
  "total_population_10min": 1800,
  "total_population": 6000,
  "points": [{ "id", "population_5min", "population_10min", "population_total" }],
  "groups": [{ "id", "total_population_5min", "total_population_10min", "total_population" }],
  "uncovered_bgris": [
    { "id": "07052500113", "population": 312, "lat": 38.57, "lng": -7.91, "area_ha": 15.2 }
  ]
}
```

**Algorithm (`server.py::calculate_population`):**
1. Reproject census to ORS CRS (EPSG:4326).
2. Apply `density_overrides` per BGRI (replaces `N_INDIVIDUOS`).
3. **"Fill polygon" augment** — for each `new_urbanization_features` polygon, extend each station's `buffer_5min`/`buffer_10min` *inside* the urbanisation, assuming continuous internal road grid. Implemented in `_augment_buffers_with_urbanizations` + `_fill_polygon_for_station` (CRS `EPSG:32629`/UTM 29N, `WALK_SPEED_M_PER_MIN = 83.4`):
   1. If station is inside `urb`: `filled = urb ∩ buffer(station, T·v)`.
   2. Else: `entry = boundary(urb) ∩ buffer_metric`; `t_entry = dist(station, entry) / v`; `t_rest = T − t_entry`; if `t_rest > 0`, `filled = urb ∩ buffer(entry, t_rest·v)`.
   3. Augmented buffer: `buffer_T' = buffer_T ∪ filled` (clipped to the urb so it never leaks outside). Runs **before** unions and population assignment so BGRIs and urbs alike benefit.
4. Per-station population uses **proximity to centroid** to deduplicate overlapping isochrones (Voronoi-like). Implemented in `_assign_population_voronoi(census_subset, point_info, point_populations, get_pop, slot, get_intersection)` — called once for the 5-min ring (`get_intersection = row ∩ buffer_5min`) and once for the secondary 10-min ring (`row ∩ buffer_10min − row ∩ buffer_5min`).
5. Global totals (`total_population_*`) use `union_5min` / `union_10min` to avoid any double-counting.
6. **Urbanisation attribution** — for each `new_urbanization_features` polygon:
   1. Compute `bgri_overlap_pop = Σ pop(bgri) × area(bgri ∩ urb) / area(bgri)` (respecting `density_overrides`).
   2. `net_pop = max(0, estimated_pop − bgri_overlap_pop)` and `d_urb = net_pop / area(urb)` (uniform density, in CENSUS CRS).
   3. Per-station: clip `urb` by the augmented `buffer_5min` and by the station's 10-min ring; resolve overlaps between stations via centroid-distance Voronoi; add `d_urb × area_unique` to `point_populations[id][slot]`.
   4. Global: add `d_urb × area(urb ∩ union_5min)` to `total_pop_5min` and `d_urb × area(urb ∩ secondary_zone)` to `total_pop_10min`. Urbanisations entirely outside any isochrone contribute zero.
   5. Per-group: same intersection done against `gu5` / `gu10` of each group (so a single urb can split between groups proportionally to area).
7. Per-group totals (`groups[]`) use the same union method scoped to each group's stations — the `5+10` sum is ≤ the real population covered by the group, and with a single group it matches the global total exactly.
8. `uncovered_bgris`: BGRIs with no intersection with `union_10min` AND `N_INDIVIDUOS ≥ 50`, sorted desc, top 30.

**Census fields:**
- Population: `N_INDIVIDUOS` (resolved at startup into `POP_COLUMN`)
- ID: `BGRI2021` → `SUBSECCAO` → `OBJECTID` (consistent fallback chain in both ends)
- Area: `SHAPE_Area` (m² in projected CRS — divide by 10 000 for ha)

### `/api/jobs-in-isochrones`

Request: `{ "stations": [{ "id", "isochrone_5min": <Feature> }] }`

Response per station:
```json
{
  "id": "uuid",
  "jobs_total": 420,
  "jobs_breakdown": {
    "commerce": 120, "services": 85, "education_health": 95,
    "culture_leisure": 40, "food_beverage": 60, "industry": 20
  },
  "shannon_h": 0.72,
  "tod_classification": "Centralidade multifuncional",
  "self_sufficiency": 0.58,
  "poi_count": 143,
  "low_coverage_warning": false,
  "pois": [{ "lat", "lng", "category", "name", "jobs", "osm_id" }]
}
```
`osm_id` format is `"{type}_{id}"` (e.g. `"node_123456"`) and is what the frontend uses to dedupe across stations.

**Algorithm:**
1. Build single bbox covering all isochrones (one Overpass query, not one per station).
2. Query `node`/`way`/`relation` with the relevant tags.
3. `classify_poi_tags(el_type, tags) → (category, jobs_estimate)`.
4. Filter by point-in-polygon against each isochrone.
5. Compute `shannon_h` via `compute_shannon_h(residents, breakdown)` → `(h_norm, classification)`.
6. `self_sufficiency = jobs_total / (residents_5min × ACTIVE_POPULATION_RATIO)`; returns `1.0` when `residents = 0` and `jobs > 0` (do **not** revert to `0.0`).
7. `low_coverage_warning = poi_count < 10`.

**Global constants** (server.py, top of file):

| Name | Value | Use |
|---|---|---|
| `RADIUS_5MIN_M` | `417` | Fallback radius (m) when ORS fails — 5 min |
| `RADIUS_10MIN_M` | `833` | Fallback radius (m) when ORS fails — 10 min |
| `METERS_PER_DEGREE` | `111000` | Approximate conversion for circular fallbacks |
| `ACTIVE_POPULATION_RATIO` | `0.45` | Active-population proxy (Évora 2021) |
| `UNCOVERED_MIN_POP` | `50` | Threshold for inclusion in the uncovered-BGRI list |
| `WALKING_SPEED_MS` | `1.39` | ~5 km/h |
| `DEFAULT_RANGES_S` | `[300, 600]` | 5 min, 10 min in seconds |

**`JOBS_PER_HA`** (server.py constants):
```python
{ 'industrial': 20, 'commercial': 40, 'retail': 40 }
```

**`_request_with_backoff(url, *, method, json, data, headers, timeout, retry_status, backoff_base, label)`** — centralised helper for HTTP calls with exponential retry on 429/5xx. Used in `/api/isochrones` (ORS), `/api/jobs-in-isochrones` (Overpass) and any external call. Returns the final `Response` or raises `requests.RequestException`.

**Per-POI estimates** (fallback when not a `landuse` polygon): `commerce=3`, `services=5`, `education_health=15–25`, `culture_leisure=4`, `food_beverage=4`.

**Shannon H classification table:**
| H_norm | jobs/pop | Profile |
|---|---|---|
| ≥ 0.60 | any | Centralidade multifuncional |
| ≥ 0.40 | ≥ 0.20 | Misto equilibrado |
| any | ≥ 0.50 | Nó de emprego |
| ≥ 0.30 | any | Misto desequilibrado |
| < 0.30 | < 0.50 | Dormitório |

### `/api/import-gtfs`

Response: `{ routes: [{ route_id, name, color, stops: [{ stop_id, name, lat, lng }] }], total_routes, total_stops, skipped_stops }`

Algorithm: `routes.txt` → `trips.txt` → `stop_times.txt` (count trips per stop×route, pick dominant route per stop) → `stops.txt` filtered to bbox `lat 38.4–38.7, lon −8.1 to −7.6`. Cap at 500 000 stop_time rows. Auto-assigns colour when `route_color` absent.

### Isochrone disk cache

```python
ISOCHRONE_CACHE_FILE = "data/isochrone_cache.json"
def _isochrone_cache_key(lat, lng): return f"{round(float(lat), 5)},{round(float(lng), 5)}"  # ~1 m
```
- `load_isochrone_cache()` runs at startup.
- `_save_isochrone_cache()` does atomic writes via `tempfile.mkstemp` + `os.replace`.
- Thread-safe via `_isochrone_cache_lock`.
- **Only real ORS results are cached.** Circle fallback never persisted.

---

## Frontend state (`app.js` globals)

```js
// Map
map; activeTab // 'stations' | 'scenario'

// Stations & groups
groups[]                  // [{ id, name, color, visible,
                          //    route: { trunk: LineString|null,
                          //             variants: [{ id, direction: 'outbound'|'inbound', geometry: LineString }] } }]
activeGroupId
stations[]                // [{ id, lat, lng, groupId, name (GTFS|null),
                          //    isochrones[], cachedLat, cachedLng,
                          //    isochroneError, creatingIsochrones,
                          //    population_5min, population_10min, population_total }]
stationMarkers[]; isochroneLayers[]; stationIsochroneLayers{ [stationId]: [layer, layer] }
augmentedIsochroneLayers{ [stationId]: [layer5, layer10] }   // overlay "preenche polígono"
showAugmentedOverlay = true                                  // toggle no painel "Cenário Urbano"
const WALK_SPEED_KM_PER_MIN = 0.0834                         // espelha server.WALK_SPEED_M_PER_MIN

// Routes (per‑group)
groupRouteLayers{}        // { [groupId]: { trunkLayer, variantLayers: { [variantId]: layer } } }
routeDrawHandler          // L.Draw.Polyline ativo (ou null)
isDrawingRoute            // { groupId, kind: 'trunk'|'variant', direction? } | null
editingRoute              // { groupId, kind, variantId?, layer } | null

// City-wide & global stats
const CITY_TOTAL_JOBS = 23674   // hardcoded CME Évora figure
let cityTotalPop = 0            // loaded from /api/census-metadata at initMap (53 577)
globalPopStats                  // { total_population, total_population_5min, _10min, uncovered_bgris[] }

// Isochrone request queue (350 ms gap between real ORS calls)
isochroneQueue[]; isochroneQueueRunning

// Scenario
censusGeoJSON; censusLayer       // pane: 'censusPane', z=200
densityOverrides{}               // { bgriId: { densityType, coverage, populationOverride } }
newUrbanizations[]               // [{ id, name, geometry, densityType, coverage, diffuse, estimatedPop, layers: [poly, label] }]
urbanizationLayers[]
selectedCensusFeature            // { feature, layer } | null
selectedUncoveredLayer; selectedUncoveredBgriId

// Jobs
jobsData{}                       // { stationId: { jobs_total, jobs_breakdown, shannon_h, tod_classification, self_sufficiency, poi_count, pois[] } }
jobsPOILayer; jobsPOIVisible

// Overlap analysis
overlapData{}                    // { stationId: [{ withId, withName, areaFraction, sharedPop }] }

// Drawing
drawControl; drawnItems; isDrawingUrbanization; pendingUrbanizationGeometry

// Undo/redo
historyStack[]; historyIndex; const MAX_HISTORY = 50
```

---

## Key frontend functions

| Function | Purpose |
|---|---|
| `initMap()` | Creates map + custom panes + draw control; loads `cityTotalPop`; wires listeners |
| `switchTab(tab)` | Toggles UI tab; loads/removes census layer |
| `updateMap()` | Rebuilds station markers + isochrones from cache; called after almost any state change |
| `enqueueIsochrone(s)` / `runIsochroneQueue()` | Serialises ORS calls (350 ms gap), then runs `calculatePopulation(false)` → `calculateJobs()` → hide overlay (or show error) |
| `createIsochrones(s, force)` | Fetches via `/api/isochrones`; falls back to circle; returns `true` if served from disk cache |
| `drawCachedIsochrones(s, color)` | Draws from `s.isochrones` without fetching |
| `fillPolygonForStation(stationLngLat, isoFeature, urbFeature, T_min)` | Espelha (turf v6, em km) a função `_fill_polygon_for_station` do servidor. Devolve `Feature<Polygon>` ou `null`. |
| `refreshAugmentedIsochrones()` | Limpa e re-renderiza o overlay "preenche polígono" (camadas tracejadas). Chamado em `confirmUrbanization`, `removeUrbanization`, `calculatePopulation` (após o backend responder) e quando o toggle muda. Subtrai a isócrona ORS para mostrar só a *extensão* adicionada. |
| `calculatePopulation(triggerJobs=true)` | POSTs to backend; updates `globalPopStats`; calls `renderUncoveredBgris()`; with `triggerJobs=false` skips automatic jobs run (queue runner uses this) |
| `calculateJobs()` | POSTs to backend; populates `jobsData`; calls `updateJobsSummary()`, `updateSidebar()`, `computeOverlaps()`, `updateScenarioSummary()` if on scenario tab. Returns `true`/`false`. |
| `updateJobsSummary()` / `updateCoverageCard()` | Updates `#total-jobs`, `#avg-shannon-h`, coverage bars; **dedupes POIs by `osm_id`** |
| `updateSidebar()` | Orchestrator. Delegates to `renderGroupStats()` (per-line cards using server-side union with per-station fallback), `renderStationCard(s, i)` (full card), `renderJobsSection(jd)` (Shannon H + breakdown), `renderOverlapBadges(overlaps)`. |
| `statRow(label, value, opts)` / `tierClass(v, okAt, warnAt)` | Render helpers shared by all sidebar cards. `statRow` builds a `.station-stat-row` (`is-total`/`is-sub` modifiers, optional `valueClass`, escapes by default). `tierClass` returns `'tier-good' \| 'tier-warn' \| 'tier-bad'` (color via design tokens) — used for Shannon H, self-sufficiency, and the `.h-bar-fill` background. |
| `deleteGroup(groupId)` | Deletes the group **and** its stations (with a `confirm()` if any exist); drops matching entries from `isochroneQueue`; `updateMap()` clears orphan layers. Allowed even on the last remaining group: `activeGroupId` becomes `null` and `addStation` will create a fresh group on the next map click (same behaviour as "Limpar estações"). |
| `fetchJSON(url, opts)` | Network helper for GET/POST JSON. Used by `calculatePopulation`, `calculateJobs`, `loadCensusLayer`. Throws `Error` with the server-provided message (`error` field) or `HTTP <status>` on non-OK responses. |
| `computeOverlaps()` | Turf intersect+area between all 5-min isochrone pairs; reports when ≥ 10 % |
| `loadCensusLayer()` | Fetches GeoJSON once; adds to `censusPane`; brings isochrones to front |
| `getCensusStyle(f)` | Choropleth; checks `densityOverrides` first |
| `selectCensusFeature(f, l)` | Highlights BGRI; opens floating edit panel; first calls `clearUncoveredHighlight()` |
| `applyDensityEdit()` / `revertDensityEdit()` / `cancelEdit()` | Edit-panel actions |
| `confirmUrbanization()` | Creates urb object + polygon + label marker; pushes to `newUrbanizations[]` |
| `renameUrbanization(id, name)` | Updates `u.name` and `setIcon()` on `urb.layers[1]` |
| `renderUncoveredBgris()` / `toggleUncoveredBgri(b, el)` / `clearUncoveredHighlight()` | Uncovered BGRI list in scenario tab; orange highlight (`#dd6b20`, weight 3) + `flyTo` |
| `importGTFS(event)` | Wipes state (groups, stations, queue, jobs, overlap), creates new groups+stations, runs queue; uses overlay |
| `saveProject()` / `loadProject(event)` | Single JSON file for full state; does NOT serialise isochrones or jobs. Format `version: '2.1'` (acrescenta `route` por grupo); v2.0 carrega normalmente sem rotas. |
| `renderAllRoutes()` / `renderGroupRoute(g)` | (Re)constrói as polylines do `routePane` para cada grupo a partir de `g.route`; chamadas em `updateMap()`, mudança de cor e visibilidade. |
| `startDrawTrunk(gid)` / `startDrawVariant(gid, dir)` / `finishRouteDrawing(geom)` / `cancelRouteDrawing()` | Fluxo de desenho com `L.Draw.Polyline` em modo livre (sem snap). Bloqueia `addStation` enquanto `isDrawingRoute` está ativo. |
| `startRouteEdit(gid, kind, variantId?)` / `finishRouteEdit(save)` | Edição de vértices via `layer.editing.enable()`; guarda em `g.route.trunk` / `variants[i].geometry`. |
| `deleteRouteTrunk(gid)` / `deleteRouteVariant(gid, vid)` / `removeGroupRouteLayers(gid)` | Apagam geometria e layers do mapa. |
| `getRouteLengthM(g)` / `lineLengthM(geom)` / `formatRouteDistance(m)` | Comprimento operacional = `length(trunk) × 2 + Σ length(variants)` (turf 6, em km → m). Apenas visual; não entra em população nem empregos. |
| `showStationsLoading(msg)` / `update…` / `showStationsLoadingError(msg)` / `hideStationsLoading()` | Stations-tab overlay; locks scroll; error state has retry button |
| `captureMapToImage({bounds, width, height, stationMarkers, isochroneFeatures, labelledDots})` | Off-screen Leaflet map → `html2canvas`; never touches the live map |
| `exportReport()` | Captures overview + uncovered maps; builds HTML report with KPIs, scenario, per-group tables, uncovered section |

---

## Leaflet panes (z-order)

| Pane | z-index | Contents |
|---|---|---|
| `tilePane` (default) | 200 | OSM tiles |
| `censusPane` (custom) | 200 | BGRI choropleth — always below isochrones |
| `overlayPane` (default) | 400 | Isochrone polygons, urbanisation polygons |
| `routePane` (custom) | 350 | Group routes (trunk + variants) — above isochrones, below markers |
| `markerPane` (default) | 600 | Station markers, urbanisation labels |

> Census GeoJSON **must** use `pane: 'censusPane'`. Otherwise it stacks over isochrones.
> Route polylines **must** use `pane: 'routePane'` so they remain visible over isochrones without occluding station markers.

---

## Object shapes

**Urbanisation:**
```js
{
  id: Date.now(),
  name: "Urbanização X",
  geometry: { type: "Polygon", coordinates: […] },
  densityType: 3,                 // index into DENSITY_TYPES[]
  coverage: 40,                   // integer 5–80 (%)
  diffuse: true,
  estimatedPop: Math.round(DENSITY_TYPES[densityType].residents_ha * area_ha * coverage / 100),
  layers: [polygonLayer, labelMarker]   // index 1 must always be the label
}
```

**Density override:**
```js
densityOverrides["150010201001"] = {
  densityType: 4,
  coverage: 60,
  populationOverride: 340
}
```

**Project JSON (save/load):**
```json
{
  "version": "2.0",
  "saved_at": "ISO timestamp",
  "groups": [{ "id", "name", "color", "visible" }],
  "activeGroupId": 123,
  "stations": [{ "id", "lat", "lng", "groupId", "name", "population_5min", "population_10min", "population_total" }],
  "densityOverrides": { "<bgriId>": { "densityType", "coverage", "populationOverride" } },
  "newUrbanizations": [{ "id", "name", "geometry", "densityType", "coverage", "diffuse", "estimatedPop" }]
}
```
`isochrones`, `jobsData`, `overlapData` are **not** serialised — re-fetched/recomputed on load.

---

## Design tokens (`style.css`)

The `:root` block defines all colours, radii, **typography** and spacing. **Never use raw hex/px in rules — always reference variables.** Component CSS must read every `font-size`, `font-weight`, `line-height` and `letter-spacing` from the typography tokens (or use the `.t-*` utility classes); hardcoded type values are a regression.

```css
:root {
  /* Brand */
  --c-primary: #667eea;  --c-primary-dark: #5a6fd6;
  --c-primary-bg: #ebf4ff;  --c-primary-border: #c3dafe;

  /* Semantic: --c-red(/-bg), --c-green(/-bg), --c-orange(/-bg), --c-purple(/-bg) */

  /* Text: --c-text-primary, --c-text-secondary, --c-text-muted, --c-text-disabled */
  /* Surfaces: --c-bg-subtle, --c-bg-hover, --c-border, --c-border-faint */
  /* --radius-sm/md/lg/full | --shadow-xs/sm/md/lg */

  /* Typography (single source of truth) */
  --font-sans / --font-mono                          /* families */
  --font-xxs(10) --font-xs(11) --font-sm(12)
  --font-base(13) --font-md(14) --font-lg(16)
  --font-xl(18) --font-2xl(22) --font-3xl(28)
  --font-h1(19)                                      /* sidebar title */
  --fw-regular(400) --fw-medium(500) --fw-semibold(600)
  --fw-bold(700)   --fw-extrabold(800)
  --lh-tight(1.2) --lh-snug(1.4) --lh-normal(1.55)
  --ls-tight(-0.3px) --ls-wide(0.05em) --ls-wider(0.07em)

  /* --sp-1(4) … --sp-6(24) */
}
```

Typography utility classes (compose on elements instead of redeclaring rules):
`.t-h1` `.t-h2` `.t-h3` `.t-kicker` `.t-body` `.t-body-sm` `.t-caption` `.t-meta`
`.t-metric-lg` `.t-metric` `.t-metric-sm` and `.tabular-nums` (for any column of numbers that should align vertically — uses `font-variant-numeric: tabular-nums`).

Section heading pattern (sidebar `h2`/`h3`):
```css
font-size: var(--font-xs); font-weight: var(--fw-bold);
text-transform: uppercase; letter-spacing: var(--ls-wider);
color: var(--c-text-muted);
```

POI category colours:
```js
const POI_COLORS = {
  commerce: '#ed8936', services: '#3182ce',
  education_health: '#38a169', culture_leisure: '#9f7aea',
  food_beverage: '#e53e3e', industry: '#718096',
};
```

Overlap badges on station cards:
| Class | Range | Icon |
|---|---|---|
| `.overlap-badge.warning` | 10 ≤ x < 40 % | ⚠️ |
| `.overlap-badge.danger` | x ≥ 40 % | ⛔ |

---

## Known fixes — do not regress

### Covered by tests (`tests/`)

These rules have dedicated asserts — just run `pytest -q` to verify. If one fails, that is a regression; **do not change the assert without understanding the cause**.

| Topic | Test(s) | Decision |
|---|---|---|
| Global population dedup | `tests/test_population.py::test_group_total_equals_global_for_single_group` | Globals use `union_5min` / `union_10min` server-side (not per-station sum). |
| Per-group totals via union | `tests/test_population.py::test_group_totals_use_union_not_sum_per_station` | `groups[]` is computed by union scoped to the group's stations; never `Σ pop_5min + Σ pop_10min` per-station. |
| `uncovered_bgris` always present | `tests/test_population.py::test_uncovered_bgris_always_returned` | Endpoint always returns it, with `population ≥ 50`, top 30 (cap `?uncovered_limit=N` up to 500). |
| Density override replaces pop | `tests/test_population.py::test_density_override_replaces_population` | `density_overrides[bgri]` replaces `N_INDIVIDUOS`. |
| Urbanisation enters nearest group's 5 min | `tests/test_population.py::test_urbanization_adds_population_to_5min` | Urbanisation pop → 5 min of overlapping station(s), distributed by area of `urb ∩ buffer_5min`. |
| Urbanisation outside isochrones contributes 0 | `tests/test_population.py::test_urbanization_outside_isochrones_not_counted` | Urb fully outside `union_10min` adds nothing — no centroid-based fallback. |
| Urbanisation deducts overlapping BGRI | `tests/test_population.py::test_urbanization_deducts_existing_bgri_population` | `net_pop = max(0, estimated_pop − Σ pop(bgri) × overlap_ratio)` (avoids double counting). |
| Fill-polygon heuristic helper | `tests/test_fill_polygon.py` | Pure unit tests for `_fill_polygon_for_station` covering: empty when not touched, full fill for small urbs, partial fill for long urbs, station inside urb, t_rest=0 edge, 10 min > 5 min. |
| Fill-polygon extends adjacent urb | `tests/test_population.py::test_fill_polygon_extends_catchment_into_adjacent_urb` | An urb adjacent to (but mostly outside) the buffer still receives substantial pop attribution thanks to the augment. |
| Fill-polygon does not leak | `tests/test_population.py::test_fill_polygon_does_not_leak_outside_urb` | A far urb with augment enabled doesn't perturb the base population (fill is empty when entry is empty). |
| Shannon H with `residents=0` | `tests/test_shannon.py::test_residents_zero_with_jobs_classifies_as_employment_node` | `compute_shannon_h(0, jobs>0)` → ratio=1.0; `self_sufficiency=1.0` (not 0). |
| `self_sufficiency=1.0` when `residents=0` | `tests/test_endpoints.py::test_jobs_endpoint_self_sufficiency_one_when_residents_zero` | Same, at the endpoint. |
| Fallback never cached | `tests/test_endpoints.py::test_isochrones_fallback_is_not_cached` | Only real ORS results enter `data/isochrone_cache.json`. |
| ORS cache hit | `tests/test_endpoints.py::test_isochrones_uses_cache_when_available` | Returns `from_cache=True` without hitting ORS. |
| Isochrone cache key includes ranges | `tests/test_cache_key.py::test_different_ranges_yield_different_keys` | `lat,lng|r1,r2`; `[300,600]` ≠ `[420,840]`. |
| GTFS dominant route + bbox filter | `tests/test_gtfs.py::test_minimal_gtfs_groups_stops_by_dominant_route` | Stop assigned to the route with the most trips; filter lat 38.4–38.7, lon −8.1 to −7.6. |
| Config endpoint exposed | `tests/test_endpoints.py::test_config_endpoint_returns_constants` | `/api/config` returns `CITY_TOTAL_JOBS`, `WALKING_SPEED_MS`, `DEFAULT_RANGES_S`, `UNCOVERED_MIN_POP`. |

### Without automated coverage (frontend / CSS / UI / infra)

| Topic | Decision |
|---|---|
| Census layer pane | Always `pane: 'censusPane'` (z=200). Bring isochrones to front after adding. |
| Route pane | Group routes (trunk + variants) **must** use `pane: 'routePane'` (z=350). Não pintar para `overlayPane` (esconder-se-iam atrás das isócronas) nem para `markerPane` (cobririam os pins). |
| Routes são puramente visuais | `group.route.{trunk,variants}` não entram em `calculatePopulation`, `calculateJobs` nem `computeOverlaps`. As paragens não têm de coincidir com a geometria — o pin define o catchment, a rota descreve só o percurso. |
| Comprimento operacional da rota | `length(trunk) × 2 + Σ length(variants)` (`getRouteLengthM`). O tronco é bidirecional (×2); as variantes são unidirecionais (×1). |
| Modo de desenho da rota | Apenas livre (`L.Draw.Polyline` sem snap). `addStation` é bloqueado enquanto `isDrawingRoute` está ativo. ESC cancela desenho ou edição em curso (antes de chamar `cancelEdit`). |
| Versão do projeto JSON | `saveProject` escreve `version: '2.1'` com `route` por grupo; `loadProject` aceita também `2.0` (sem rotas) sem migração. Mexer no formato implica bumpar a versão e atualizar a migração. |
| No floors input | Formula is `residents_ha × area_ha × coverage/100`. |
| Edit panel floats | `position:fixed; bottom:24px; right:24px`; opacity/transform toggle. ESC, ✕, empty-map click close it. |
| No CSV in UI | Single JSON for save/load. Endpoints exist but are unused. |
| Isochrone queue is the only flow | `enqueue → run → calculatePopulation(false) → calculateJobs() → hide/error`. Don't bypass. |
| Per-station population (frontend) | Voronoi/proximity to the centroid. Individual cards must not sum 5+10 across stations. |
| Jobs dedup (frontend, coverage card) | `osm_id` Map-based dedup; naive-sum fallback only when `osm_id` is missing. |
| GTFS replaces, not adds | `importGTFS` clears `stations`, `groups`, `activeGroupId`, queue, overlap, jobs first; calls `saveState()` before. |
| Urbanisation label always at `layers[1]` | Use `setIcon(L.divIcon({…}))` to rename — don't remove/re-add. |
| BGRI ID resolution order | `BGRI2021` → `SUBSECCAO` → `OBJECTID`. Both ends. |
| ΔH in scenario summary | Uses local `shannonH()` helper with area × `JOBS_PER_HA`; does NOT read live `jobsData`. |
| Overpass bbox | One union bbox covering all isochrones — never one query per station. |
| `name` on stations | `null` for manual stops; GTFS stop name when imported. Serialised. |
| Map capture isolation | `captureMapToImage` always uses an off-screen container; never `invalidateSize` or hide layers on the live map. |
| Loading overlay sequence | `showStationsLoading` → enqueue → `runIsochroneQueue` (also handles `calculatePopulation(false)` + `calculateJobs()`) → `hide` or `showError`. The retry button re-runs `calculateJobs()` only. |
| Coverage card | `cityTotalPop` (53 577) loaded once from `/api/census-metadata`; `CITY_TOTAL_JOBS` (23 674) is a hardcoded constant. Coverage uses `total_population_5min` (not 5+10). |
| CSS design tokens | Use `:root` variables; never hardcode hex/radii/font/spacing. |
| `debug=False` by default | Gated by `FLASK_DEBUG=1`. Do not reintroduce an unconditional `app.run(debug=True)`. |
| `toast()` for notifications | `alert()` only for blocking errors. |

---

## Maintenance

When you change anything in this file's scope, update this file in the same patch. The companion file `.github/copilot-instructions.md` lists the categories of change that warrant an update. **A stale architecture file is more dangerous than no file at all** — it teaches future sessions to make wrong assumptions.
