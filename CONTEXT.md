# Agent Context — Mobilidade e Território (Évora — Cobertura Pedonal das Paragens)

Quick reference for AI-assisted development. Read this before making changes.

---

## Project in one paragraph

Flask + GeoPandas backend serves census data and computes walking isochrones via OpenRouteService. A Leaflet frontend lets the user place transit stops (grouped, coloured), view 5/10-min walking catchments (deduplicated — no double-counting between overlapping stations), inspect census subsections (BGRI), override their density, draw new urbanisation polygons, and compare baseline vs. projected population. Population and jobs totals are globalised using union-based geometry (server-side) and osm_id deduplication (client-side) to avoid double-counting across stations. The full state (groups, stations, BGRI overrides, urbanisations) is saved/loaded as a single JSON file. A printable coverage report (HTML → PDF via browser print) is generated client-side.

---

## File map

```
server.py             Flask API — isochrones, population calc, jobs, city coverage
process_data.py       One-time: converts BGRI .gpkg → data/census_data.geojson + metadata.json
static/index.html     UI structure — sidebar tabs, floating edit panel, modals
static/style.css      All styles
static/app.js         All client logic (~2 200 lines)
data/census_data.geojson   Pre-processed BGRI polygons (1 667 subsections, EPSG:4326 / CRS84)
data/metadata.json         pop_column, total_pop (53 577), bounds, column list
data/isochrone_cache.json  Persisted ORS isochrone results (auto-created; never commit)
BGRI2021_0705/        Raw source data (do not modify)
```

---

## Backend API

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Serves `static/index.html` |
| `/api/census-geojson` | GET | Full census GeoJSON (streamed) |
| `/api/census-metadata` | GET | `{pop_column, total_pop, total_features, bounds, columns}` |
| `/api/isochrones` | POST | `{lat, lng}` → ORS isochrones (fallback: circles) |
| `/api/population-in-isochrones` | POST | Main calc — see below |
| `/api/export-points` | POST | Returns CSV of current stations |
| `/api/import-points` | POST | Multipart CSV → list of points |
| `/api/import-gtfs` | POST | Multipart `.zip` GTFS → grouped stops by dominant route, bbox-filtered to Évora |

### `/api/import-gtfs` response

```json
{
  "routes": [{ "route_id", "name", "color", "stops": [{ "stop_id", "name", "lat", "lng" }] }],
  "total_routes": 6,
  "total_stops": 47,
  "skipped_stops": 3
}
```

**Algorithm:** `routes.txt` → `trips.txt` → `stop_times.txt` (count trips per stop×route, pick dominant route per stop) → `stops.txt` with bbox filter (lat 38.4–38.7, lon −8.1 – −7.6). Cap at 500 000 stop_time rows. Fallback color auto-assigned when `route_color` absent.

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
7. Compute `uncovered_bgris` — BGRIs with no intersection with `union_10min` and `N_INDIVIDUOS ≥ 50`, sorted by pop descending, top 30. Added to response.

**Key census fields:**
- Population: `N_INDIVIDUOS` (resolved at startup into `POP_COLUMN`)
- ID: `BGRI2021` → fallback `SUBSECCAO` → fallback `OBJECTID`
- Area: `SHAPE_Area` (m², projected — divide by 10 000 for ha)

**`/api/population-in-isochrones` response (additional fields):**
```json
{
  "total_population_5min": 4200,
  "total_population_10min": 1800,
  "total_population": 6000,
  "points": [ { "id", "lat", "lng", "population_5min", "population_10min", "population_total" } ],
  "uncovered_bgris": [
    { "id": "07052500113", "population": 312, "lat": 38.57, "lng": -7.91, "area_ha": 15.2 }
  ]
}
```
`uncovered_bgris` — sorted descending by population, max 30 entries, pop ≥ 50 threshold.

---

## Frontend state (app.js globals)

