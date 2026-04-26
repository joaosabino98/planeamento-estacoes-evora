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
  "points": [{ "id", "lat", "lng", "isochrones": [geojson5min, geojson10min] }],
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
  "uncovered_bgris": [
    { "id": "07052500113", "population": 312, "lat": 38.57, "lng": -7.91, "area_ha": 15.2 }
  ]
}
```

**Algorithm (`server.py::calculate_population`):**
1. Reproject census to ORS CRS (EPSG:4326).
2. Apply `density_overrides` per BGRI (replaces `N_INDIVIDUOS`).
3. Compute `urb_union` = union of all urbanisation polygons.
4. Subtract `urb_union` from census intersections **before** attributing pop (replacement, not additive).
5. Distribute urbanisation `estimatedPop` to isochrones proportionally by overlap fraction.
6. Per-station population uses **proximity to centroid** to deduplicate overlapping isochrones (Voronoi-like).
7. Global totals (`total_population_*`) use `union_5min` / `union_10min` to avoid any double-counting.
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
6. `self_sufficiency = jobs_total / (residents_5min × 0.45)`; returns `1.0` when `residents = 0` and `jobs > 0` (do **not** revert to `0.0`).
7. `low_coverage_warning = poi_count < 10`.

**`JOBS_PER_HA`** (server.py constants):
```python
{ 'industrial': 20, 'commercial': 40, 'retail': 40 }
```

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
groups[]                  // [{ id, name, color, visible }]
activeGroupId
stations[]                // [{ id, lat, lng, groupId, name (GTFS|null),
                          //    isochrones[], cachedLat, cachedLng,
                          //    isochroneError, creatingIsochrones,
                          //    population_5min, population_10min, population_total }]
stationMarkers[]; isochroneLayers[]; stationIsochroneLayers{ [stationId]: [layer, layer] }

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
| `calculatePopulation(triggerJobs=true)` | POSTs to backend; updates `globalPopStats`; calls `renderUncoveredBgris()`; with `triggerJobs=false` skips automatic jobs run (queue runner uses this) |
| `calculateJobs()` | POSTs to backend; populates `jobsData`; calls `updateJobsSummary()`, `updateSidebar()`, `computeOverlaps()`, `updateScenarioSummary()` if on scenario tab. Returns `true`/`false`. |
| `updateJobsSummary()` / `updateCoverageCard()` | Updates `#total-jobs`, `#avg-shannon-h`, coverage bars; **dedupes POIs by `osm_id`** |
| `computeOverlaps()` | Turf intersect+area between all 5-min isochrone pairs; reports when ≥ 10 % |
| `loadCensusLayer()` | Fetches GeoJSON once; adds to `censusPane`; brings isochrones to front |
| `getCensusStyle(f)` | Choropleth; checks `densityOverrides` first |
| `selectCensusFeature(f, l)` | Highlights BGRI; opens floating edit panel; first calls `clearUncoveredHighlight()` |
| `applyDensityEdit()` / `revertDensityEdit()` / `cancelEdit()` | Edit-panel actions |
| `confirmUrbanization()` | Creates urb object + polygon + label marker; pushes to `newUrbanizations[]` |
| `renameUrbanization(id, name)` | Updates `u.name` and `setIcon()` on `urb.layers[1]` |
| `renderUncoveredBgris()` / `toggleUncoveredBgri(b, el)` / `clearUncoveredHighlight()` | Uncovered BGRI list in scenario tab; orange highlight (`#dd6b20`, weight 3) + `flyTo` |
| `importGTFS(event)` | Wipes state (groups, stations, queue, jobs, overlap), creates new groups+stations, runs queue; uses overlay |
| `saveProject()` / `loadProject(event)` | Single JSON file for full state; does NOT serialise isochrones or jobs |
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
| `markerPane` (default) | 600 | Station markers, urbanisation labels |

