# Agent Context — Mobilidade e Território (TOD Évora)

Quick reference for AI-assisted development. Read this before making changes.

---

## Project in one paragraph

Flask + GeoPandas backend serves census data and computes walking isochrones via OpenRouteService. A Leaflet frontend lets the user place transit stops (grouped, coloured), view 5/10-min walking catchments, inspect census subsections (BGRI), override their density, draw new urbanisation polygons, and compare baseline vs. projected population. The full state (groups, stations, BGRI overrides, urbanisations) is saved/loaded as a single JSON file.

---

## File map

```
server.py             Flask API — isochrones, population calc, CSV export/import
process_data.py       One-time: converts BGRI .gpkg → data/census_data.geojson + metadata.json
static/index.html     UI structure — sidebar tabs, floating edit panel, modals
static/style.css      All styles
static/app.js         All client logic (~1 340 lines)
data/census_data.geojson   Pre-processed BGRI polygons (1 667 subsections)
data/metadata.json         pop_column name and CRS info
BGRI2021_0705/        Raw source data (do not modify)
```

---

## Backend API

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Serves `static/index.html` |
| `/api/census-geojson` | GET | Full census GeoJSON (streamed) |
| `/api/census-metadata` | GET | `{pop_column, total_pop, crs, …}` |
| `/api/isochrones` | POST | `{lat, lng}` → ORS isochrones (fallback: circles) |
| `/api/population-in-isochrones` | POST | Main calc — see below |
| `/api/export-points` | POST | Returns CSV of current stations |
| `/api/import-points` | POST | Multipart CSV → list of points |

### `/api/population-in-isochrones` payload

```json
{
  "points": [{ "id", "lat", "lng", "isochrones": [geojson5min, geojson10min] }],
  "density_overrides": { "<bgriId>": { "densityType": 2, "populationOverride": 340 } },
  "new_urbanization_features": [{ "type": "Feature", "geometry": {…}, "properties": { "estimatedPop": 500, "diffuse": true } }]
}
```

**Population algorithm (server.py `calculate_population`):**
1. Reproject census to ORS CRS (EPSG:4326).
2. For each BGRI, apply `density_overrides` if present (replaces `N_INDIVIDUOS`).
3. Compute `urb_union` — union of all urbanisation polygons.
4. For census intersections, **subtract** `urb_union` before attributing population (replacement semantics — urbanisations do not stack on top of existing census pop).
5. Distribute urbanisation `estimatedPop` to isochrones proportionally by overlap fraction.
6. Deduplicate overlapping isochrones from different stations by proximity to station centroid.

**Key census fields:**
- Population: `N_INDIVIDUOS` (resolved at startup into `POP_COLUMN`)
- ID: `BGRI2021` → fallback `SUBSECCAO` → fallback `OBJECTID`
- Area: `SHAPE_Area` (m²)

---

## Frontend state (app.js globals)

```js
// Map
map                       // Leaflet map instance
activeTab                 // 'stations' | 'scenario'

// Stations & groups
groups[]                  // [{ id, name, color, visible }]
activeGroupId
stations[]                // [{ id, lat, lng, groupId, isochrones[], cachedLat, cachedLng,
                          //    isochroneError, creatingIsochrones,
                          //    population_5min, population_10min, population_total }]
stationMarkers[]          // Leaflet marker instances (rebuilt by updateMap())
isochroneLayers[]         // flat list of all isochrone Leaflet layers
stationIsochroneLayers{}  // { stationId: [layer, layer] }

// Scenario
censusGeoJSON             // raw parsed GeoJSON (kept in memory after first load)
censusLayer               // Leaflet GeoJSON layer (pane: 'censusPane', z=200)
densityOverrides{}        // { bgriId: { densityType, coverage, populationOverride } }
newUrbanizations[]        // [{ id, name, geometry (GeoJSON), densityType, coverage,
                          //    diffuse, estimatedPop, layers: [polygonLayer, labelMarker] }]
urbanizationLayers[]      // flat list of all urbanisation Leaflet layers
selectedCensusFeature     // { feature, layer } | null

// Undo/redo
historyStack[]            // serialised snapshots (max 50)
historyIndex
```

---

## Key frontend functions