```js
// Map
map                       // Leaflet map instance
activeTab                 // 'stations' | 'scenario'

// Stations & groups
groups[]                  // [{ id, name, color, visible }]
activeGroupId
stations[]                // [{ id, lat, lng, groupId, name (GTFS stop name | null),
                          //    isochrones[], cachedLat, cachedLng,
                          //    isochroneError, creatingIsochrones,
                          //    population_5min, population_10min, population_total }]
stationMarkers[]          // Leaflet marker instances (rebuilt by updateMap())
isochroneLayers[]         // flat list of all isochrone Leaflet layers
stationIsochroneLayers{}  // { stationId: [layer, layer] }

// Population (union-based global totals, no double-counting)
globalPopStats            // { total_population, total_population_5min, total_population_10min,
                          //   uncovered_bgris: [{ id, population, lat, lng, area_ha }] }
                          // Populated by calculatePopulation() after server response
                          // Used by exportReport() and updateCoverageCard()

// City-wide totals (coverage card)
const CITY_TOTAL_JOBS = 23674  // CME Évora employment figure (hardcoded constant)
let cityTotalPop = 0           // Loaded from /api/census-metadata at initMap() startup (53 577)

// Isochrone request queue (serialises ORS calls, 350 ms gap between real requests)
isochroneQueue[]          // stations waiting for isochrone fetch
isochroneQueueRunning     // boolean — prevents concurrent queue runs

// Scenario
censusGeoJSON             // raw parsed GeoJSON (kept in memory after first load)
censusLayer               // Leaflet GeoJSON layer (pane: 'censusPane', z=200)
densityOverrides{}        // { bgriId: { densityType, coverage, populationOverride } }
newUrbanizations[]        // [{ id, name, geometry (GeoJSON), densityType, coverage,
                          //    diffuse, estimatedPop, layers: [polygonLayer, labelMarker] }]
urbanizationLayers[]      // flat list of all urbanisation Leaflet layers
selectedCensusFeature     // { feature, layer } | null  — BGRI being edited in the floating panel
selectedUncoveredLayer    // Leaflet layer | null  — BGRI highlighted as uncovered (orange)
selectedUncoveredBgriId   // string | null  — id of the highlighted uncovered BGRI

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
| `calculatePopulation()` | POSTs to `/api/population-in-isochrones`; updates sidebar; populates `globalPopStats` (incl. `uncovered_bgris`) |
| `createIsochrones(station)` | Fetches isochrones; falls back to circles; caches on station object; **returns `true` if served from disk cache** |
| `drawCachedIsochrones(station, color)` | Draws from cache without re-fetching |
| `loadCensusLayer()` | Fetches GeoJSON once, adds to `censusPane`, brings isochrones to front |
| `selectCensusFeature(feature, layer)` | Highlights BGRI, populates floating edit panel |
| `applyDensityEdit()` | Writes to `densityOverrides`, re-styles layer, calls `updateScenarioSummary()` |
| `revertDensityEdit()` | Deletes from `densityOverrides`, restores `getCensusStyle()` |
| `cancelEdit()` | Restores selected layer style, hides panel, clears `selectedCensusFeature` |
| `confirmUrbanization()` | Creates urb object, draws polygon + label marker, pushes to `newUrbanizations[]` |
| `renameUrbanization(id, name)` | Updates `u.name`, calls `setIcon()` on `urb.layers[1]` (label marker) |
| `saveProject()` | Serialises full state to JSON; downloads file |
| `loadProject(event)` | Restores full state including scenario; re-creates visuals; **shows loading overlay** until isochrones + population done |
| `importGTFS(event)` | Parses GTFS zip; creates groups + stations; **shows loading overlay** until isochrones + population done |
| `captureMapToImage(opts)` | **New helper.** Creates a hidden off-screen `<div>`, spins up a second Leaflet map, adds OSM tiles + optional isochrone outlines + station circle markers + numbered dot markers, waits for tiles (up to 2500ms), captures with `html2canvas`, destroys container. Returns `dataURL\|null`. Opts: `{bounds, width, height, stationMarkers[], isochroneFeatures[], labelledDots[]}`. Does NOT touch the live map. |
| `exportReport()` | (1) Calls `captureMapToImage` for overview map (1120×630, station markers + 10-min isochrone outlines, group colours). (2) If `uncoveredList.length > 0`, calls `captureMapToImage` for uncovered map (900×506, numbered red dots at BGRI centroids). Both captures happen **before** HTML building. (3) Builds HTML with: 4-KPI summary, 2-KPI city coverage, scenario section, per-group tables, "Zonas com menor cobertura de paragens" section with map image + table (numbered dots match table rows). |
| `showStationsLoading(msg)` | Shows `#stations-loading-overlay` over the Estações tab; scrolls tab to top; locks overflow to prevent user scrolling past the overlay |
| `updateStationsLoadingMessage(msg)` | Updates the overlay message text (used for progress: `X / N`, then "A calcular população…", then "A calcular empregos…") |
| `showStationsLoadingError(msg)` | Switches the overlay to error state: hides spinner, shows ⚠️ + message + × close button + "Tentar novamente" button; retry re-runs `calculateJobs()` |
| `hideStationsLoading()` | Hides the loading overlay; restores tab overflow; called after successful jobs calculation in `runIsochroneQueue()` |
| `renderUncoveredBgris()` | Renders the `#uncov-list` in the Scenario tab from `globalPopStats.uncovered_bgris`; wires click handlers to `toggleUncoveredBgri()` |
| `clearUncoveredHighlight()` | Restores the choropleth style on `selectedUncoveredLayer`; resets `selectedUncoveredBgriId`; removes `.active` class from list items |
| `toggleUncoveredBgri(bgri, el)` | Highlights the BGRI layer in orange (`#dd6b20`, weight 3); calls `map.flyTo()` to centroid at zoom ≥ 15; clicking the active item calls `clearUncoveredHighlight()` |
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
  "stations": [{ "id", "lat", "lng", "groupId", "name", "population_5min", "population_10min", "population_total" }],
  "densityOverrides": { "<bgriId>": { "densityType", "coverage", "populationOverride" } },
  "newUrbanizations": [{ "id", "name", "geometry", "densityType", "coverage", "diffuse", "estimatedPop" }]
}
```

Note: `isochrones` are **not** serialised — they are re-fetched on next `updateMap()` call after load.

---

## Empregos e Mix de Usos — Módulo OSM

### Visão geral

Depois de calcular a população nas isócronas, a aplicação consulta automaticamente a API pública Overpass (OpenStreetMap) para estimar o emprego e o mix funcional na área de 5 minutos a pé de cada estação. Não são necessárias credenciais — a Overpass API é pública.

### Constantes e funções em `server.py`

```python
# Coeficientes de emprego por hectare (calibrados com base nos dados INE SCIE)
JOBS_PER_HA = {
    'industrial': 20,
    'commercial': 40,
    'retail':     40,
}
```

**`classify_poi_tags(el_type, tags) → (category, jobs_estimate)`**

Mapeia tags OSM para uma de 6 categorias e estima empregos por POI:

| Categoria | Exemplos de tags OSM | Empregos/POI (aprox.) |
|---|---|---|
| `commerce` | `shop=*`, `amenity=marketplace` | 3 |
| `services` | `amenity=bank/post_office/insurance`, `office=*` | 5 |
| `education_health` | `amenity=school/hospital/clinic/pharmacy` | 15–25 |
| `culture_leisure` | `amenity=theatre/cinema/museum`, `tourism=*` | 4 |
| `food_beverage` | `amenity=restaurant/cafe/bar/fast_food` | 4 |
| `industry` | `landuse=industrial/commercial` (polígono × JOBS_PER_HA) | proporcional à área |

Para polígonos de `landuse`, o cálculo é `area_m2 / 10000 × JOBS_PER_HA[type]`.
Para nós/relações, usa o valor tabelado por POI.

**`compute_shannon_h(residents, breakdown) → (h_normalised, tod_classification)`**

Calcula o índice H de Shannon normalizado (0–1) sobre as 6 categorias funcionais mais população residente:

```
H = -Σ pᵢ × log₂(pᵢ)          # Shannon entropy
H_norm = H / log₂(N_categories) # Normalizado para [0, 1]
```

Classificação de perfil funcional resultante (função `compute_shannon_h` em `server.py`):

| H_norm | Rácio empregos/pop | Perfil funcional |
|---|---|---|
| ≥ 0.60 | qualquer | Centralidade multifuncional |
| ≥ 0.40 | ≥ 0.20 | Misto equilibrado |
| qualquer | ≥ 0.50 | Nó de emprego |
| ≥ 0.30 | qualquer | Misto desequilibrado |
| < 0.30 | < 0.50 | Dormitório |

> **Nota de implementação:** quando `residents = 0` e `jobs_total > 0`, o rácio é definido como `1.0` (não `0`) — garantindo que estações puramente de emprego (ex. parques industriais) são classificadas como "Nó de emprego" e não "Dormitório".

### Endpoint `/api/jobs-in-isochrones`

**Método:** `POST`  
**Payload:**
```json
{
  "stations": [
    { "id": "uuid", "isochrone_5min": { "type": "Feature", "geometry": { … } } }
  ]
}
```

**Resposta:**
```json
{
  "stations": [
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
      "pois": [ { "lat", "lng", "category", "name", "jobs", "osm_id" } ]
    }
  ]
}
```

**Fluxo interno:**
1. Constrói bbox a partir de todas as isócronas.
2. Envia query Overpass para `node`, `way` e `relation` com as tags relevantes.
3. Para cada elemento, chama `classify_poi_tags()` — ignora elementos sem categoria.
4. Filtra por point-in-polygon com `shapely.geometry.shape(isochrone).contains(Point(lng, lat))`.
5. Agrega por categoria; calcula Shannon H com `compute_shannon_h()`.
6. Calcula `self_sufficiency = jobs_total / (active_pop)` onde `active_pop = residents_5min × 0.45`; quando `residents = 0` e `jobs > 0`, devolve `1.0` (não `0.0`).

### Estado frontend (`app.js`)

```js
let jobsData = {};         // { stationId: { jobs_total, jobs_breakdown, shannon_h, tod_classification, self_sufficiency, poi_count, pois[] } }
let jobsPOILayer = null;   // Leaflet LayerGroup com circleMarkers por POI
let jobsPOIVisible = false;
let overlapData = {};      // { stationId: [{ withId, withName, areaFraction, sharedPop }] }
```

### Funções frontend novas/modificadas

| Função | O que faz |
|---|---|
| `calculateJobs()` | Async; chama `/api/jobs-in-isochrones`; popula `jobsData`; chama `updateJobsSummary()` + `updateSidebar()` + `computeOverlaps()` + `updateScenarioSummary()` se no tab de cenário; **devolve `true` em caso de sucesso, `false` em caso de erro** |
| `updateJobsSummary()` | Atualiza `#total-jobs` e `#avg-shannon-h` no painel global; chama `updateCoverageCard()` |
| `computeOverlaps()` | Usa Turf.js `intersect`+`area` para todos os pares de isócronas de 5 min; popula `overlapData`; limiar de reporte ≥ 10%; chama `updateSidebar()` |
| `importGTFS(event)` | Async; lê `.zip`; POST `/api/import-gtfs`; limpa estado existente; cria grupos+estações; chama `updateMap()` que enfileira isócronas |
| `enqueueIsochrone(station)` | Adiciona estação a `isochroneQueue` (deduplicado); inicia `runIsochroneQueue()` se parado |
| `runIsochroneQueue()` | Loop assíncrono: processa uma estação de cada vez com 350 ms de intervalo; quando a fila esvazia, chama `calculatePopulation(false)` (fase "A calcular população…"), depois `calculateJobs()` (fase "A calcular empregos…"); em caso de sucesso chama `hideStationsLoading()`, em falha chama `showStationsLoadingError()` |
| `renderPOILayer()` | Cria `L.circleMarker` por POI, com cor por categoria e popup com nome + categoria + empregos estimados |
| `togglePOILayer()` | Exportada como `window.togglePOILayer`; alterna visibilidade de `jobsPOILayer` no mapa |
| `calculatePopulation(triggerJobs=true)` *(mod.)* | Aceita parâmetro `triggerJobs` (default `true`); quando `false`, não dispara `calculateJobs()` automaticamente — usado pelo queue runner que gere a sequência manualmente; sempre chama `renderUncoveredBgris()` após actualizar a sidebar |
| `updateSidebar()` *(mod.)* | Cada cartão de estação inclui agora uma secção `.station-jobs-section` com total de empregos, breakdown por categoria, barra de progresso H e perfil funcional |
| `updateScenarioSummary()` *(reescrito)* | Calcula ΔH usando helper local `shannonH()`; estima empregos adicionais a partir de área × `JOBS_PER_HA` para overrides de BGRI e novas urbanizações; mostra fallback quando `jobsData` está vazio |

