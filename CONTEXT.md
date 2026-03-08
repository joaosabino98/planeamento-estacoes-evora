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
static/app.js         All client logic (~1 780 lines)
data/census_data.geojson   Pre-processed BGRI polygons (1 667 subsections)
data/metadata.json         pop_column name and CRS info
data/isochrone_cache.json  Persisted ORS isochrone results (auto-created; never commit)
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
stations[]                // [{ id, lat, lng, groupId, name (GTFS stop name | null),
                          //    isochrones[], cachedLat, cachedLng,
                          //    isochroneError, creatingIsochrones,
                          //    population_5min, population_10min, population_total }]
stationMarkers[]          // Leaflet marker instances (rebuilt by updateMap())
isochroneLayers[]         // flat list of all isochrone Leaflet layers
stationIsochroneLayers{}  // { stationId: [layer, layer] }

// Isochrone request queue (serialises ORS calls, 350 ms gap between requests)
isochroneQueue[]          // stations waiting for isochrone fetch
isochroneQueueRunning     // boolean — prevents concurrent queue runs

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

Classificação TOD resultante:

| H_norm | Classificação |
|---|---|
| ≥ 0.80 | TOD Excelente |
| ≥ 0.65 | TOD Bom |
| ≥ 0.50 | TOD Moderado |
| ≥ 0.35 | Em Transição |
| < 0.35 | Monofuncional |

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
      "tod_classification": "TOD Bom",
      "self_sufficiency": 0.58,
      "poi_count": 143,
      "low_coverage_warning": false,
      "pois": [ { "lat", "lng", "category", "name", "jobs" } ]
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
6. Calcula `self_sufficiency = jobs_total / (jobs_total + residents_5min)` (usa população da request se fornecida).

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
| `calculateJobs()` | Async; chama `/api/jobs-in-isochrones`; popula `jobsData`; chama `updateJobsSummary()` + `updateSidebar()` + `computeOverlaps()` + `updateScenarioSummary()` se no tab de cenário |
| `updateJobsSummary()` | Atualiza `#total-jobs` e `#avg-shannon-h` no painel global |
| `computeOverlaps()` | Usa Turf.js `intersect`+`area` para todos os pares de isócronas de 5 min; popula `overlapData`; limiar de reporte ≥ 10%; chama `updateSidebar()` |
| `importGTFS(event)` | Async; lê `.zip`; POST `/api/import-gtfs`; limpa estado existente; cria grupos+estações; chama `updateMap()` que enfileira isócronas |
| `enqueueIsochrone(station)` | Adiciona estação a `isochroneQueue` (deduplicado); inicia `runIsochroneQueue()` se parado |
| `runIsochroneQueue()` | Loop assíncrono: processa uma estação de cada vez com 350 ms de intervalo; chama `calculatePopulation()` quando fila esvazia |
| `renderPOILayer()` | Cria `L.circleMarker` por POI, com cor por categoria e popup com nome + categoria + empregos estimados |
| `togglePOILayer()` | Exportada como `window.togglePOILayer`; alterna visibilidade de `jobsPOILayer` no mapa |
| `calculatePopulation()` *(mod.)* | Chama `calculateJobs()` de forma não-bloqueante após atualizar a sidebar |
| `updateSidebar()` *(mod.)* | Cada cartão de estação inclui agora uma secção `.station-jobs-section` com total de empregos, breakdown por categoria, barra de progresso H e classificação TOD |
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
- `self_sufficiency` usa a população da última chamada a `/api/population-in-isochrones`; se não houver dados de população, fica em `null`.

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
| Isochrone queue | `initializeStationIsochrones()` enfileira em `isochroneQueue[]` em vez de disparar diretamente. `runIsochroneQueue()` processa uma a uma com 350 ms de intervalo e chama `calculatePopulation()` quando termina. Não chamar `calculatePopulation()` fora deste fluxo quando existem estações sem isócrona. |
| Fallback não é cacheado | Apenas resultados reais do ORS são guardados em `data/isochrone_cache.json`. O fallback circular **nunca** deve ser persistido em cache — se for guardado, pedidos subsequentes receberão círculos em vez das isócronas reais. |
| GTFS substitui, não adiciona | `importGTFS()` limpa `stations`, `groups`, `activeGroupId`, `isochroneQueue`, `overlapData` e `jobsData` antes de importar. Chama `saveState()` previamente para suportar undo. |
| name em stations | O campo `name` nas estações é `null` para paragens manuais; contém o nome da paragem GTFS quando importado. É serializado no JSON do projeto e restaurado no load. |

---

## Environment

- Python 3.14, venv at `venv/`
- Start: `source venv/bin/activate && python3 server.py`
- Port: 5000
- ORS API key: `.env` file, variable `ORS_API_KEY`
- Census data must be pre-processed with `python3 process_data.py` before first run