| Function | What it does |
|---|---|
| `initMap()` | Creates map, panes, draw control, wires all listeners |
| `switchTab(tab)` | Switches UI tab; loads/removes census layer |
| `updateMap()` | Rebuilds station markers; shows/hides isochrones; called on almost every state change |
| `calculatePopulation()` | POSTs to `/api/population-in-isochrones`; updates sidebar |
| `createIsochrones(station)` | Fetches isochrones; falls back to circles; caches on station object |
| `drawCachedIsochrones(station, color)` | Draws from cache without re-fetching |
| `loadCensusLayer()` | Fetches GeoJSON once, adds to `censusPane`, brings isochrones to front |
| `selectCensusFeature(feature, layer)` | Highlights BGRI, populates floating edit panel |
| `applyDensityEdit()` | Writes to `densityOverrides`, re-styles layer, calls `updateScenarioSummary()` |
| `revertDensityEdit()` | Deletes from `densityOverrides`, restores `getCensusStyle()` |
| `cancelEdit()` | Restores selected layer style, hides panel, clears `selectedCensusFeature` |
| `confirmUrbanization()` | Creates urb object, draws polygon + label marker, pushes to `newUrbanizations[]` |
| `renameUrbanization(id, name)` | Updates `u.name`, calls `setIcon()` on `urb.layers[1]` (label marker) |
| `saveProject()` | Serialises full state to JSON; downloads file |
| `loadProject(event)` | Restores full state including scenario; re-creates visuals |
| `saveState()` / `undo()` / `redo()` | History stack management |
| `getCensusStyle(feature)` | Choropleth style; checks `densityOverrides` first |

---

## Leaflet layer z-order

| Pane | z-index | Contents |
|---|---|---|
| `tilePane` | 200 (default) | Base map tiles |
| `censusPane` (custom) | 200 | BGRI census GeoJSON — always below isochrones |
| `overlayPane` (default) | 400 | Isochrone polygons, urbanisation polygons |
| `markerPane` (default) | 600 | Station markers, urbanisation label markers |

> **Do not add census layer to the default `overlayPane`** — it would sit on top of isochrones when added after them. Always pass `pane: 'censusPane'`.

---

## Urbanisation object shape

```js
{
  id: Date.now(),           // unique numeric ID
  name: "Urbanização X",
  geometry: { type: "Polygon", coordinates: […] },  // GeoJSON geometry
  densityType: 3,           // index into DENSITY_TYPES[]
  coverage: 40,             // integer 5–80 (%)
  diffuse: true,
  estimatedPop: 620,        // Math.round(residents_ha * area_ha * coverage/100)
  layers: [polygonLayer, labelMarker]  // index 0 = polygon, index 1 = label
}
```

Urbanisation `estimatedPop` formula (no floors factor):
```
est = DENSITY_TYPES[densityType].residents_ha × area_ha × (coverage / 100)
```

---

## BGRI override shape

```js
densityOverrides["150010201001"] = {
  densityType: 4,       // index into DENSITY_TYPES[]
  coverage: 60,         // integer (%)
  populationOverride: 340  // precomputed pop sent to backend
}
```

---

## Project JSON schema (save/load)

```json
{
  "version": "2.0",
  "saved_at": "ISO timestamp",
  "groups": [{ "id", "name", "color", "visible" }],
  "activeGroupId": 123,
  "stations": [{ "id", "lat", "lng", "groupId", "population_5min", "population_10min", "population_total" }],
  "densityOverrides": { "<bgriId>": { "densityType", "coverage", "populationOverride" } },
  "newUrbanizations": [{ "id", "name", "geometry", "densityType", "coverage", "diffuse", "estimatedPop" }]
}
```

Note: `isochrones` are **not** serialised — they are re-fetched on next `updateMap()` call after load.

---

## Known fixes / decisions (do not regress)

| Topic | Decision |
|---|---|
| Census layer z-order | Use `pane: 'censusPane'` (z=200). Never add census layer to default `overlayPane`. After loading census, call `isochroneLayers.forEach(l => l.bringToFront())`. |
| Urbanisation pop is replacement, not additive | Backend subtracts `urb_union` from census intersections before attributing; urbanisation pop is then distributed by isochrone overlap fraction. |
| No floors input | Floors slider was removed. Formula is `residents_ha × area_ha × (coverage/100)` only. Do not reintroduce a floors factor. |
| Edit panel is floating | `#edit-panel` is `position:fixed; bottom:24px; right:24px` — it is **not** inside the sidebar. Visibility is toggled via `opacity`+`transform` (not `display:none`) so CSS transitions work. Closes on ESC, map click (empty area), or ✕ button. |
| CSV import/export removed | Project is saved/loaded as a single JSON. The old `/api/export-points` and `/api/import-points` endpoints and their frontend functions were removed. Do not re-add CSV buttons. |
| Urbanisation label marker | Always at `urb.layers[1]`. Use `labelMarker.setIcon(L.divIcon({className:'', iconSize:null, …}))` to rename — do not remove/re-add unless necessary. |
| BGRI ID resolution order | `props.BGRI2021` → `props.SUBSECCAO` → `props.OBJECTID`. Used consistently in both frontend and backend. |
| Population dedup | When isochrones from different stations overlap, population is attributed to the station whose centroid is closest to the overlap centroid. |

---

## Environment

- Python 3.14, venv at `venv/`
- Start: `source venv/bin/activate && python3 server.py`
- Port: 5000
- ORS API key: `.env` file, variable `ORS_API_KEY`
- Census data must be pre-processed with `python3 process_data.py` before first run