### Paleta de cores dos POI

```js
const POI_COLORS = {
    commerce:          '#ed8936',  // âmbar
    services:          '#3182ce',  // azul
    education_health:  '#38a169',  // verde
    culture_leisure:   '#9f7aea',  // púrpura
    food_beverage:     '#e53e3e',  // vermelho
    industry:          '#718096',  // cinzento
};
```

### Limitações conhecidas

- A Overpass API tem rate limits; pedidos muito frequentes podem receber HTTP 429. A aplicação não implementa retry automático — o utilizador deve recalcular manualmente.
- Empregos em `landuse=commercial/industrial` (polígonos) são estimativas baseadas em área × coeficiente; podem sobrestimar grandes parques industriais pouco densos.
- O índice H é calculado com base em POIs presentes no OSM — zonas com mapeamento OSM incompleto produzirão valores de H subestimados (`low_coverage_warning: true` quando `poi_count < 10`).
- `self_sufficiency` usa a população da última chamada a `/api/population-in-isochrones`; quando `residents = 0` e `jobs > 0`, o valor devolvido é `1.0`.

---

## Cache de Isócronas em Disco

As isócronas calculadas pelo ORS são persistidas em `data/isochrone_cache.json` para evitar chamadas repetidas (a quota ORS é limitada). **O fallback circular nunca é guardado em cache.**

