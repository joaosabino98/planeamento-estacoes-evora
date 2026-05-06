// ============================================================
// Constants, application state and shared utilities
// ============================================================


// Coordenadas de Évora (centro da cidade)
const EVORA_CENTER = [38.5667, -7.9075];
const EVORA_ZOOM = 13;

// ==================== City-wide totals ====================
// Empregos totais na cidade (substituído ao carregar /api/config; default INE/SCIE 2021)
let CITY_TOTAL_JOBS = 23674;
// População total carregada do servidor (/api/census-metadata)
let cityTotalPop = 0;

// ==================== Color Palette ====================
const GROUP_COLORS = [
    '#667eea', // indigo (default)
    '#e53e3e', // red
    '#38a169', // green
    '#d69e2e', // yellow
    '#3182ce', // blue
    '#9f7aea', // purple
    '#ed8936', // orange
    '#38b2ac', // teal
    '#e91e9b', // pink
    '#2d3748', // dark
];

// ==================== Inline SVG icons ====================
const ICON_EYE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.78 19.78 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.86 19.86 0 0 1-3.17 4.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// ==================== Density Types ====================
// jobs_ha: empregos por hectare (defaults). mix: proporção das 5 categorias do
// índice de mix de usos (commerce, services, education_health, culture_leisure,
// industry); deve somar 1. Editáveis no modal de cada urbanização.
const DENSITY_TYPES = [
    { id: 0, label: 'Área desocupada',                residents_ha: 0,   jobs_ha: 0,
      mix: { commerce: 0,    services: 0,    education_health: 0,    culture_leisure: 0,    industry: 0    }, color: '#e2e8f0' },
    { id: 1, label: 'Zona industrial / serviços',     residents_ha: 5,   jobs_ha: 60,
      mix: { commerce: 0.10, services: 0.20, education_health: 0,    culture_leisure: 0,    industry: 0.70 }, color: '#a0aec0' },
    { id: 2, label: 'Vivenda unifamiliar',            residents_ha: 30,  jobs_ha: 2,
      mix: { commerce: 0.50, services: 0.50, education_health: 0,    culture_leisure: 0,    industry: 0    }, color: '#c6f6d5' },
    { id: 3, label: 'Moradia geminada (2 pisos)',     residents_ha: 70,  jobs_ha: 4,
      mix: { commerce: 0.50, services: 0.50, education_health: 0,    culture_leisure: 0,    industry: 0    }, color: '#9ae6b4' },
    { id: 4, label: 'Hab. coletiva baixa (3-4 pisos)',residents_ha: 150, jobs_ha: 8,
      mix: { commerce: 0.40, services: 0.40, education_health: 0.20, culture_leisure: 0,    industry: 0    }, color: '#f6e05e' },
    { id: 5, label: 'Hab. coletiva média (4-6 pisos)',residents_ha: 250, jobs_ha: 15,
      mix: { commerce: 0.40, services: 0.30, education_health: 0.20, culture_leisure: 0.10, industry: 0    }, color: '#ed8936' },
    { id: 6, label: 'Uso misto (comércio + hab.)',    residents_ha: 200, jobs_ha: 80,
      mix: { commerce: 0.50, services: 0.30, education_health: 0.10, culture_leisure: 0.10, industry: 0    }, color: '#fc8181' },
    { id: 7, label: 'Alta densidade (6+ pisos)',      residents_ha: 400, jobs_ha: 30,
      mix: { commerce: 0.40, services: 0.40, education_health: 0.10, culture_leisure: 0.10, industry: 0    }, color: '#e53e3e' },
];

const MIX_CATEGORIES = ['commerce', 'services', 'education_health', 'culture_leisure', 'industry'];

// ==================== Application State ====================
let map;

// -- Stations & Groups --
let groups = [];
let activeGroupId = null;
let stations = [];
let stationMarkers = [];
let isochroneLayers = [];
let stationIsochroneLayers = {};
let augmentedIsochroneLayers = {}; // { stationId: [layer5, layer10] } — overlay "preenche polígono" para urbs
let showAugmentedOverlay = true;   // sincronizado com o toggle no painel "Cenário Urbano"
let isUpdating = false;

// -- Routes (percurso por grupo) --
// Modelo: group.route = { trunk: LineString|null, variants: [{ id, direction: 'outbound'|'inbound', geometry: LineString }] }
// O tronco representa o troço comum bidirecional; as variantes representam desvios
// unidirecionais (rotundas, sentidos únicos, voltas nos terminus). Apenas visual —
// não influencia isócronas, população ou empregos.
let groupRouteLayers = {}; // { [groupId]: { trunkLayer, variantLayers: { [variantId]: layer } } }
let routeDrawHandler = null; // handler ativo de L.Draw.Polyline durante desenho
let isDrawingRoute = null;   // { groupId, kind: 'trunk'|'variant', direction? }
let editingRoute = null;     // { groupId, kind, variantId?, layer }

// -- Active tab --
let activeTab = 'stations'; // 'stations' | 'scenario'

// -- Scenario mode --
let censusGeoJSON = null;        // raw GeoJSON data
let censusLayer = null;          // Leaflet GeoJSON layer
let densityOverrides = {};       // { bgriId: { densityType: <int>, populationOverride: <number> } }
let newUrbanizations = [];       // [{ id, name, geometry, densityType, coverage, diffuse, estimatedPop, layers[] }]
let urbanizationLayers = [];     // all Leaflet layers for urbanizations
let showNewUrbanizations = true; // sincronizado com o toggle "Mostrar novas urbanizações"
let selectedCensusFeature = null;
let selectedUncoveredLayer  = null;  // Leaflet layer currently highlighted as uncovered BGRI
let selectedUncoveredBgriId = null;  // id of the highlighted uncovered BGRI
let drawControl = null;
let drawnItems = null;
let isDrawingUrbanization = false;
let pendingUrbanizationGeometry = null;
let editingUrbanizationId = null;

// -- Jobs / Mix de Usos --
let jobsData = {};            // { stationId: { jobs_total, jobs_breakdown, shannon_h, tod_classification, self_sufficiency, poi_count, low_coverage_warning, pois[] } }
let jobsTotalCovered = 0;     // total de empregos cobertos pela rede (POIs deduplicados via união das isócronas 5 min + urbanizações prorated). Calculado server-side; consumido directamente pelo cartão-resumo, cartão de cobertura e relatório.
let jobsPOILayer = null;      // Leaflet layer group for POI circle markers
let jobsPOIVisible = false;
let overlapData = {};         // { stationId: [{ withId, withName, areaFraction, sharedPop }] }

// -- Isochrone request queue (serialises ORS calls to avoid rate-limit) --
let isochroneQueue = [];
let isochroneQueueRunning = false;

// -- Global population totals (union-based, no cross-station double-counting) --
let globalPopStats = { total_population: 0, total_population_5min: 0, total_population_10min: 0 };

// -- Undo/Redo --
let historyStack = [];
let historyIndex = -1;
const MAX_HISTORY = 50;
let isSavingState = false;

// ============================================================
//                       FETCH HELPER
// ============================================================
/**
 * Wrapper sobre fetch() para chamadas JSON. Centraliza headers e error handling.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {object} [opts.body]    Objeto a serializar como JSON (define POST por omissão)
 * @returns {Promise<object>}     JSON desserializado
 * @throws  {Error}               Se a resposta não for OK ou houver erro de rede
 */
async function fetchJSON(url, opts = {}) {
    const method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
    const init = { method };
    if (opts.body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
        throw new Error(msg);
    }
    return res.json();
}