> Census GeoJSON **must** use `pane: 'censusPane'`. Otherwise it stacks over isochrones.

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

The `:root` block defines all colours, radii, font sizes and spacing. **Never use raw hex/px in rules — always reference variables.**

```css
:root {
  /* Brand */
  --c-primary: #667eea;  --c-primary-dark: #5a6fd6;
  --c-primary-bg: #ebf4ff;  --c-primary-border: #c3dafe;

  /* Semantic: --c-red(/-bg), --c-green(/-bg), --c-orange(/-bg), --c-purple(/-bg) */

  /* Text: --c-text-primary, --c-text-secondary, --c-text-muted, --c-text-disabled */
  /* Surfaces: --c-bg-subtle, --c-bg-hover, --c-border, --c-border-faint */
  /* --radius-sm/md/lg/full | --shadow-xs/sm/md/lg */
  /* --font-xs(11) … --font-2xl(28) | --sp-1(4) … --sp-6(24) */
}
```

Section heading pattern (sidebar `h2`/`h3`):
```css
font-size: var(--font-xs); font-weight: 700;
text-transform: uppercase; letter-spacing: 0.07em;
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

| Topic | Decision |
|---|---|
| Census layer pane | Always `pane: 'censusPane'` (z=200). Bring isochrones to front after adding. |
| Urbanisation pop is replacement | Backend subtracts `urb_union` before attributing census pop. |
| No floors input | Formula is `residents_ha × area_ha × coverage/100`. |
| Edit panel floats | `position:fixed; bottom:24px; right:24px`; opacity/transform toggle. ESC, ✕, empty-map click close it. |
| No CSV in UI | Single JSON for save/load. Endpoints exist but are unused. |
| Fallback never cached | Only real ORS results enter `data/isochrone_cache.json`. |
| Isochrone queue is the only flow | `enqueue → run → calculatePopulation(false) → calculateJobs() → hide/error`. Don't bypass. |
| Population dedup | Per-station: proximity-to-centroid. Global: server-side `union_5min/10min`. |
| Jobs dedup (global) | `osm_id` Map-based dedup; falls back to naive sum if missing. |
| Shannon H with `residents=0` | Returns `1.0` ratio when `jobs > 0` — same for `self_sufficiency`. |
| GTFS replaces, not adds | `importGTFS` clears `stations`, `groups`, `activeGroupId`, queue, overlap, jobs first; calls `saveState()` before. |
| Urbanisation label always at `layers[1]` | Use `setIcon(L.divIcon({className:'', iconSize:null, …}))` to rename — don't remove/re-add. |
| BGRI ID resolution order | `BGRI2021` → `SUBSECCAO` → `OBJECTID`. Both ends. |
| ΔH in scenario summary | Uses local `shannonH()` helper with area × `JOBS_PER_HA`; does NOT read live `jobsData`. |
| Overpass bbox | One union bbox covering all isochrones — never one query per station. |
| `name` on stations | `null` for manual stops; GTFS stop name when imported. Serialised. |
| Map capture isolation | `captureMapToImage` always uses an off-screen container; never `invalidateSize` or hide layers on the live map. |
| Loading overlay sequence | `showStationsLoading` → enqueue → `runIsochroneQueue` (also handles `calculatePopulation(false)` + `calculateJobs()`) → `hide` or `showError`. The retry button re-runs `calculateJobs()` only. |
| Coverage card | `cityTotalPop` (53 577) loaded once from `/api/census-metadata`; `CITY_TOTAL_JOBS` (23 674) is a hardcoded constant. |
| Uncovered BGRI threshold | pop ≥ 50, top 30, sorted desc, returned by population endpoint and rendered in scenario tab + report. |

---

## Maintenance

When you change anything in this file's scope, update this file in the same patch. The companion file `.github/copilot-instructions.md` lists the categories of change that warrant an update. **A stale architecture file is more dangerous than no file at all** — it teaches future sessions to make wrong assumptions.