### Globals em `server.py`

```python
ISOCHRONE_CACHE_FILE = "data/isochrone_cache.json"
ISOCHRONE_CACHE = {}                   # dict em memória: key → isochrones[]
_isochrone_cache_lock = threading.Lock()
```

### Chave de cache

```python
def _isochrone_cache_key(lat, lng):
    return f"{round(float(lat), 5)},{round(float(lng), 5)}"  # ~1 m de precisão
```

### Funções

| Função | O que faz |
|---|---|
| `load_isochrone_cache()` | Chamada no startup; lê `data/isochrone_cache.json` se existir |
| `_save_isochrone_cache()` | Escrita atómica via `tempfile.mkstemp` + `os.replace()` |

### Fluxo em `get_isochrones()`

1. **Cache hit** → devolve `{"isochrones": […], "from_cache": true}` sem chamar ORS
2. **Cache miss + ORS OK** → guarda em `ISOCHRONE_CACHE` e persiste em disco; devolve resultado
3. **ORS falhou / fallback** → devolve círculos sem tocar na cache

---

## Análise de Sobreposição de Isócronas

### Estado

```js
let overlapData = {};
// { "stationId": [{ withId, withName, areaFraction, sharedPop }] }
// areaFraction = área de intersecção / área da isócrona 5 min desta estação
// sharedPop = Math.round(population_5min × areaFraction)
```

### Função `computeOverlaps()`

- Chama-se no final de `calculateJobs()`, após `updateSidebar()`
- Itera todos os pares de estações com isócrona 5 min válida
- Usa `turf.intersect()` + `turf.area()`
- Limiar mínimo de reporte: `areaFraction ≥ 0.10` (10%)
- Após popular `overlapData`, chama `updateSidebar()` para re-renderizar os badges

### Badges no cartão de estação

Renderizados em `updateSidebar()` após `${jobsHtml}`:

| Classe CSS | Condição | Ícone |
|---|---|---|
| `.overlap-badge.warning` | 10% ≤ sobreposição < 40% | ⚠️ |
| `.overlap-badge.danger` | sobreposição ≥ 40% | ⛔ |

---

## Design System CSS (`style.css`)

O ficheiro CSS usa um bloco `:root` com variáveis nomeadas. **Não introduzir valores hexadecimais diretamente nas regras** — usar sempre as variáveis.

```css
:root {
    /* Marca */
    --c-primary: #667eea;  --c-primary-dark: #5a6fd6;
    --c-primary-bg: #ebf4ff;  --c-primary-border: #c3dafe;

    /* Semântico */
    --c-red / --c-red-bg;  --c-green / --c-green-bg;
    --c-orange / --c-orange-bg;  --c-purple / --c-purple-bg;

    /* Texto */
    --c-text-primary: #2d3748;  --c-text-secondary: #4a5568;
    --c-text-muted: #718096;  --c-text-disabled: #a0aec0;

    /* Superfícies */
    --c-bg-subtle: #f8fafc;  --c-bg-hover: #edf2f7;
    --c-border: #e2e8f0;  --c-border-faint: #f0f4f8;

    /* Raios: --radius-sm(4) --radius-md(8) --radius-lg(12) --radius-full(9999) */
    /* Sombras: --shadow-xs --shadow-sm --shadow-md --shadow-lg */
    /* Fontes: --font-xs(11) --font-sm(12) --font-base(13) ... --font-2xl(28) */
    /* Espaçamento: --sp-1(4px) ... --sp-6(24px) */
}
```

**Padrão de cabeçalhos de secção** (sidebar):
```css
/* Todos os h2/h3 de secção seguem este estilo: */
font-size: var(--font-xs);  font-weight: 700;
text-transform: uppercase;  letter-spacing: 0.07em;
color: var(--c-text-muted);
```

---

## Known fixes / decisions (do not regress)

| Topic | Decision |
|---|---|
| Census layer z-order | Use `pane: 'censusPane'` (z=200). Never add census layer to default `overlayPane`. After loading census, call `isochroneLayers.forEach(l => l.bringToFront())`. |
| Urbanisation pop is replacement, not additive | Backend subtracts `urb_union` from census intersections before attributing; urbanisation pop is then distributed by isochrone overlap fraction. |
| No floors input | Floors slider was removed. Formula is `residents_ha × area_ha × (coverage/100)` only. Do not reintroduce a floors factor. |
| Edit panel is floating | `#edit-panel` is `position:fixed; bottom:24px; right:24px` — it is **not** inside the sidebar. Visibility is toggled via `opacity`+`transform` (not `display:none`) so CSS transitions work. Closes on ESC, map click (empty area), or ✕ button. |
| CSV import/export removed | Project is saved/loaded as a single JSON. The old `/api/export-points` and `/api/import-points` endpoints and their frontend functions were removed. Do not re-add CSV buttons. |
| Jobs não são serializados | `jobsData` não é guardado no JSON do projeto — é recalculado ao recalcular o catchment. Não guardar POIs no ficheiro de projeto (volume excessivo). |
| Overpass bbox | A query é sempre feita com uma bbox única que engloba todas as isócronas, não por estação individualmente — reduz o nº de pedidos HTTP. |
| ΔH no cenário usa estimativa local | `updateScenarioSummary()` não relê `jobsData` para calcular ΔH — usa um helper JS `shannonH()` local com área × JOBS_PER_HA. Não sincronizar com os dados reais dos POI para evitar dependência de ordem de cálculo. |
| Urbanisation label marker | Always at `urb.layers[1]`. Use `labelMarker.setIcon(L.divIcon({className:'', iconSize:null, …}))` to rename — do not remove/re-add unless necessary. |
| BGRI ID resolution order | `props.BGRI2021` → `props.SUBSECCAO` → `props.OBJECTID`. Used consistently in both frontend and backend. |
| Population dedup | When isochrones from different stations overlap, population is attributed to the station whose centroid is closest to the overlap centroid. |
| Isochrone queue | `initializeStationIsochrones()` enfileira em `isochroneQueue[]` em vez de disparar diretamente. `runIsochroneQueue()` processa uma a uma com 350 ms de intervalo **apenas para chamadas reais ao ORS** (cache hits não introduzem atraso); sequência pós-fila: `calculatePopulation(false)` → `calculateJobs()` → `hideStationsLoading()` ou `showStationsLoadingError()`. Não chamar `calculatePopulation()` fora deste fluxo quando existem estações sem isócrona. O parâmetro `triggerJobs=false` em `calculatePopulation()` evita que o runner dispare `calculateJobs()` em duplicado. |
| Fallback não é cacheado | Apenas resultados reais do ORS são guardados em `data/isochrone_cache.json`. O fallback circular **nunca** deve ser persistido em cache — se for guardado, pedidos subsequentes receberão círculos em vez das isócronas reais. |
| Population dedup (global) | Os totais globais de população usam a união das isócronas no servidor (`union_5min`, `union_10min`), eliminando dupla contagem entre estações com áreas sobrepostas. Os valores por estação continuam a usar Voronoi. `globalPopStats` (frontend) guarda os totais da última resposta do servidor; `exportReport()` usa-os para os KPIs globais. |
| Jobs dedup (global) | `updateJobsSummary()` e `exportReport()` des-duplicam POIs por `osm_id` usando um `Map` antes de somar empregos. Cada POI no endpoint `/api/jobs-in-isochrones` inclui `osm_id` no formato `"{type}_{osm_id}"`. Quando não há `osm_id`, cai back para soma naive. |
| City coverage | `CITY_TOTAL_JOBS=23674` (constante CME). `cityTotalPop` (53 577) carregado em `initMap()` via `fetch('/api/census-metadata')`. Coverage card no sidebar mostra % de pop e empregos da cidade cobertos pela rede actual. Relatório inclui linha adicional de 2 KPIs de cobertura + "Zonas com menor cobertura de paragens" (mapa 900×506 com pontos numerados + tabela BGRI, pop ≥ 50, top 30). |
| Map capture | `captureMapToImage` cria um `<div>` off-screen, instancia um Leaflet separado, adiciona OSM + camadas, aguarda tiles (máx 2500ms), captura com html2canvas, destrói o container. **Não perturba o mapa activo** (sem resize, sem esconder camadas, sem invalidateSize). Usar sempre este helper para qualquer captura de mapa em relativos. |
| Loading overlay | Ao iniciar `importGTFS()` ou `loadProject()`, `showStationsLoading()` é chamado antes de `updateMap()`; a sequência no runner é: isócronas → `calculatePopulation(false)` → `calculateJobs()` → `hideStationsLoading()` (ou `showStationsLoadingError()` se falhar). O overlay bloqueia scroll em `#tab-stations` via `tabEl.style.overflow='hidden'` e volta a restaurá-lo ao esconder. `showStationsLoadingError()` mostra estado de erro com botão "Tentar novamente" que re-executa apenas `calculateJobs()`. O overlay é um `position:absolute` dentro de `#tab-stations`; sem efeito quando não há isócronas a calcular (estações singulares não activam o overlay). |
| GTFS substitui, não adiciona | `importGTFS()` limpa `stations`, `groups`, `activeGroupId`, `isochroneQueue`, `overlapData` e `jobsData` antes de importar. Chama `saveState()` previamente para suportar undo. |
| Uncovered BGRIs no Cenário | `renderUncoveredBgris()` é chamada em `calculatePopulation()` (após sidebar update) e em `recalculateCatchment()`. `toggleUncoveredBgri()` aplica estilo laranja (`#dd6b20`, weight 3) e `map.flyTo()` ao centróide; segundo clique chama `clearUncoveredHighlight()`. `clearUncoveredHighlight()` é chamada no início de `selectCensusFeature()` (evita conflito de estilos) e em `removeCensusLayer()` (limpeza ao sair do tab). Apenas uma BGRI pode estar destacada de cada vez via `selectedUncoveredBgriId`. |
| Shannon H / self_sufficiency com residents=0 | Em `compute_shannon_h()` (server.py): `ratio = 1.0` quando `residents=0` e `jobs_total>0` (em vez de `0.0`) — evita classificação incorrecta como "Dormitório". Em `self_sufficiency` (call site): devolve `1.0` quando `active_pop=0` e `jobs_total>0` (em vez de `0.0`). Não reverter. |
| name em stations | O campo `name` nas estações é `null` para paragens manuais; contém o nome da paragem GTFS quando importado. É serializado no JSON do projeto e restaurado no load. |

---

## Environment

- Python 3.14, venv at `venv/`
- Start: `source venv/bin/activate && python3 server.py`
- Port: 5000
- ORS API key: `.env` file, variable `ORS_API_KEY`
- Census data must be pre-processed with `python3 process_data.py` before first run
