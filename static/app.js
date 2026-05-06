// ============================================================
// Mobilidade e Território — Análise de Cobertura Pedonal das Paragens — Évora
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
const DENSITY_TYPES = [
    { id: 0, label: 'Área desocupada',               residents_ha: 0,   color: '#e2e8f0' },
    { id: 1, label: 'Zona industrial / serviços',    residents_ha: 5,   color: '#a0aec0' },
    { id: 2, label: 'Vivenda unifamiliar',            residents_ha: 30,  color: '#c6f6d5' },
    { id: 3, label: 'Moradia geminada (2 pisos)',     residents_ha: 70,  color: '#9ae6b4' },
    { id: 4, label: 'Hab. coletiva baixa (3-4 pisos)',residents_ha: 150, color: '#f6e05e' },
    { id: 5, label: 'Hab. coletiva média (4-6 pisos)',residents_ha: 250, color: '#ed8936' },
    { id: 6, label: 'Uso misto (comércio + hab.)',    residents_ha: 200, color: '#fc8181' },
    { id: 7, label: 'Alta densidade (6+ pisos)',      residents_ha: 400, color: '#e53e3e' },
];

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

// ============================================================
//                       INITIALIZATION
// ============================================================
function initMap() {
    const mapElement = document.getElementById('map');
    if (!mapElement) { console.error('Elemento #map não encontrado!'); return; }

    map = L.map('map').setView(EVORA_CENTER, EVORA_ZOOM);

    // Custom pane for census layer — sits below isochrones (overlayPane z=400)
    map.createPane('censusPane');
    map.getPane('censusPane').style.zIndex = 200;
    map.getPane('censusPane').style.pointerEvents = 'auto';

    // Custom pane for routes — sits above isochrones (overlayPane z=400) but below
    // markers (markerPane z=600). z=450 cai entre overlay (400) e shadow (500),
    // garantindo que as linhas fiquem visíveis sobre as isócronas sem cobrir os pins.
    map.createPane('routePane');
    map.getPane('routePane').style.zIndex = 450;
    map.getPane('routePane').style.pointerEvents = 'auto';

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    // Leaflet.draw setup (for urbanization polygons)
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // Map click — add station (only in stations tab, not drawing)
    map.on('click', function(e) {
        if (isDrawingRoute) return; // Leaflet.Draw está a tratar do clique
        if (activeTab === 'stations' && !isUpdating) {
            addStation(e.latlng.lat, e.latlng.lng);
        } else if (activeTab === 'scenario') {
            // Click on empty map area closes the edit panel
            cancelEdit();
        }
    });

    // Draw events
    map.on(L.Draw.Event.CREATED, function(event) {
        const layer = event.layer;
        if (isDrawingRoute) {
            const geom = layer.toGeoJSON().geometry;
            finishRouteDrawing(geom);
            return;
        }
        if (isDrawingUrbanization) {
            pendingUrbanizationGeometry = layer.toGeoJSON().geometry;
            drawnItems.addLayer(layer);
            showUrbanizationModal();
        }
    });

    // Initialize with one default group
    createGroup('Grupo 1');

    // Wire up control buttons
    document.getElementById('btn-clear').addEventListener('click', clearAllStations);
    document.getElementById('btn-save-project').addEventListener('click', saveProject);
    document.getElementById('btn-load-project').addEventListener('click', () => document.getElementById('project-file-input').click());
    document.getElementById('project-file-input').addEventListener('change', loadProject);
    document.getElementById('btn-import-gtfs').addEventListener('click', () => document.getElementById('gtfs-file-input').click());
    document.getElementById('gtfs-file-input').addEventListener('change', importGTFS);
    document.getElementById('btn-export-report').addEventListener('click', exportReport);
    document.getElementById('btn-add-group').addEventListener('click', () => {
        createGroup(nextGroupName());
        renderGroups();
    });

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Scenario buttons
    document.getElementById('btn-recalc').addEventListener('click', recalculateCatchment);
    document.getElementById('btn-reset-scenario').addEventListener('click', resetScenario);
    document.getElementById('btn-draw-urbanization').addEventListener('click', startDrawUrbanization);
    document.getElementById('btn-apply-density').addEventListener('click', applyDensityEdit);
    document.getElementById('btn-revert-density').addEventListener('click', revertDensityEdit);
    document.getElementById('btn-cancel-edit').addEventListener('click', cancelEdit);
    document.getElementById('btn-close-edit').addEventListener('click', cancelEdit);

    // ESC closes the edit panel; Ctrl+Z/Y for undo/redo (único listener)
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (isDrawingRoute) { cancelRouteDrawing(); return; }
            if (editingRoute)   { finishRouteEdit(false); return; }
            cancelEdit();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
        else if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }
    });
    document.getElementById('edit-density-select').addEventListener('change', () => {
        const hasValue = document.getElementById('edit-density-select').value !== '';
        document.getElementById('edit-coverage-field').classList.toggle('hidden', !hasValue);
        updateEstimatedPop();
    });
    document.getElementById('edit-coverage').addEventListener('input', () => {
        document.getElementById('edit-coverage-value').textContent =
            document.getElementById('edit-coverage').value + '%';
        updateEstimatedPop();
    });
    document.getElementById('edit-density-select').addEventListener('change', updateEstimatedPop);

    // Urbanization modal
    document.getElementById('btn-create-urbanization').addEventListener('click', confirmUrbanization);
    document.getElementById('btn-cancel-urbanization').addEventListener('click', cancelUrbanization);
    document.getElementById('urb-coverage').addEventListener('input', updateUrbanizationEstimate);
    document.getElementById('urb-density-type').addEventListener('change', updateUrbanizationEstimate);

    // Toggle do overlay "preenche polígono"
    const augToggle = document.getElementById('toggle-augmented-overlay');
    if (augToggle) {
        augToggle.addEventListener('change', (e) => {
            showAugmentedOverlay = !!e.target.checked;
            refreshAugmentedIsochrones();
        });
    }


    // Populate density selects
    populateDensitySelects();
    renderDensityLegend();
    renderGroups();
    saveState();

    // Load city-wide population total for coverage stats
    fetch('/api/census-metadata')
        .then(r => r.json())
        .then(m => { if (m && m.total_pop) { cityTotalPop = m.total_pop; updateCoverageCard(); } })
        .catch(() => {});

    // Load shared config (city totals etc.) — falha silenciosa, fica nos defaults
    fetch('/api/config')
        .then(r => r.ok ? r.json() : null)
        .then(c => {
            if (c && typeof c.city_total_jobs === 'number') {
                CITY_TOTAL_JOBS = c.city_total_jobs;
                updateCoverageCard();
            }
        })
        .catch(() => {});
}

// ============================================================
//                           TABS
// ============================================================
function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));

    if (tab === 'scenario') {
        loadCensusLayer();
    } else {
        removeCensusLayer();
    }
}

// ============================================================
//                        GROUPS
// ============================================================
function createGroup(name, color) {
    const id = Date.now() + Math.random();
    const usedColors = groups.map(g => g.color);
    if (!color) {
        color = GROUP_COLORS.find(c => !usedColors.includes(c)) || GROUP_COLORS[groups.length % GROUP_COLORS.length];
    }
    const group = { id, name, color, visible: true, route: { trunk: null, variants: [] } };
    groups.push(group);
    activeGroupId = id;
    renderGroups();
    return group;
}

// Próximo nome livre da forma "Grupo N", evitando colisões com grupos existentes
// (útil depois de apagar grupos: "Grupo {n+1}" pode já existir).
function nextGroupName() {
    const used = new Set(groups.map(g => g.name));
    let n = groups.length + 1;
    while (used.has(`Grupo ${n}`)) n++;
    return `Grupo ${n}`;
}

// Duplica um grupo: cria um novo grupo com nova cor e nome auto, e clona
// todas as suas estações (mantendo posição e isócronas — mesma lat/lng usa a
// mesma cache do servidor, evitando refetch ao ORS).
function duplicateGroup(groupId) {
    const src = groups.find(g => g.id === groupId);
    if (!src) return;
    const newGroup = createGroup(nextGroupName());
    const srcStations = stations.filter(s => s.groupId === groupId);
    srcStations.forEach(s => {
        const cloned = {
            ...s,
            id: Date.now() + Math.random(),
            groupId: newGroup.id,
            // Layers/markers são recriados por updateMap()
        };
        delete cloned.creatingIsochrones;
        delete cloned.isochroneError;
        stations.push(cloned);
    });
    updateMap();
    updateSidebar();
    saveState();
    // Recalcular população: as novas estações partilham as mesmas isócronas
    // do grupo original, por isso os totais por grupo refletem a nova rede.
    if (srcStations.length > 0) calculatePopulation();
    toast(`Grupo "${src.name}" duplicado como "${newGroup.name}" (${srcStations.length} estação(ões)).`, 'success');
}

function deleteGroup(groupId) {
    // Apaga o grupo e todas as estações que lhe pertencem.
    // É permitido apagar o último grupo: a próxima estação adicionada
    // criará automaticamente um novo grupo (mesmo comportamento de "Limpar estações").
    const remaining = groups.filter(g => g.id !== groupId);
    const group = groups.find(g => g.id === groupId);
    const groupStations = stations.filter(s => s.groupId === groupId);
    if (groupStations.length > 0) {
        const name = group ? group.name : 'este grupo';
        const msg = groupStations.length === 1
            ? `Apagar o grupo "${name}" e a sua 1 estação?`
            : `Apagar o grupo "${name}" e as suas ${groupStations.length} estações?`;
        if (!confirm(msg)) return;
    }
    saveState();
    // Descartar pedidos pendentes para estações deste grupo
    const removedIds = new Set(groupStations.map(s => s.id));
    isochroneQueue = isochroneQueue.filter(s => !removedIds.has(s && s.id));
    stations = stations.filter(s => s.groupId !== groupId);
    removeGroupRouteLayers(groupId);
    groups = remaining;
    if (activeGroupId === groupId) activeGroupId = remaining.length > 0 ? remaining[0].id : null;
    renderGroups();
    updateMap();
    updateSidebar();
    calculatePopulation();
}

function setActiveGroup(groupId) {
    activeGroupId = groupId;
    renderGroups();
}

function toggleGroupVisibility(groupId) {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    group.visible = !group.visible;
    renderGroups();
    updateMap();
    renderAllRoutes();
    refreshAugmentedIsochrones();
}

function getGroupForStation(station) {
    return groups.find(g => g.id === station.groupId) || groups[0];
}

// ============================================================
//                        ROUTES
// ============================================================
// Rotas são puramente visuais/informativas. Cada grupo tem
//   group.route = { trunk: LineString|null, variants: [{ id, direction, geometry }] }
// O tronco representa o troço bidirecional comum; as variantes representam
// pequenos desvios unidirecionais (rotundas, ruas de sentido único, voltas
// nos terminus). Não influenciam isócronas, população nem empregos.

function ensureRouteShape(group) {
    if (!group.route) group.route = { trunk: null, variants: [] };
    else {
        if (!('trunk' in group.route)) group.route.trunk = null;
        if (!Array.isArray(group.route.variants)) group.route.variants = [];
    }
    return group.route;
}

// Comprimento de uma LineString em metros (turf.length devolve km).
function lineLengthM(lineGeometry) {
    if (!lineGeometry || lineGeometry.type !== 'LineString' || !lineGeometry.coordinates || lineGeometry.coordinates.length < 2) return 0;
    try {
        return turf.length({ type: 'Feature', geometry: lineGeometry, properties: {} }, { units: 'kilometers' }) * 1000;
    } catch { return 0; }
}

// Comprimento operacional de um percurso: tronco percorrido nos dois sentidos
// (× 2) + variantes unidirecionais (× 1).
function getRouteLengthM(group) {
    const r = group && group.route;
    if (!r) return { trunk: 0, variants: 0, operational: 0 };
    const trunk = lineLengthM(r.trunk);
    const variants = (r.variants || []).reduce((acc, v) => acc + lineLengthM(v.geometry), 0);
    return { trunk, variants, operational: trunk * 2 + variants };
}

function formatRouteDistance(m) {
    if (!m || m < 1) return '0 m';
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

// Rebuild map layers for all routes (call after group color/visibility changes
// or after geometry edits).
function renderAllRoutes() {
    groups.forEach(g => renderGroupRoute(g));
}

// Cria o par casing (halo branco translúcido) + linha colorida para uma geometria.
// O casing é desenhado primeiro (peso maior) e a linha por cima, dando contraste
// quando a rota atravessa isócronas ou tiles escuros.
function buildRoutePair(geometry, group, isVariant) {
    const baseWeight = isVariant ? 4 : 5;
    const casingWeight = baseWeight + 4;
    const feature = { type: 'Feature', geometry, properties: {} };

    const casing = L.geoJSON(feature, {
        pane: 'routePane',
        style: {
            color: '#ffffff', weight: casingWeight, opacity: 0.55,
            lineCap: 'round', lineJoin: 'round',
            interactive: false,
        }
    }).addTo(map);

    const line = L.geoJSON(feature, {
        pane: 'routePane',
        style: {
            color: group.color, weight: baseWeight, opacity: 0.95,
            dashArray: isVariant ? '8,6' : null,
            lineCap: 'round', lineJoin: 'round',
        }
    }).addTo(map);

    line.on('mouseover', () => {
        line.setStyle({ weight: baseWeight + 2 });
        casing.setStyle({ weight: casingWeight + 2 });
    });
    line.on('mouseout', () => {
        line.setStyle({ weight: baseWeight });
        casing.setStyle({ weight: casingWeight });
    });

    return { casing, line, baseWeight, casingWeight };
}

// Calcula posições e bearings ao longo de uma LineString para colocar setas
// direcionais. Devolve [{ lat, lng, bearing }] com 1–3 marcas espaçadas
// regularmente. Pequenas variantes (<120 m) ficam sem seta para não poluir.
function computeArrowAnchors(geometry) {
    if (!geometry || geometry.type !== 'LineString') return [];
    let lengthKm = 0;
    try {
        lengthKm = turf.length({ type: 'Feature', geometry, properties: {} }, { units: 'kilometers' });
    } catch { return []; }
    const lengthM = lengthKm * 1000;
    if (lengthM < 120) return [];

    // 1 seta para variantes curtas (<400 m), até 3 setas em variantes longas.
    let count = 1;
    if (lengthM >= 800) count = 3;
    else if (lengthM >= 400) count = 2;

    // Distribui as setas em proporções [0.5] / [0.33, 0.66] / [0.25, 0.5, 0.75].
    const fractions = count === 1 ? [0.5] : (count === 2 ? [1/3, 2/3] : [0.25, 0.5, 0.75]);
    const eps = 0.005; // ~0.5% adiante para o bearing (evita zero quando o ponto cai num vértice)
    const anchors = [];
    fractions.forEach(f => {
        try {
            const ptKm = f * lengthKm;
            const ahead = Math.min(lengthKm, ptKm + Math.max(eps * lengthKm, 0.005));
            const a = turf.along({ type: 'Feature', geometry, properties: {} }, ptKm,   { units: 'kilometers' });
            const b = turf.along({ type: 'Feature', geometry, properties: {} }, ahead,  { units: 'kilometers' });
            const bearing = turf.bearing(a, b);
            anchors.push({
                lat: a.geometry.coordinates[1],
                lng: a.geometry.coordinates[0],
                bearing,
            });
        } catch {}
    });
    return anchors;
}

function buildArrowMarker({ lat, lng, bearing }, color, opts = {}) {
    // Triângulo SVG a apontar para cima (norte), rotado pelo bearing geográfico.
    // turf.bearing devolve graus com 0=norte, 90=este — coincide com CSS rotate.
    // A seta tem um halo branco para se destacar quando atravessa a linha
    // tracejada da variante ou as isócronas.
    const size = 18;
    const html = `
        <div style="transform: rotate(${bearing}deg); width: ${size}px; height: ${size}px; display:flex; align-items:center; justify-content:center;">
            <svg viewBox="0 0 16 16" width="${size}" height="${size}" style="display:block; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,0.35));">
                <path d="M8 1 L14.5 14.5 L8 11 L1.5 14.5 Z"
                      fill="${color}" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round" />
            </svg>
        </div>`;
    const markerOpts = {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
            className: '',
            html,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
        }),
    };
    if (opts.pane) markerOpts.pane = opts.pane;
    return L.marker([lat, lng], markerOpts);
}

function renderGroupRoute(group) {
    if (!group) return;
    ensureRouteShape(group);
    const tracker = groupRouteLayers[group.id] || {
        trunkLayer: null, trunkCasing: null,
        variantLayers: {}, variantCasings: {}, variantArrows: {}
    };
    groupRouteLayers[group.id] = tracker;
    // Migrate older tracker shape (sem casings/setas) sem partir nada
    if (!('trunkCasing' in tracker))    tracker.trunkCasing = null;
    if (!('variantCasings' in tracker)) tracker.variantCasings = {};
    if (!('variantArrows' in tracker))  tracker.variantArrows = {};

    const visible = group.visible !== false;

    // -- Trunk --
    if (tracker.trunkLayer)  { try { map.removeLayer(tracker.trunkLayer); }  catch {} tracker.trunkLayer = null; }
    if (tracker.trunkCasing) { try { map.removeLayer(tracker.trunkCasing); } catch {} tracker.trunkCasing = null; }
    if (visible && group.route.trunk) {
        const { casing, line } = buildRoutePair(group.route.trunk, group, false);
        line.bindTooltip(`${escapeHtml(group.name)} — tronco`, { sticky: true });
        tracker.trunkLayer  = line;
        tracker.trunkCasing = casing;
    }

    // -- Variants --
    Object.keys(tracker.variantLayers).forEach(vid => {
        try { map.removeLayer(tracker.variantLayers[vid]); } catch {}
    });
    Object.keys(tracker.variantCasings).forEach(vid => {
        try { map.removeLayer(tracker.variantCasings[vid]); } catch {}
    });
    Object.keys(tracker.variantArrows).forEach(vid => {
        (tracker.variantArrows[vid] || []).forEach(m => { try { map.removeLayer(m); } catch {} });
    });
    tracker.variantLayers = {};
    tracker.variantCasings = {};
    tracker.variantArrows = {};
    if (visible) {
        (group.route.variants || []).forEach(v => {
            if (!v.geometry) return;
            const { casing, line } = buildRoutePair(v.geometry, group, true);
            const dirLabel = v.direction === 'inbound' ? 'volta' : 'ida';
            line.bindTooltip(`${escapeHtml(group.name)} — variante (${dirLabel})`, { sticky: true });
            tracker.variantLayers[v.id]  = line;
            tracker.variantCasings[v.id] = casing;

            // Setas direcionais ao longo da variante (a apontar no sentido de
            // desenho — o utilizador desenha cada variante na direção real
            // de circulação que ela representa).
            const arrows = [];
            computeArrowAnchors(v.geometry).forEach(anchor => {
                const marker = buildArrowMarker(anchor, group.color, { pane: 'routePane' }).addTo(map);
                arrows.push(marker);
            });
            tracker.variantArrows[v.id] = arrows;
        });
    }

    // Re-enable vertex editing if this layer is currently being edited
    if (editingRoute && editingRoute.groupId === group.id) {
        const newLayer = editingRoute.kind === 'trunk'
            ? tracker.trunkLayer
            : tracker.variantLayers[editingRoute.variantId];
        if (newLayer) {
            // Pega na primeira sub-layer (L.GeoJSON wrapper → polyline interna)
            const polyline = newLayer.getLayers && newLayer.getLayers()[0];
            if (polyline && polyline.editing) {
                polyline.editing.enable();
                editingRoute.layer = polyline;
            }
        }
    }
}

function removeGroupRouteLayers(groupId) {
    const tracker = groupRouteLayers[groupId];
    if (!tracker) return;
    if (tracker.trunkLayer)  { try { map.removeLayer(tracker.trunkLayer); }  catch {} }
    if (tracker.trunkCasing) { try { map.removeLayer(tracker.trunkCasing); } catch {} }
    Object.values(tracker.variantLayers  || {}).forEach(l => { try { map.removeLayer(l); } catch {} });
    Object.values(tracker.variantCasings || {}).forEach(l => { try { map.removeLayer(l); } catch {} });
    Object.values(tracker.variantArrows  || {}).forEach(arr => (arr || []).forEach(m => { try { map.removeLayer(m); } catch {} }));
    delete groupRouteLayers[groupId];
}

// -- Drawing flow ---------------------------------------------------------
function startDrawTrunk(groupId) {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    if (editingRoute) finishRouteEdit(true);
    if (isDrawingRoute) cancelRouteDrawing();
    if (group.route && group.route.trunk) {
        if (!confirm(`O grupo "${group.name}" já tem um tronco desenhado. Substituir?`)) return;
    }
    isDrawingRoute = { groupId, kind: 'trunk' };
    routeDrawHandler = new L.Draw.Polyline(map, {
        shapeOptions: { color: group.color, weight: 5, opacity: 0.85 },
        showLength: true, metric: true, allowIntersection: true
    });
    routeDrawHandler.enable();
    toast(`A desenhar tronco de "${group.name}". Duplo clique para terminar, ESC para cancelar.`, 'info');
    renderGroups();
}

function startDrawVariant(groupId, direction) {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    if (editingRoute) finishRouteEdit(true);
    if (isDrawingRoute) cancelRouteDrawing();
    isDrawingRoute = { groupId, kind: 'variant', direction: direction === 'inbound' ? 'inbound' : 'outbound' };
    routeDrawHandler = new L.Draw.Polyline(map, {
        shapeOptions: { color: group.color, weight: 4, opacity: 0.9, dashArray: '8,6' },
        showLength: true, metric: true, allowIntersection: true
    });
    routeDrawHandler.enable();
    const dirLabel = direction === 'inbound' ? 'volta' : 'ida';
    toast(`A desenhar variante (${dirLabel}) de "${group.name}". Duplo clique para terminar, ESC para cancelar.`, 'info');
    renderGroups();
}

function finishRouteDrawing(geometry) {
    if (!isDrawingRoute || !geometry) { cancelRouteDrawing(); return; }
    const { groupId, kind, direction } = isDrawingRoute;
    const group = groups.find(g => g.id === groupId);
    if (!group) { cancelRouteDrawing(); return; }
    ensureRouteShape(group);
    saveState();
    if (kind === 'trunk') {
        group.route.trunk = geometry;
        toast(`Tronco de "${group.name}" desenhado (${formatRouteDistance(lineLengthM(geometry))}).`, 'success');
    } else {
        const id = Date.now() + Math.random();
        group.route.variants.push({ id, direction: direction || 'outbound', geometry });
        toast(`Variante adicionada a "${group.name}" (${formatRouteDistance(lineLengthM(geometry))}).`, 'success');
    }
    isDrawingRoute = null;
    routeDrawHandler = null;
    renderGroupRoute(group);
    renderGroups();
}

function cancelRouteDrawing() {
    if (routeDrawHandler) {
        try { routeDrawHandler.disable(); } catch {}
        routeDrawHandler = null;
    }
    isDrawingRoute = null;
    renderGroups();
}

// -- Vertex editing -------------------------------------------------------
function startRouteEdit(groupId, kind, variantId) {
    if (isDrawingRoute) cancelRouteDrawing();
    if (editingRoute) finishRouteEdit(true);
    const tracker = groupRouteLayers[groupId];
    if (!tracker) return;
    const wrapper = kind === 'trunk' ? tracker.trunkLayer : tracker.variantLayers[variantId];
    if (!wrapper) return;
    const polyline = wrapper.getLayers ? wrapper.getLayers()[0] : wrapper;
    if (!polyline || !polyline.editing) return;
    polyline.editing.enable();
    editingRoute = { groupId, kind, variantId, layer: polyline };
    toast('Arraste vértices para editar. Carregue em ✓ para guardar ou ESC para cancelar.', 'info');
    renderGroups();
}

function finishRouteEdit(save) {
    if (!editingRoute) return;
    const { groupId, kind, variantId, layer } = editingRoute;
    const group = groups.find(g => g.id === groupId);
    if (save && group && layer) {
        const geo = layer.toGeoJSON();
        const newGeom = (geo && geo.geometry) || null;
        if (newGeom && newGeom.type === 'LineString' && newGeom.coordinates.length >= 2) {
            saveState();
            ensureRouteShape(group);
            if (kind === 'trunk') {
                group.route.trunk = newGeom;
            } else {
                const v = group.route.variants.find(x => x.id === variantId);
                if (v) v.geometry = newGeom;
            }
        }
    }
    try { layer.editing.disable(); } catch {}
    editingRoute = null;
    if (group) renderGroupRoute(group);
    renderGroups();
}

// -- Deletion -------------------------------------------------------------
function deleteRouteTrunk(groupId) {
    const group = groups.find(g => g.id === groupId);
    if (!group || !group.route || !group.route.trunk) return;
    if (!confirm(`Apagar o tronco da rota de "${group.name}"?`)) return;
    if (editingRoute && editingRoute.groupId === groupId && editingRoute.kind === 'trunk') {
        try { editingRoute.layer.editing.disable(); } catch {}
        editingRoute = null;
    }
    saveState();
    group.route.trunk = null;
    renderGroupRoute(group);
    renderGroups();
}

function deleteRouteVariant(groupId, variantId) {
    const group = groups.find(g => g.id === groupId);
    if (!group || !group.route) return;
    const v = (group.route.variants || []).find(x => x.id === variantId);
    if (!v) return;
    if (!confirm(`Apagar esta variante de "${group.name}"?`)) return;
    if (editingRoute && editingRoute.groupId === groupId && editingRoute.kind === 'variant' && editingRoute.variantId === variantId) {
        try { editingRoute.layer.editing.disable(); } catch {}
        editingRoute = null;
    }
    saveState();
    group.route.variants = group.route.variants.filter(x => x.id !== variantId);
    renderGroupRoute(group);
    renderGroups();
}

function renderGroups() {
    const container = document.getElementById('groups-list');
    if (groups.length === 0) {
        container.innerHTML = '<p class="no-stations">Sem grupos</p>';
        return;
    }
    container.innerHTML = groups.map(g => {
        const count = stations.filter(s => s.groupId === g.id).length;
        const isActive = g.id === activeGroupId;
        const route = ensureRouteShape(g);
        const len = getRouteLengthM(g);
        const drawingTrunk   = isDrawingRoute && isDrawingRoute.groupId === g.id && isDrawingRoute.kind === 'trunk';
        const drawingVariant = isDrawingRoute && isDrawingRoute.groupId === g.id && isDrawingRoute.kind === 'variant';
        const editingTrunk   = editingRoute  && editingRoute.groupId  === g.id && editingRoute.kind  === 'trunk';
        return `
            <div class="group-row ${isActive ? 'active' : ''}" data-group-id="${g.id}">
                <div class="group-main">
                    <div class="group-color-swatch" style="background:${g.color}" data-action="color" title="Mudar cor"></div>
                    <input class="group-name-input" value="${escapeHtml(g.name)}" data-action="rename" />
                    <span class="group-badge">${count}</span>
                    <button class="group-btn btn-visibility" data-action="visibility" title="${g.visible ? 'Ocultar' : 'Mostrar'}">${g.visible ? ICON_EYE : ICON_EYE_OFF}</button>
                    <button class="group-btn btn-duplicate-group" data-action="duplicate" title="Duplicar grupo">⎘</button>
                    <button class="group-btn btn-delete-group" data-action="delete" title="Apagar grupo">×</button>
                </div>
                <div class="group-route ${drawingTrunk || drawingVariant ? 'is-drawing' : ''}">
                    ${route.trunk ? `
                        <span class="route-len" title="Tronco × 2 + variantes">${formatRouteDistance(len.operational)}</span>
                        ${drawingTrunk
                            ? `<button class="route-btn route-cancel" data-action="cancel-draw" title="Cancelar desenho">Cancelar</button>`
                            : `
                                <button class="route-btn ${editingTrunk ? 'is-editing' : ''}" data-action="${editingTrunk ? 'edit-save-trunk' : 'edit-trunk'}" title="${editingTrunk ? 'Guardar edição' : 'Editar tronco'}">${editingTrunk ? '✓' : '✎'}</button>
                                <button class="route-btn" data-action="add-variant-out" title="Adicionar variante (ida)">+ida</button>
                                <button class="route-btn" data-action="add-variant-in"  title="Adicionar variante (volta)">+volta</button>
                                <button class="route-btn route-danger" data-action="delete-trunk" title="Apagar tronco">×</button>
                              `
                        }
                    ` : `
                        ${drawingTrunk
                            ? `<button class="route-btn route-cancel" data-action="cancel-draw" title="Cancelar desenho">Cancelar desenho</button>`
                            : `<button class="route-btn route-primary" data-action="draw-trunk" title="Desenhar percurso da linha">↝ Desenhar rota</button>`
                        }
                    `}
                </div>
                ${(route.variants && route.variants.length > 0) ? `
                    <div class="group-variants">
                        ${route.variants.map(v => {
                            const editingThis = editingRoute && editingRoute.groupId === g.id && editingRoute.kind === 'variant' && editingRoute.variantId === v.id;
                            const dirLabel = v.direction === 'inbound' ? 'volta' : 'ida';
                            return `
                                <div class="variant-row" data-variant-id="${v.id}">
                                    <span class="variant-tag variant-tag-${v.direction === 'inbound' ? 'in' : 'out'}">${dirLabel}</span>
                                    <span class="route-len">${formatRouteDistance(lineLengthM(v.geometry))}</span>
                                    <button class="route-btn ${editingThis ? 'is-editing' : ''}" data-action="${editingThis ? 'edit-save-variant' : 'edit-variant'}" title="${editingThis ? 'Guardar edição' : 'Editar vértices'}">${editingThis ? '✓' : '✎'}</button>
                                    <button class="route-btn route-danger" data-action="delete-variant" title="Apagar variante">×</button>
                                </div>
                            `;
                        }).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');

    // Event delegation
    container.querySelectorAll('.group-row').forEach(row => {
        const gid = parseFloat(row.dataset.groupId);

        row.addEventListener('click', (e) => {
            const action = e.target.dataset.action || e.target.closest('[data-action]')?.dataset.action;
            const variantRow = e.target.closest('.variant-row');
            const vid = variantRow ? parseFloat(variantRow.dataset.variantId) : null;
            if (!action) { setActiveGroup(gid); return; }
            e.stopPropagation();
            switch (action) {
                case 'color':       showColorPicker(e.target, gid); break;
                case 'visibility':  toggleGroupVisibility(gid); break;
                case 'duplicate':   duplicateGroup(gid); break;
                case 'delete':      deleteGroup(gid); break;
                case 'rename':      /* handled by input change */ break;
                case 'draw-trunk':  startDrawTrunk(gid); break;
                case 'cancel-draw': cancelRouteDrawing(); break;
                case 'edit-trunk':  startRouteEdit(gid, 'trunk'); break;
                case 'edit-save-trunk': finishRouteEdit(true); break;
                case 'add-variant-out': startDrawVariant(gid, 'outbound'); break;
                case 'add-variant-in':  startDrawVariant(gid, 'inbound'); break;
                case 'delete-trunk':    deleteRouteTrunk(gid); break;
                case 'edit-variant':    if (vid !== null) startRouteEdit(gid, 'variant', vid); break;
                case 'edit-save-variant': finishRouteEdit(true); break;
                case 'delete-variant':  if (vid !== null) deleteRouteVariant(gid, vid); break;
                default: setActiveGroup(gid);
            }
        });

        const nameInput = row.querySelector('.group-name-input');
        nameInput.addEventListener('change', () => {
            const group = groups.find(g => g.id === gid);
            if (group) group.name = nameInput.value;
            updateSidebar();
        });
        nameInput.addEventListener('click', (e) => e.stopPropagation());
    });
}

// Color picker popup
let activeColorPicker = null;
function showColorPicker(swatchEl, groupId) {
    closeColorPicker();
    const rect = swatchEl.getBoundingClientRect();
    const popup = document.createElement('div');
    popup.className = 'color-picker-popup';
    popup.style.left = rect.left + 'px';
    popup.style.top = (rect.bottom + 4) + 'px';
    GROUP_COLORS.forEach(c => {
        const opt = document.createElement('div');
        opt.className = 'color-picker-option';
        opt.style.background = c;
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            const group = groups.find(g => g.id === groupId);
            if (group) {
                group.color = c;
                renderGroups();
                updateMap();
                renderAllRoutes();
                updateSidebar();
            }
            closeColorPicker();
        });
        popup.appendChild(opt);
    });
    document.body.appendChild(popup);
    activeColorPicker = popup;
    setTimeout(() => {
        document.addEventListener('click', closeColorPicker, { once: true });
    }, 10);
}

function closeColorPicker() {
    if (activeColorPicker) {
        activeColorPicker.remove();
        activeColorPicker = null;
    }
}

// ============================================================
//                     UNDO / REDO
// ============================================================
function saveState(skipDuplicateCheck = false) {
    if (!skipDuplicateCheck && isSavingState) return;
    isSavingState = true;

    const state = stations.map(s => ({ id: s.id, lat: s.lat, lng: s.lng, groupId: s.groupId }));

    if (historyStack.length > 0 && historyIndex >= 0 && historyIndex < historyStack.length) {
        const normalizeState = (s) => JSON.stringify([...s].sort((a, b) => String(a.id).localeCompare(String(b.id))));
        if (normalizeState(historyStack[historyIndex]) === normalizeState(state)) {
            isSavingState = false;
            return;
        }
    }

    if (historyIndex < historyStack.length - 1) {
        historyStack = historyStack.slice(0, historyIndex + 1);
    }
    historyStack.push(state);
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    historyIndex = historyStack.length - 1;
    isSavingState = false;
}

function undo() {
    if (historyIndex > 0) {
        historyIndex--;
        restoreState(historyStack[historyIndex], true);
    } else if (historyIndex === 0) {
        historyIndex = -1;
        stations = [];
        isSavingState = true;
        updateMap(); updateSidebar(); calculatePopulation();
        isSavingState = false;
    }
}

function redo() {
    if (historyIndex < historyStack.length - 1) {
        historyIndex++;
        restoreState(historyStack[historyIndex], true);
    }
}

function restoreState(state, skipSave = false) {
    const cachePreservation = {};
    stations.forEach(old => {
        const match = state.find(s => String(s.id) === String(old.id));
        if (match && old.isochrones && Array.isArray(old.isochrones) && old.isochrones.length >= 2 &&
            !old.isochroneError && old.cachedLat === match.lat && old.cachedLng === match.lng) {
            cachePreservation[String(old.id)] = {
                isochrones: old.isochrones, cachedLat: old.cachedLat, cachedLng: old.cachedLng, isochroneError: old.isochroneError
            };
        }
    });

    stations = state.map(s => {
        const cached = cachePreservation[String(s.id)];
        return { id: s.id, lat: s.lat, lng: s.lng, groupId: s.groupId, ...(cached || {}) };
    });

    isSavingState = true;
    updateMap(); updateSidebar();
    // Se houver estações sem isócrona em cache, deixar a fila tratar disso e
    // chamar calculatePopulation() apenas no fim. Caso contrário, calcular já.
    const allCached = stations.every(s => hasValidCache(s));
    if (allCached) {
        calculatePopulation();
    }
    isSavingState = false;
}

// ============================================================
//                      STATIONS
// ============================================================
function addStation(lat, lng) {
    saveState();
    if (!activeGroupId || !groups.find(g => g.id === activeGroupId)) {
        if (groups.length > 0) {
            activeGroupId = groups[0].id;
        } else {
            createGroup(nextGroupName());
        }
    }
    const station = { id: Date.now(), lat, lng, groupId: activeGroupId };
    stations.push(station);
    updateMap(); updateSidebar(); renderGroups();
}

function removeStation(stationId) {
    saveState();
    stations = stations.filter(s => s.id !== stationId);
    updateMap(); updateSidebar(); calculatePopulation(); renderGroups();
}

function clearAllStations() {
    if (confirm('Tem a certeza que deseja remover todas as estações e grupos?')) {
        saveState();
        stations = [];
        groups.forEach(g => removeGroupRouteLayers(g.id));
        groups = [];
        activeGroupId = null;
        isochroneQueue = []; // discard any pending requests
        overlapData = {};
        jobsData = {};
        updateMap(); updateSidebar(); calculatePopulation(); renderGroups();
    }
}

// ============================================================
//                   MAP UPDATE & MARKERS
// ============================================================
function hasValidCache(station) {
    return station.isochrones && Array.isArray(station.isochrones) && station.isochrones.length >= 2 &&
           !station.isochroneError && station.cachedLat === station.lat && station.cachedLng === station.lng;
}

function areLayersOnMap(stationId) {
    const layers = stationIsochroneLayers[stationId] || [];
    return layers.filter(l => { try { return map.hasLayer(l); } catch { return false; } }).length >= 2;
}

function updateMap() {
    // Remove old markers
    stationMarkers.forEach(m => { try { if (map.hasLayer(m)) map.removeLayer(m); } catch {} });

    // Remove layers for deleted stations
    const existingIds = new Set(stations.map(s => String(s.id)));
    Object.keys(stationIsochroneLayers).forEach(sid => {
        if (!existingIds.has(String(sid))) {
            stationIsochroneLayers[sid].forEach(l => {
                try { if (map.hasLayer(l)) map.removeLayer(l); } catch {}
                const idx = isochroneLayers.indexOf(l);
                if (idx > -1) isochroneLayers.splice(idx, 1);
            });
            delete stationIsochroneLayers[sid];
        }
    });

    // Clean loading markers
    stations.forEach(s => {
        if (s.loadingMarker) { try { if (map.hasLayer(s.loadingMarker)) map.removeLayer(s.loadingMarker); } catch {} s.loadingMarker = null; }
        s.creatingIsochrones = false;
    });

    stationMarkers = [];

    stations.forEach(station => {
        const group = getGroupForStation(station);

        // Visibility check
        if (!group.visible) {
            // Hide isochrone layers if present
            (stationIsochroneLayers[station.id] || []).forEach(l => {
                try { if (map.hasLayer(l)) map.removeLayer(l); } catch {}
            });
            return;
        }

        const marker = createStationMarker(station, group.color);
        stationMarkers.push(marker);

        // Ensure isochrone layers are visible/colored correctly
        if (hasValidCache(station)) {
            if (!areLayersOnMap(station.id)) {
                drawCachedIsochrones(station, group.color);
            } else {
                // Re-style existing layers
                (stationIsochroneLayers[station.id] || []).forEach((l, i) => {
                    if (l.setStyle) {
                        const col = group.color;
                        l.setStyle({ color: col, fillColor: col, fillOpacity: i === 0 ? 0.2 : 0.12, weight: 2, opacity: i === 0 ? 0.8 : 0.6 });
                    }
                });
            }
        } else {
            initializeStationIsochrones(station);
        }
    });

    // Routes (cor / visibilidade podem ter mudado, ou existem grupos sem layer ainda)
    renderAllRoutes();
    // Garantir que rotas de grupos apagados são removidas do mapa
    Object.keys(groupRouteLayers).forEach(gid => {
        if (!groups.find(g => String(g.id) === String(gid))) removeGroupRouteLayers(gid);
    });
}

function createStationMarker(station, color) {
    const marker = L.marker([station.lat, station.lng], {
        draggable: true,
        icon: L.divIcon({
            className: 'station-marker',
            html: `<div style="background:${color};width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);"></div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        })
    }).addTo(map);

    let dragStartCoords = null;
    marker.on('dragstart', () => { isUpdating = true; dragStartCoords = { lat: station.lat, lng: station.lng }; });
    marker.on('drag', (e) => {
        station.lat = e.target.getLatLng().lat;
        station.lng = e.target.getLatLng().lng;
        const idx = stations.findIndex(s => s.id === station.id);
        if (idx !== -1) { stations[idx].lat = station.lat; stations[idx].lng = station.lng; }
    });
    marker.on('dragend', async (e) => {
        isUpdating = false;
        const nl = e.target.getLatLng();
        const idx = stations.findIndex(s => s.id === station.id);
        if (idx === -1) return;
        const cur = stations[idx];
        const moved = dragStartCoords && (Math.abs(dragStartCoords.lat - nl.lat) > 0.0001 || Math.abs(dragStartCoords.lng - nl.lng) > 0.0001);
        if (!moved) { cur.lat = dragStartCoords.lat; cur.lng = dragStartCoords.lng; dragStartCoords = null; calculatePopulation(); return; }
        cur.lat = nl.lat; cur.lng = nl.lng; dragStartCoords = null;
        saveState();
        removeStationIsochrones(cur.id);
        cur.isochrones = null; cur.cachedLat = null; cur.cachedLng = null; cur.isochroneError = null; cur.creatingIsochrones = false;
        await createIsochrones(cur, true);
        await calculatePopulation();
    });
    return marker;
}

// ============================================================
//                    ISOCHRONES
// ============================================================
function initializeStationIsochrones(station) {
    if (hasValidCache(station) && areLayersOnMap(station.id)) return;
    if (hasValidCache(station)) { drawCachedIsochrones(station, getGroupForStation(station).color); return; }
    enqueueIsochrone(station);
}

function enqueueIsochrone(station) {
    // Deduplicate: don't add if already queued or currently being created
    if (station.creatingIsochrones) return;
    if (isochroneQueue.some(s => s.id === station.id)) return;
    isochroneQueue.push(station);
    if (!isochroneQueueRunning) runIsochroneQueue();
}

// ============================================================
//               STATIONS LOADING OVERLAY
// ============================================================
function showStationsLoading(msg) {
    const overlay = document.getElementById('stations-loading-overlay');
    if (!overlay) return;
    // Reset to loading state (hide error state if previously shown)
    const loadingState = document.getElementById('stations-loading-state');
    const errorState   = document.getElementById('stations-error-state');
    if (loadingState) loadingState.classList.remove('hidden');
    if (errorState)   errorState.classList.add('hidden');
    document.getElementById('stations-loading-msg').textContent = msg || 'A calcular isócronas…';
    overlay.classList.add('visible');
    // Scroll the tab to the very top so the overlay is visible, then lock scrolling
    const tabEl = document.getElementById('tab-stations');
    if (tabEl) { tabEl.scrollTop = 0; tabEl.style.overflow = 'hidden'; }
}

function updateStationsLoadingMessage(msg) {
    const el = document.getElementById('stations-loading-msg');
    if (el) el.textContent = msg;
}

function showStationsLoadingError(msg) {
    const loadingState = document.getElementById('stations-loading-state');
    const errorState   = document.getElementById('stations-error-state');
    const errorMsg     = document.getElementById('stations-error-msg');
    if (loadingState) loadingState.classList.add('hidden');
    if (errorState)   errorState.classList.remove('hidden');
    if (errorMsg)     errorMsg.textContent = msg || 'Erro ao calcular empregos.';

    // Em estado de erro, devolver o scroll ao tab para o utilizador poder
    // navegar enquanto decide o que fazer
    const tabEl = document.getElementById('tab-stations');
    if (tabEl) tabEl.style.overflow = '';

    // Close button — just hides the overlay
    const closeBtn = document.getElementById('stations-error-close');
    if (closeBtn) {
        closeBtn.onclick = () => hideStationsLoading();
    }
    // Retry button — re-runs jobs calculation
    const retryBtn = document.getElementById('stations-retry-btn');
    if (retryBtn) {
        retryBtn.onclick = async () => {
            // Back to loading state
            if (loadingState) loadingState.classList.remove('hidden');
            if (errorState)   errorState.classList.add('hidden');
            updateStationsLoadingMessage('A calcular empregos…');
            const ok = await calculateJobs();
            if (ok) {
                hideStationsLoading();
            } else {
                showStationsLoadingError('Não foi possível calcular os empregos. Verifica a ligação à internet.');
            }
        };
    }
}

function hideStationsLoading() {
    const overlay = document.getElementById('stations-loading-overlay');
    if (overlay) overlay.classList.remove('visible');
    // Restore scroll on the tab
    const tabEl = document.getElementById('tab-stations');
    if (tabEl) tabEl.style.overflow = '';
}

async function runIsochroneQueue() {
    if (isochroneQueueRunning) return;
    isochroneQueueRunning = true;
    const totalInQueue = isochroneQueue.length;
    let doneCount = 0;
    while (isochroneQueue.length > 0) {
        const station = isochroneQueue.shift();
        // Skip if station was removed or already has a valid cache since it was enqueued
        if (!stations.find(s => s.id === station.id)) { doneCount++; continue; }
        if (hasValidCache(station)) { doneCount++; continue; }
        doneCount++;
        if (totalInQueue > 1) updateStationsLoadingMessage(`A calcular isócronas… ${doneCount} / ${totalInQueue}`);
        const fromCache = await createIsochrones(station);
        updateSidebar(); // progressive feedback
        // Only throttle when ORS was actually called — cache hits need no delay
        if (isochroneQueue.length > 0 && !fromCache) await new Promise(r => setTimeout(r, 350));
    }
    isochroneQueueRunning = false;
    updateStationsLoadingMessage('A calcular população…');
    await calculatePopulation(false);   // triggerJobs=false — jobs handled below
    updateStationsLoadingMessage('A calcular empregos…');
    const jobsOk = await calculateJobs();
    if (jobsOk) {
        hideStationsLoading();
    } else {
        showStationsLoadingError('Não foi possível calcular os empregos. Verifica a ligação à internet.');
    }
}

function drawCachedIsochrones(station, color) {
    if (!station.isochrones || station.isochrones.length < 2) return;
    if (!stationIsochroneLayers[station.id]) stationIsochroneLayers[station.id] = [];

    if (station.isochrones[0]) {
        const l = L.geoJSON(station.isochrones[0], { style: { color, fillColor: color, fillOpacity: 0.2, weight: 2, opacity: 0.8 } }).addTo(map);
        isochroneLayers.push(l); stationIsochroneLayers[station.id].push(l);
    }
    if (station.isochrones[1]) {
        const l = L.geoJSON(station.isochrones[1], { style: { color, fillColor: color, fillOpacity: 0.12, weight: 2, opacity: 0.6 } }).addTo(map);
        isochroneLayers.push(l); stationIsochroneLayers[station.id].push(l);
    }
}

async function createIsochrones(station, forceRefresh = false) {
    if (station.creatingIsochrones) return;
    const group = getGroupForStation(station);
    const color = group.color;

    if (!forceRefresh && hasValidCache(station)) {
        if (areLayersOnMap(station.id)) return;
        drawCachedIsochrones(station, color);
        return;
    }

    removeStationIsochrones(station.id);
    station.creatingIsochrones = true;

    try {
        const loadingMarker = L.marker([station.lat, station.lng], {
            icon: L.divIcon({
                className: 'loading-marker',
                html: '<div style="background:#ffa500;width:20px;height:20px;border-radius:50%;border:2px solid white;animation:pulse 1s infinite;"></div>',
                iconSize: [20, 20], iconAnchor: [10, 10]
            })
        }).addTo(map);
        station.loadingMarker = loadingMarker;

        const response = await fetch('/api/isochrones', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: station.lat, lng: station.lng, ranges: [300, 600] })
        });

        if (!response.ok) throw new Error('Erro ao obter isócronas');
        const data = await response.json();

        if (station.loadingMarker && map.hasLayer(station.loadingMarker)) map.removeLayer(station.loadingMarker);
        station.loadingMarker = null;

        if (!stationIsochroneLayers[station.id]) stationIsochroneLayers[station.id] = [];

        if (data.isochrones && data.isochrones[0]) {
            const l = L.geoJSON(data.isochrones[0], { style: { color, fillColor: color, fillOpacity: 0.2, weight: 2, opacity: 0.8 } }).addTo(map);
            isochroneLayers.push(l); stationIsochroneLayers[station.id].push(l);
        }
        if (data.isochrones && data.isochrones[1]) {
            const l = L.geoJSON(data.isochrones[1], { style: { color, fillColor: color, fillOpacity: 0.12, weight: 2, opacity: 0.6 } }).addTo(map);
            isochroneLayers.push(l); stationIsochroneLayers[station.id].push(l);
        }

        station.isochrones = data.isochrones || [];
        station.cachedLat = station.lat; station.cachedLng = station.lng; station.isochroneError = null;
        const idx = stations.findIndex(s => s.id === station.id);
        if (idx !== -1) { stations[idx].isochrones = station.isochrones; stations[idx].cachedLat = station.cachedLat; stations[idx].cachedLng = station.cachedLng; stations[idx].isochroneError = null; }
        return !!data.from_cache;  // signal to queue: no delay needed on cache hit
    } catch (error) {
        console.error('Erro ao criar isócronas:', error);
        if (station.loadingMarker && map.hasLayer(station.loadingMarker)) map.removeLayer(station.loadingMarker);
        station.loadingMarker = null;
        station.isochrones = null; station.isochroneError = error.message || 'Erro ao obter isócronas';
        const idx = stations.findIndex(s => s.id === station.id);
        if (idx !== -1) { stations[idx].isochrones = null; stations[idx].isochroneError = station.isochroneError; }
        if (!stationIsochroneLayers[station.id]) stationIsochroneLayers[station.id] = [];

        const errorMarker = L.marker([station.lat, station.lng], {
            icon: L.divIcon({
                className: 'error-marker',
                html: `<div style="background:#fc8181;width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);" title="Erro"></div>`,
                iconSize: [24, 24], iconAnchor: [12, 12]
            })
        }).addTo(map);
        errorMarker.bindPopup(`<div style="padding:8px;"><strong>Erro ao carregar isócronas</strong><br><small>${station.isochroneError}</small></div>`).openPopup();
        isochroneLayers.push(errorMarker); stationIsochroneLayers[station.id].push(errorMarker);
    } finally {
        station.creatingIsochrones = false;
    }
}

function removeStationIsochrones(stationId) {
    if (stationIsochroneLayers[stationId]) {
        stationIsochroneLayers[stationId].forEach(l => {
            try { if (map.hasLayer(l)) map.removeLayer(l); } catch {}
            const idx = isochroneLayers.indexOf(l);
            if (idx > -1) isochroneLayers.splice(idx, 1);
        });
        delete stationIsochroneLayers[stationId];
    }
    const s = stations.find(s => s.id === stationId);
    if (s && s.loadingMarker) { try { if (map.hasLayer(s.loadingMarker)) map.removeLayer(s.loadingMarker); } catch {} s.loadingMarker = null; }
}

// ============================================================
//      "PREENCHE POLÍGONO" OVERLAY (espelha o server-side)
// ============================================================
// Mantém-se sincronizado com server.py::_fill_polygon_for_station.
// Velocidade pedonal coerente com RADIUS_5MIN_M = 417 m (5 km/h ≈ 83.4 m/min).
const WALK_SPEED_KM_PER_MIN = 0.0834;

/**
 * Heurística "preenche o polígono" — versão JS para visualização.
 * Devolve um turf Feature<Polygon> com a porção da urb alcançável dentro
 * de `T_min` minutos pela estação, ou null se não for atingida.
 *
 * Algoritmo (turf, em km):
 *   - Estação dentro da urb: fill = urb ∩ buffer(estação, T·v)
 *   - Caso contrário: ponto mais próximo da fronteira da urb a partir da
 *     estação. Se cair dentro da isócrona ORS, esse é o ponto de entrada;
 *     reach = (T - d_entry/v) · v; fill = urb ∩ buffer(entry, reach).
 */
function fillPolygonForStation(stationLngLat, isoFeature, urbFeature, T_min) {
    if (!urbFeature || !urbFeature.geometry) return null;
    try {
        const stationPt = turf.point(stationLngLat);
        // Estação dentro do polígono da urb
        if (turf.booleanPointInPolygon(stationPt, urbFeature)) {
            const reachKm = T_min * WALK_SPEED_KM_PER_MIN;
            const reachBuf = turf.buffer(stationPt, reachKm, { units: 'kilometers' });
            return turf.intersect(urbFeature, reachBuf);
        }
        if (!isoFeature || !isoFeature.geometry) return null;
        // Ponto da fronteira da urb mais próximo da estação
        const urbBoundary = turf.polygonToLine(urbFeature);
        // polygonToLine devolve LineString para Polygon, MultiLineString para
        // MultiPolygon — ambos aceites por nearestPointOnLine
        const nearestPt = turf.nearestPointOnLine(urbBoundary, stationPt, { units: 'kilometers' });
        // Se o ponto mais próximo não está dentro da isócrona, a urb não é alcançada
        if (!turf.booleanPointInPolygon(nearestPt, isoFeature)) return null;
        const dEntryKm = nearestPt.properties.dist; // km
        const tEntry = dEntryKm / WALK_SPEED_KM_PER_MIN;
        const tRest = T_min - tEntry;
        if (tRest <= 0) return null;
        const reachKm = tRest * WALK_SPEED_KM_PER_MIN;
        const reachBuf = turf.buffer(nearestPt, reachKm, { units: 'kilometers' });
        return turf.intersect(urbFeature, reachBuf);
    } catch (e) {
        console.warn('fillPolygonForStation:', e);
        return null;
    }
}

function clearAugmentedOverlay() {
    Object.values(augmentedIsochroneLayers).forEach(arr => {
        arr.forEach(l => { try { if (map.hasLayer(l)) map.removeLayer(l); } catch {} });
    });
    augmentedIsochroneLayers = {};
}

/**
 * Recalcula e re-renderiza o overlay "preenche polígono" para todas as
 * estações com isócronas válidas. Chama-se sempre que urbs ou isócronas
 * mudam. Sem urbs ou com toggle desligado, apenas limpa.
 */
function refreshAugmentedIsochrones() {
    clearAugmentedOverlay();
    if (!showAugmentedOverlay || newUrbanizations.length === 0) return;

    const urbFeatures = newUrbanizations.map(u =>
        ({ type: 'Feature', geometry: u.geometry, properties: { id: u.id } })
    );

    stations.forEach(station => {
        if (!hasValidCache(station)) return;
        const group = getGroupForStation(station);
        if (!group || !group.visible) return;
        const color = group.color;
        const stationLngLat = [station.lng, station.lat];
        const iso5 = station.isochrones[0];
        const iso10 = station.isochrones[1];

        let union5 = null, union10 = null;
        urbFeatures.forEach(urb => {
            const f5 = fillPolygonForStation(stationLngLat, iso5, urb, 5.0);
            const f10 = fillPolygonForStation(stationLngLat, iso10, urb, 10.0);
            try { if (f5) union5 = union5 ? turf.union(union5, f5) : f5; } catch (e) { console.warn(e); }
            try { if (f10) union10 = union10 ? turf.union(union10, f10) : f10; } catch (e) { console.warn(e); }
        });

        // Subtrair a isócrona ORS para mostrar apenas a *extensão* (parte
        // adicionada pela heurística que ainda não estava coberta).
        let extra5 = null, extra10 = null;
        try { extra5 = union5 && iso5 ? turf.difference(union5, iso5) : union5; } catch { extra5 = union5; }
        try {
            // O anel 10 min não deve sobrepor o overlay de 5 min
            let base10 = union10;
            if (base10 && iso10) { try { base10 = turf.difference(base10, iso10); } catch {} }
            if (base10 && union5) { try { base10 = turf.difference(base10, union5); } catch {} }
            extra10 = base10;
        } catch { extra10 = union10; }

        const layers = [];
        if (extra5) {
            const l = L.geoJSON(extra5, {
                style: { color, fillColor: color, fillOpacity: 0.18, weight: 1.5, opacity: 0.9, dashArray: '4,3' }
            }).addTo(map);
            layers.push(l);
        }
        if (extra10) {
            const l = L.geoJSON(extra10, {
                style: { color, fillColor: color, fillOpacity: 0.10, weight: 1.5, opacity: 0.7, dashArray: '4,3' }
            }).addTo(map);
            layers.push(l);
        }
        if (layers.length > 0) augmentedIsochroneLayers[station.id] = layers;
    });
}

// ============================================================
//                  POPULATION CALCULATION
// ============================================================
async function calculatePopulation(triggerJobs = true) {
    if (stations.length === 0) {
        // Repor totais para que o cartão de cobertura (que lê de globalPopStats)
        // reflita o estado vazio em vez de manter os valores anteriores.
        globalPopStats = { total_population: 0, total_population_5min: 0, total_population_10min: 0, points: [], groups: [] };
        // Limpar empregos/mix de usos para que o cartão de estatísticas
        // não fique com valores das estações entretanto removidas.
        jobsData = {};
        updateJobsSummary();
        updateCoverageCard();
        updateSidebarStats(globalPopStats);
        renderUncoveredBgris();
        updateSidebar();
        return;
    }

    try {
        const payload = {
            points: stations.map(s => ({
                id: s.id, lat: s.lat, lng: s.lng,
                group_id: s.groupId,
                isochrones: (s.isochrones && !s.isochroneError && Array.isArray(s.isochrones) && s.isochrones.length >= 2) ? s.isochrones : null
            }))
        };

        // Include scenario overrides if any exist
        if (Object.keys(densityOverrides).length > 0) {
            payload.density_overrides = densityOverrides;
        }
        if (newUrbanizations.length > 0) {
            payload.new_urbanization_features = newUrbanizations.map(u => ({
                type: 'Feature',
                geometry: u.geometry,
                properties: { estimated_pop: u.estimatedPop, name: u.name }
            }));
        }

        const data = await fetchJSON('/api/population-in-isochrones', { body: payload });

        stations = stations.map(station => {
            const pd = data.points.find(p => String(p.id) === String(station.id));
            if (pd) {
                return { ...station, population_5min: Number(pd.population_5min) || 0, population_10min: Number(pd.population_10min) || 0, population_total: Number(pd.population_total) || 0 };
            }
            return { ...station, population_5min: Number(station.population_5min) || 0, population_10min: Number(station.population_10min) || 0, population_total: Number(station.population_total) || 0 };
        });

        globalPopStats = data;   // persist union-based totals for exportReport
        updateSidebarStats(data);
        updateSidebar();
        renderUncoveredBgris();
        // Atualizar overlay "preenche polígono" — depende de stations[i].isochrones
        // estar populado, o que só acontece após os pontos terem isócronas.
        refreshAugmentedIsochrones();

        // Calculate jobs after population is known (non-blocking, unless suppressed)
        if (triggerJobs) calculateJobs();
    } catch (error) {
        console.error('Erro ao calcular população:', error);
        stations = stations.map(s => ({ ...s, population_5min: Number(s.population_5min) || 0, population_10min: Number(s.population_10min) || 0, population_total: Number(s.population_total) || 0 }));
        updateSidebarStats({ total_population: 0, total_population_5min: 0, total_population_10min: 0, points: stations.map(s => ({ id: s.id, population_5min: s.population_5min || 0, population_10min: s.population_10min || 0, population_total: s.population_total || 0 })) });
        updateSidebar();
    }
}

// ============================================================
//               JOBS / MIX DE USOS
// ============================================================
async function calculateJobs() {
    if (stations.length === 0) {
        jobsData = {};
        updateJobsSummary();
        updateSidebar();
        return;
    }

    const payload = {
        stations: stations.map(s => ({
            id: s.id,
            lat: s.lat,
            lng: s.lng,
            isochrones: (s.isochrones && !s.isochroneError && Array.isArray(s.isochrones) && s.isochrones.length >= 2)
                ? s.isochrones : null,
            population_5min: s.population_5min || 0,
        }))
    };

    let success = true;
    try {
        const data = await fetchJSON('/api/jobs-in-isochrones', { body: payload });
        jobsData = {};
        (data.stations || []).forEach(s => { jobsData[String(s.id)] = s; });
    } catch (e) {
        console.error('Erro ao calcular empregos:', e);
        success = false;
    }

    if (jobsPOIVisible) renderPOILayer();
    updateJobsSummary();
    updateSidebar();
    computeOverlaps();
    // Refresh scenario ΔH now that jobsData is populated
    if (activeTab === 'scenario') updateScenarioSummary();
    return success;
}

function updateJobsSummary() {
    const totalJobsEl = document.getElementById('total-jobs');
    const avgHEl      = document.getElementById('avg-shannon-h');
    if (!totalJobsEl || !avgHEl) return;

    const entries = Object.values(jobsData);
    if (entries.length === 0) {
        totalJobsEl.textContent = '—';
        avgHEl.textContent = '—';
        return;
    }

    // De-duplicate POIs across all stations by osm_id to avoid cross-station double-counting
    const seen = new Map();
    entries.forEach(e => {
        (e.pois || []).forEach(p => {
            if (p.osm_id && !seen.has(p.osm_id)) seen.set(p.osm_id, p.jobs || 0);
        });
    });
    // Fallback to naive sum only if no osm_id data (e.g. stale cache)
    const totalJobs = seen.size > 0
        ? Array.from(seen.values()).reduce((s, v) => s + v, 0)
        : entries.reduce((s, e) => s + (e.jobs_total || 0), 0);

    const avgH = entries.reduce((s, e) => s + (e.shannon_h || 0), 0) / entries.length;
    totalJobsEl.textContent = formatNumber(totalJobs);
    avgHEl.textContent      = avgH.toFixed(2);
    updateCoverageCard();
}

function renderPOILayer() {
    if (jobsPOILayer) { map.removeLayer(jobsPOILayer); jobsPOILayer = null; }
    if (!jobsPOIVisible) return;

    const CAT_COLORS = {
        commerce:         '#ed8936',
        services:         '#3182ce',
        education_health: '#38a169',
        culture_leisure:  '#9f7aea',
        industry:         '#718096',
    };
    const CAT_LABELS = {
        commerce:         'Comércio / Restauração',
        services:         'Serviços / Escritórios',
        education_health: 'Educação / Saúde',
        culture_leisure:  'Cultura / Lazer',
        industry:         'Indústria / Logística',
    };

    const group = L.layerGroup();
    Object.values(jobsData).forEach(sd => {
        (sd.pois || []).forEach(poi => {
            const col = CAT_COLORS[poi.category] || '#a0aec0';
            const m = L.circleMarker([poi.lat, poi.lng], {
                radius: 5,
                fillColor: col,
                color: '#fff',
                weight: 1,
                fillOpacity: 0.85,
            });
            const label = CAT_LABELS[poi.category] || poi.category;
            m.bindPopup(
                `<div style="min-width:140px;">`+
                `<strong>${poi.name || '(sem nome)'}</strong><br>`+
                `<span style="color:${col};font-weight:600;">${label}</span><br>`+
                `<small>~${poi.jobs} emprego${poi.jobs !== 1 ? 's' : ''} estimado${poi.jobs !== 1 ? 's' : ''}</small>`+
                `</div>`
            );
            group.addLayer(m);
        });
    });
    jobsPOILayer = group;
    map.addLayer(jobsPOILayer);
}

function togglePOILayer() {
    jobsPOIVisible = !jobsPOIVisible;
    const btn = document.getElementById('btn-toggle-pois');
    if (btn) btn.textContent = jobsPOIVisible ? '📍 Ocultar POIs' : '📍 Ver POIs no mapa';
    renderPOILayer();
}

// ============================================================
//                  OVERLAP ANALYSIS
// ============================================================
function computeOverlaps() {
    overlapData = {};
    const valid = stations.filter(s =>
        s.isochrones && Array.isArray(s.isochrones) && s.isochrones.length >= 1 && !s.isochroneError
    );
    if (valid.length < 2) { updateSidebar(); return; }

    // Name lookup: id → display name
    const nameOf = {};
    stations.forEach((s, idx) => { nameOf[s.id] = s.name || ('Estação ' + (idx + 1)); });

    for (let i = 0; i < valid.length; i++) {
        for (let j = i + 1; j < valid.length; j++) {
            const A = valid[i], B = valid[j];
            try {
                const intersection = turf.intersect(A.isochrones[0], B.isochrones[0]);
                if (!intersection) continue;
                const intersectArea = turf.area(intersection);
                if (intersectArea <= 0) continue;
                const areaA = turf.area(A.isochrones[0]);
                const areaB = turf.area(B.isochrones[0]);
                const fracA = areaA > 0 ? intersectArea / areaA : 0;
                const fracB = areaB > 0 ? intersectArea / areaB : 0;
                if (fracA >= 0.1) {
                    if (!overlapData[String(A.id)]) overlapData[String(A.id)] = [];
                    overlapData[String(A.id)].push({
                        withId: B.id, withName: nameOf[B.id],
                        areaFraction: fracA,
                        sharedPop: Math.round((A.population_5min || 0) * fracA)
                    });
                }
                if (fracB >= 0.1) {
                    if (!overlapData[String(B.id)]) overlapData[String(B.id)] = [];
                    overlapData[String(B.id)].push({
                        withId: A.id, withName: nameOf[A.id],
                        areaFraction: fracB,
                        sharedPop: Math.round((B.population_5min || 0) * fracB)
                    });
                }
            } catch (e) {
                // Skip pairs with invalid geometries
            }
        }
    }
    updateSidebar();
}

async function importGTFS(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;

    if (stations.length > 0 || groups.length > 0) {
        const ok = confirm(`A importação GTFS irá substituir as ${stations.length} estação/ões e ${groups.length} grupo(s) existentes. Continuar?`);
        if (!ok) return;
    }

    const formData = new FormData();
    formData.append('file', file);

    let data;
    try {
        const res = await fetch('/api/import-gtfs', { method: 'POST', body: formData });
        data = await res.json();
        if (!res.ok) { alert('Erro: ' + (data.error || 'Erro desconhecido')); return; }
    } catch (e) {
        toast('Erro de rede ao enviar ficheiro GTFS.', 'error');
        return;
    }

    if (!data.routes || data.routes.length === 0) {
        toast('Nenhuma linha com paragens encontrada dentro da área de Évora.', 'warning');
        return;
    }

    // Save current state for undo, then wipe everything before repopulating
    saveState();
    stations = [];
    groups = [];
    activeGroupId = null;
    isochroneQueue = [];
    overlapData = {};
    jobsData = {};

    let addedStations = 0;
    data.routes.forEach((route, routeIndex) => {
        const colorHex = route.color && /^#[0-9A-Fa-f]{6}$/.test(route.color)
            ? route.color
            : GROUP_COLORS[routeIndex % GROUP_COLORS.length];
        const groupId = Date.now() + Math.floor(Math.random() * 1e6);
        groups.push({ id: groupId, name: route.name, color: colorHex, visible: true });
        route.stops.forEach(stop => {
            stations.push({
                id: Date.now() + Math.floor(Math.random() * 1e6),
                lat: stop.lat,
                lng: stop.lng,
                groupId,
                name: stop.name
            });
            addedStations++;
        });
    });

    if (!activeGroupId && groups.length > 0) activeGroupId = groups[0].id;
    saveState();
    showStationsLoading(`A calcular isócronas para ${addedStations} paragem(ns)…`);
    renderGroups();
    updateMap();     // enqueues isochrone fetches for all new stations (sequential, 350 ms apart)
    updateSidebar();
    // calculatePopulation() is intentionally NOT called here:
    // runIsochroneQueue() calls it once after all isochrones are ready.

    const skipNote = data.skipped_stops > 0 ? ` (${data.skipped_stops} fora da área ignoradas)` : '';
    toast(`GTFS importado: ${data.total_routes} linha(s), ${addedStations} paragem(ns).${skipNote}`, 'success', 5000);
}

// ============================================================
//                      SIDEBAR
// ============================================================
function updateSidebarStats(data) {
    document.getElementById('total-population').textContent = formatNumber(data.total_population);
    document.getElementById('total-pop-5min').textContent = formatNumber(data.total_population_5min);
    document.getElementById('total-pop-10min').textContent = formatNumber(data.total_population_10min);
    updateCoverageCard();
}

/**
 * Atualiza o cartão de cobertura da rede com populaçao e empregos.
 * Pode ser chamada independentemente após mudar globalPopStats ou jobsData.
 */
function updateCoverageCard() {
    const popEl   = document.getElementById('coverage-pop-value');
    const popBar  = document.getElementById('coverage-pop-bar');
    const jobsEl  = document.getElementById('coverage-jobs-value');
    const jobsBar = document.getElementById('coverage-jobs-bar');
    if (!popEl) return;

    // Pop abrangida = isócrona de 5 min (sem dupla contagem, vem do servidor)
    const coveredPop = globalPopStats.total_population_5min || 0;
    if (cityTotalPop > 0 && coveredPop > 0) {
        const pct = Math.min(100, (coveredPop / cityTotalPop) * 100);
        popEl.textContent  = `${formatNumber(coveredPop)} (${pct.toFixed(1)}%)`;
        popBar.style.width = `${pct.toFixed(1)}%`;
    } else if (coveredPop > 0) {
        popEl.textContent  = formatNumber(coveredPop);
        popBar.style.width = '0%';
    } else {
        popEl.textContent  = '—';
        popBar.style.width = '0%';
    }

    // Empregos: de-duplicate POIs por osm_id
    const seen = new Map();
    Object.values(jobsData).forEach(e => {
        (e.pois || []).forEach(p => {
            if (p.osm_id && !seen.has(p.osm_id)) seen.set(p.osm_id, p.jobs || 0);
        });
    });
    const coveredJobs = seen.size > 0
        ? Array.from(seen.values()).reduce((s, v) => s + v, 0)
        : Object.values(jobsData).reduce((s, e) => s + (e.jobs_total || 0), 0);

    if (coveredJobs > 0) {
        const pct = Math.min(100, (coveredJobs / CITY_TOTAL_JOBS) * 100);
        jobsEl.textContent  = `${formatNumber(coveredJobs)} (${pct.toFixed(1)}%)`;
        jobsBar.style.width = `${pct.toFixed(1)}%`;
    } else {
        jobsEl.textContent  = '—';
        jobsBar.style.width = '0%';
    }
}

// ─── Categorias de empregos (rótulos PT) ──────────────────────────────────
const JOB_CATEGORY_LABELS = {
    commerce:         'Comércio',
    services:         'Serviços',
    education_health: 'Educação / Saúde',
    culture_leisure:  'Cultura / Lazer',
    industry:         'Indústria',
};

/**
 * HTML do bloco de empregos (Shannon H + auto-suficiência) para uma estação.
 * @param {object|null} jd  Dados de empregos (entrada de jobsData[stationId]) ou undefined.
 * @returns {string}        HTML pronto a injetar; vazio se sem dados.
 */
function renderJobsSection(jd) {
    if (!jd) return '';
    const hPct       = Math.round((jd.shannon_h || 0) * 100);
    const hTier      = tierClass(jd.shannon_h, 0.6, 0.3);
    const ssTier     = tierClass(jd.self_sufficiency, 0.4, 0.2);
    const breakdown  = Object.entries(jd.jobs_breakdown || {})
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a)
        .map(([k, v]) => statRow(`↳ ${JOB_CATEGORY_LABELS[k] || k}:`, formatNumber(v), { sub: true }))
        .join('');
    const warning = jd.low_coverage_warning
        ? `<div class="jobs-warning">⚠️ Cobertura OSM limitada — estimativa indicativa (${jd.poi_count} POIs)</div>` : '';
    return `
        <div class="station-jobs-section">
            <div class="station-jobs-header">Empregos estimados (5 min)</div>
            ${warning}
            ${statRow('Total empregos:', formatNumber(jd.jobs_total))}
            ${breakdown}
            ${statRow(
                'Mix de usos (H):',
                `${jd.shannon_h.toFixed(2)} <span class="tod-tag">(${jd.tod_classification})</span>`,
                { valueClass: hTier, raw: true }
            )}
            <div class="h-bar-bg"><div class="h-bar-fill ${hTier}-bg" style="width:${hPct}%"></div></div>
            ${statRow('Auto-suficiência:', jd.self_sufficiency.toFixed(2), { valueClass: ssTier })}
        </div>
    `;
}

/**
 * HTML dos badges de sobreposição entre isócronas de 5 min.
 * @param {Array} overlaps  Lista de objetos { withName, areaFraction, sharedPop } ou vazia.
 */
function renderOverlapBadges(overlaps) {
    if (!overlaps || overlaps.length === 0) return '';
    return overlaps.map(ov => {
        const pct = Math.round(ov.areaFraction * 100);
        const cls = ov.areaFraction >= 0.4 ? 'danger' : 'warning';
        const icon = cls === 'danger' ? '⛔' : '⚠️';
        const popNote = ov.sharedPop > 0 ? ' · ' + formatNumber(ov.sharedPop) + ' hab' : '';
        return `<div class="overlap-badge ${cls}">${icon} Sobreposição com ${escapeHtml(ov.withName)}: ${pct}% área${popNote}</div>`;
    }).join('');
}

/**
 * HTML completo de um cartão de estação no painel lateral.
 * @param {object} station
 * @param {number} index   Índice na lista (1-based para o nome default).
 */
function renderStationCard(station, index) {
    const group = getGroupForStation(station);
    const pop5  = station.population_5min  || 0;
    const pop10 = station.population_10min || 0;
    const popT  = station.population_total || 0;
    const hasError = station.isochroneError;

    const stationName = escapeHtml(station.name || ('Estação ' + (index + 1)));
    const errorBlock = hasError
        ? `<div class="station-error-message">⚠️ ${escapeHtml(station.isochroneError)}</div>` : '';

    return `
        <div class="station-item ${hasError ? 'station-error' : ''}">
            <div class="station-item-header">
                <span class="station-name"><span class="station-group-dot" style="background:${group.color}"></span> ${stationName}${hasError ? ' ⚠️' : ''}</span>
                <button class="btn-remove" onclick="removeStation(${station.id})" title="Remover">×</button>
            </div>
            ${errorBlock}
            <div class="station-stats">
                ${statRow('Área Primária (5 min):', formatNumber(pop5))}
                ${statRow('Área Secundária (10 min):', formatNumber(pop10))}
                ${statRow('Total:', formatNumber(popT), { total: true })}
            </div>
            ${renderJobsSection(jobsData[String(station.id)])}
            ${renderOverlapBadges(overlapData[String(station.id)])}
        </div>
    `;
}

/**
 * HTML dos cartões "estatísticas por linha" no topo do painel.
 * Usa totais por união do servidor (groups[]) com fallback para soma por estação
 * apenas quando o backend ainda não respondeu.
 */
function renderGroupStats() {
    const groupTotalsById = {};
    if (globalPopStats && Array.isArray(globalPopStats.groups)) {
        globalPopStats.groups.forEach(g => { groupTotalsById[g.id] = g; });
    }
    return groups.map(g => {
        const groupStations = stations.filter(s => s.groupId === g.id);
        if (groupStations.length === 0) return '';
        const t = groupTotalsById[g.id];
        const pop5  = t ? t.total_population_5min  : groupStations.reduce((sum, s) => sum + (s.population_5min  || 0), 0);
        const pop10 = t ? t.total_population_10min : groupStations.reduce((sum, s) => sum + (s.population_10min || 0), 0);
        const total = t ? t.total_population       : (pop5 + pop10);
        const item = (label, value, isTotal) =>
            `<span class="breakdown-item${isTotal ? ' is-total' : ''}"><span class="breakdown-label">${label}:</span><span class="breakdown-value">${formatNumber(value)}</span></span>`;
        return `
            <div class="stat-card group-stat-card" style="border-left: 4px solid ${g.color};">
                <div class="group-stat-header">
                    <div class="group-stat-color" style="background:${g.color}"></div>
                    <span class="group-stat-name">${escapeHtml(g.name)}</span>
                    <span class="group-stat-count">${groupStations.length} est.</span>
                </div>
                <div class="stat-breakdown">
                    ${item('5 min', pop5)}
                    ${item('10 min', pop10)}
                    ${item('Total', total, true)}
                </div>
            </div>
        `;
    }).join('');
}

function updateSidebar() {
    document.getElementById('group-stats-container').innerHTML = renderGroupStats();

    const container = document.getElementById('stations-container');
    if (stations.length === 0) {
        container.innerHTML = '<p class="no-stations">Nenhuma estação adicionada</p>';
        return;
    }
    container.innerHTML = stations.map((s, i) => renderStationCard(s, i)).join('');
}

// ============================================================
//            SCENARIO MODE — CENSUS LAYER
// ============================================================
async function loadCensusLayer() {
    if (censusLayer) return; // already loaded

    try {
        censusGeoJSON = await fetchJSON('/api/census-geojson');

        censusLayer = L.geoJSON(censusGeoJSON, {
            pane: 'censusPane',
            style: (feature) => getCensusStyle(feature),
            onEachFeature: (feature, layer) => {
                layer.on('click', (e) => {
                    if (activeTab === 'scenario') {
                        L.DomEvent.stopPropagation(e);
                        selectCensusFeature(feature, layer);
                    }
                });
            }
        }).addTo(map);

        // Bring existing isochrone layers to the front so they're not buried by the census layer
        isochroneLayers.forEach(l => { try { l.bringToFront(); } catch {} });

    } catch (err) {
        console.error('Erro ao carregar camada de censos:', err);
    }
}

function removeCensusLayer() {
    clearUncoveredHighlight();
    if (censusLayer) { map.removeLayer(censusLayer); censusLayer = null; }
}

function getCensusStyle(feature) {
    const props = feature.properties;
    const bgriId = props.BGRI2021 || props.SUBSECCAO || props.OBJECTID;
    const override = densityOverrides[bgriId];

    if (override) {
        const dt = DENSITY_TYPES[override.densityType];
        return { color: '#333', weight: 1, fillColor: dt.color, fillOpacity: 0.55 };
    }

    // Default: choropleth by population density
    const pop = props.N_INDIVIDUOS || 0;
    const area_m2 = props.SHAPE_Area || 1;
    const area_ha = area_m2 / 10000;
    const density = area_ha > 0 ? pop / area_ha : 0;

    let fillColor = '#e2e8f0';
    if (density > 300) fillColor = '#e53e3e';
    else if (density > 200) fillColor = '#ed8936';
    else if (density > 100) fillColor = '#f6e05e';
    else if (density > 50) fillColor = '#9ae6b4';
    else if (density > 10) fillColor = '#c6f6d5';

    return { color: '#718096', weight: 0.5, fillColor, fillOpacity: 0.35 };
}

function selectCensusFeature(feature, layer) {
    // Deselect any uncovered BGRI highlight so styles don't conflict
    clearUncoveredHighlight();
    // Restore style of previously selected layer before switching
    if (selectedCensusFeature && selectedCensusFeature.layer !== layer) {
        selectedCensusFeature.layer.setStyle(getCensusStyle(selectedCensusFeature.feature));
    }

    selectedCensusFeature = { feature, layer };

    // Highlight the selected BGRI with a distinct ring
    layer.setStyle({ color: '#4c51bf', weight: 3, dashArray: null, fillOpacity: 0.2 });
    layer.bringToFront();

    const props = feature.properties;
    const bgriId = props.BGRI2021 || props.SUBSECCAO || props.OBJECTID;
    const pop = props.N_INDIVIDUOS || 0;
    const area_m2 = props.SHAPE_Area || 1;
    const area_ha = area_m2 / 10000;
    const density = area_ha > 0 ? (pop / area_ha).toFixed(1) : '—';

    document.getElementById('edit-bgri-id').textContent = bgriId;
    document.getElementById('edit-current-pop').textContent = formatNumber(pop);
    document.getElementById('edit-area').textContent = area_ha.toFixed(2);
    document.getElementById('edit-current-density').textContent = density;

    const override = densityOverrides[bgriId];
    const sel = document.getElementById('edit-density-select');
    sel.value = override ? override.densityType : '';

    // Coverage slider: show only when a density type is selected
    const coverageField = document.getElementById('edit-coverage-field');
    const coverageSlider = document.getElementById('edit-coverage');
    const coverageLabel = document.getElementById('edit-coverage-value');
    if (override) {
        const savedCoverage = override.coverage !== undefined ? override.coverage : 40;
        coverageSlider.value = savedCoverage;
        coverageLabel.textContent = savedCoverage + '%';
        coverageField.classList.remove('hidden');
    } else {
        coverageSlider.value = 40;
        coverageLabel.textContent = '40%';
        coverageField.classList.add('hidden');
    }
    updateEstimatedPop();

    // Show revert button only when an override is active for this BGRI
    document.getElementById('btn-revert-density').classList.toggle('hidden', !override);

    document.getElementById('edit-panel').classList.remove('hidden');
}

function updateEstimatedPop() {
    const sel = document.getElementById('edit-density-select');
    const typeIdx = parseInt(sel.value);
    if (isNaN(typeIdx) || !selectedCensusFeature) {
        document.getElementById('edit-estimated-pop').textContent = '—';
        return;
    }
    const dt = DENSITY_TYPES[typeIdx];
    const area_m2 = selectedCensusFeature.feature.properties.SHAPE_Area || 1;
    const area_ha = area_m2 / 10000;
    const coverage = parseInt(document.getElementById('edit-coverage').value) / 100;
    const est = Math.round(dt.residents_ha * area_ha * coverage);
    document.getElementById('edit-estimated-pop').textContent = formatNumber(est);
}

function applyDensityEdit() {
    if (!selectedCensusFeature) return;
    const sel = document.getElementById('edit-density-select');
    const typeIdx = parseInt(sel.value);
    if (isNaN(typeIdx)) return;

    const props = selectedCensusFeature.feature.properties;
    const bgriId = props.BGRI2021 || props.SUBSECCAO || props.OBJECTID;
    const dt = DENSITY_TYPES[typeIdx];
    const area_m2 = props.SHAPE_Area || 1;
    const area_ha = area_m2 / 10000;
    const coverage = parseInt(document.getElementById('edit-coverage').value) / 100;
    const newPop = Math.round(dt.residents_ha * area_ha * coverage);

    densityOverrides[bgriId] = { densityType: typeIdx, coverage: parseInt(document.getElementById('edit-coverage').value), populationOverride: newPop };

    // Re-style layer
    selectedCensusFeature.layer.setStyle({ color: '#333', weight: 1, fillColor: dt.color, fillOpacity: 0.55 });

    cancelEdit();
    updateScenarioSummary();
}

function revertDensityEdit() {
    if (!selectedCensusFeature) return;
    const props = selectedCensusFeature.feature.properties;
    const bgriId = props.BGRI2021 || props.SUBSECCAO || props.OBJECTID;

    delete densityOverrides[bgriId];

    // Restore original choropleth style
    selectedCensusFeature.layer.setStyle(getCensusStyle(selectedCensusFeature.feature));

    cancelEdit();
    updateScenarioSummary();
}

function cancelEdit() {
    if (selectedCensusFeature) {
        selectedCensusFeature.layer.setStyle(getCensusStyle(selectedCensusFeature.feature));
    }
    selectedCensusFeature = null;
    document.getElementById('edit-panel').classList.add('hidden');
}

// ============================================================
//             SCENARIO MODE — URBANIZATIONS
// ============================================================
function startDrawUrbanization() {
    isDrawingUrbanization = true;
    // Enable polygon drawing
    const drawHandler = new L.Draw.Polygon(map, {
        shapeOptions: { color: '#38a169', weight: 2, fillOpacity: 0.3 }
    });
    drawHandler.enable();
}

function showUrbanizationModal(existing = null) {
    const modal = document.getElementById('urbanization-modal');
    const titleEl = modal.querySelector('h2');
    const btnConfirm = document.getElementById('btn-create-urbanization');
    if (existing) {
        editingUrbanizationId = existing.id;
        pendingUrbanizationGeometry = existing.geometry;
        document.getElementById('urb-name').value = existing.name;
        document.getElementById('urb-density-type').value = String(existing.densityType);
        document.getElementById('urb-coverage').value = existing.coverage;
        document.getElementById('urb-diffuse').checked = !!existing.diffuse;
        if (titleEl) titleEl.textContent = 'Editar Urbanização';
        if (btnConfirm) btnConfirm.textContent = 'Guardar';
    } else {
        editingUrbanizationId = null;
        document.getElementById('urb-name').value = `Urbanização ${newUrbanizations.length + 1}`;
        if (titleEl) titleEl.textContent = 'Nova Urbanização';
        if (btnConfirm) btnConfirm.textContent = 'Criar';
    }
    modal.classList.remove('hidden');
    updateUrbanizationEstimate();
}

function updateUrbanizationEstimate() {
    const coverageSlider = document.getElementById('urb-coverage');
    document.getElementById('urb-coverage-value').textContent = coverageSlider.value + '%';

    if (!pendingUrbanizationGeometry) {
        document.getElementById('urb-estimated-pop').textContent = '—';
        return;
    }

    const typeIdx = parseInt(document.getElementById('urb-density-type').value);
    if (isNaN(typeIdx)) { document.getElementById('urb-estimated-pop').textContent = '—'; return; }

    const dt = DENSITY_TYPES[typeIdx];
    const area = turf.area(pendingUrbanizationGeometry); // m²
    const area_ha = area / 10000;
    const coverage = parseInt(coverageSlider.value) / 100;

    const est = Math.round(dt.residents_ha * area_ha * coverage);
    document.getElementById('urb-estimated-pop').textContent = formatNumber(Math.max(0, est));
}

function confirmUrbanization() {
    if (!pendingUrbanizationGeometry) return;

    const editingIdx = editingUrbanizationId !== null
        ? newUrbanizations.findIndex(u => u.id === editingUrbanizationId)
        : -1;
    const isEditing = editingIdx !== -1;

    const name = document.getElementById('urb-name').value || `Urbanização ${newUrbanizations.length + 1}`;
    const typeIdx = parseInt(document.getElementById('urb-density-type').value);
    const coverage = parseInt(document.getElementById('urb-coverage').value);
    const diffuse = document.getElementById('urb-diffuse').checked;

    const dt = DENSITY_TYPES[typeIdx] || DENSITY_TYPES[2];
    const area = turf.area(pendingUrbanizationGeometry);
    const area_ha = area / 10000;
    const est = Math.round(dt.residents_ha * area_ha * (coverage / 100));

    // If editing, remove the old layers from the map and from the global tracker
    if (isEditing) {
        const old = newUrbanizations[editingIdx];
        old.layers.forEach(l => { try { map.removeLayer(l); } catch {} });
        urbanizationLayers = urbanizationLayers.filter(l => !old.layers.includes(l));
    }

    const urb = {
        id: isEditing ? editingUrbanizationId : Date.now(),
        name,
        geometry: pendingUrbanizationGeometry,
        densityType: typeIdx,
        coverage,
        diffuse,
        estimatedPop: Math.max(0, est),
        layers: []
    };

    // Draw on map
    const coreLayer = L.geoJSON({ type: 'Feature', geometry: pendingUrbanizationGeometry, properties: {} }, {
        style: { color: '#276749', weight: 2, fillColor: dt.color, fillOpacity: 0.45, dashArray: '5,5' }
    }).addTo(map);

    // Add label
    const center = turf.centroid({ type: 'Feature', geometry: pendingUrbanizationGeometry, properties: {} });
    const labelMarker = L.marker([center.geometry.coordinates[1], center.geometry.coordinates[0]], {
        icon: L.divIcon({
            className: '',
            html: `<div style="display:inline-block;background:rgba(39,103,73,0.85);color:white;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.3);">${escapeHtml(name)}: ${formatNumber(est)} hab</div>`,
            iconSize: null,
            iconAnchor: [0, 0]
        })
    }).addTo(map);

    urb.layers = [coreLayer, labelMarker];
    urbanizationLayers.push(coreLayer, labelMarker);

    // Diffusion rings
    if (diffuse) {
        const rings = [
            { dist: 0.05, opacity: 0.25 },
            { dist: 0.1,  opacity: 0.15 },
            { dist: 0.2,  opacity: 0.08 }
        ];
        rings.forEach(r => {
            try {
                const buffered = turf.buffer(pendingUrbanizationGeometry, r.dist, { units: 'kilometers' });
                const ringLayer = L.geoJSON(buffered, {
                    style: { color: dt.color, weight: 0.5, fillColor: dt.color, fillOpacity: r.opacity, dashArray: '2,4' }
                }).addTo(map);
                urb.layers.push(ringLayer);
                urbanizationLayers.push(ringLayer);
            } catch (e) {
                console.warn('Diffusion ring error:', e);
            }
        });
    }

    newUrbanizations.push(urb);
    if (isEditing) {
        // Replace the old entry with the rebuilt one (preserving its position in the list)
        const last = newUrbanizations.pop();
        newUrbanizations[editingIdx] = last;
    }

    // Cleanup
    drawnItems.clearLayers();
    pendingUrbanizationGeometry = null;
    isDrawingUrbanization = false;
    editingUrbanizationId = null;
    document.getElementById('urbanization-modal').classList.add('hidden');
    renderUrbanizations();
    refreshAugmentedIsochrones();
    updateScenarioSummary();
}

function cancelUrbanization() {
    drawnItems.clearLayers();
    pendingUrbanizationGeometry = null;
    isDrawingUrbanization = false;
    editingUrbanizationId = null;
    document.getElementById('urbanization-modal').classList.add('hidden');
}

function removeUrbanization(urbId) {
    const idx = newUrbanizations.findIndex(u => u.id === urbId);
    if (idx === -1) return;
    const urb = newUrbanizations[idx];
    urb.layers.forEach(l => { try { map.removeLayer(l); } catch {} });
    newUrbanizations.splice(idx, 1);
    renderUrbanizations();
    refreshAugmentedIsochrones();
    updateScenarioSummary();
}

function renderUrbanizations() {
    const container = document.getElementById('urbanizations-list');
    if (newUrbanizations.length === 0) {
        container.innerHTML = '<p class="no-stations">Nenhuma urbanização criada</p>';
        return;
    }
    container.innerHTML = newUrbanizations.map(u => {
        const dt = DENSITY_TYPES[u.densityType] || DENSITY_TYPES[2];
        return `
            <div class="urbanization-item">
                <div class="urbanization-item-header">
                    <input class="urbanization-name-input" value="${escapeHtml(u.name)}" data-urb-id="${u.id}">
                    <button class="btn-remove" onclick="removeUrbanization(${u.id})" title="Remover">×</button>
                </div>
                <div class="urbanization-details" data-urb-id="${u.id}" title="Editar urbanização">
                    <span>${dt.label} · ${u.coverage}% cobertura</span>
                    <span><strong>${formatNumber(u.estimatedPop)}</strong> habitantes estimados</span>
                </div>
            </div>
        `;
    }).join('');

    // Wire rename inputs after rendering
    container.querySelectorAll('.urbanization-name-input').forEach(input => {
        input.addEventListener('change', () => {
            renameUrbanization(parseFloat(input.dataset.urbId), input.value);
        });
    });

    // Click on the details row opens the edit modal
    container.querySelectorAll('.urbanization-details').forEach(row => {
        row.addEventListener('click', () => {
            const urb = newUrbanizations.find(u => u.id === parseFloat(row.dataset.urbId));
            if (urb) showUrbanizationModal(urb);
        });
    });
}

function renameUrbanization(urbId, newName) {
    const urb = newUrbanizations.find(u => u.id === urbId);
    if (!urb) return;
    urb.name = newName || urb.name;
    // Update the map label (layers[1] is always the label marker)
    const labelMarker = urb.layers[1];
    if (labelMarker && labelMarker.setIcon) {
        const dt = DENSITY_TYPES[urb.densityType] || DENSITY_TYPES[2];
        labelMarker.setIcon(L.divIcon({
            className: '',
            html: `<div style="display:inline-block;background:rgba(39,103,73,0.85);color:white;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.3);">${escapeHtml(urb.name)}: ${formatNumber(urb.estimatedPop)} hab</div>`,
            iconSize: null,
            iconAnchor: [0, 0]
        }));
    }
}

// ============================================================
//              SCENARIO SUMMARY & RECALCULATE
// ============================================================
function updateScenarioSummary() {
    const deltaHEl = document.getElementById('scenario-delta-h');

    if (!censusGeoJSON) {
        document.getElementById('scenario-base-pop').textContent = '—';
        document.getElementById('scenario-proj-pop').textContent = '—';
        document.getElementById('scenario-delta').textContent = '—';
        if (deltaHEl) { deltaHEl.textContent = '—'; deltaHEl.style.color = '#718096'; }
        return;
    }

    // ── Population delta ──────────────────────────────────────────────────
    let basePop = 0;
    let projPop = 0;

    censusGeoJSON.features.forEach(f => {
        const props = f.properties;
        const bgriId = props.BGRI2021 || props.SUBSECCAO || props.OBJECTID;
        const pop = props.N_INDIVIDUOS || 0;
        basePop += pop;
        const override = densityOverrides[bgriId];
        projPop += override ? override.populationOverride : pop;
    });

    const urbPop = newUrbanizations.reduce((s, u) => s + u.estimatedPop, 0);
    projPop += urbPop;

    const delta = projPop - basePop;
    const sign = delta >= 0 ? '+' : '';

    document.getElementById('scenario-base-pop').textContent = formatNumber(basePop);
    document.getElementById('scenario-proj-pop').textContent = formatNumber(projPop);
    document.getElementById('scenario-delta').textContent = `${sign}${formatNumber(delta)}`;
    document.getElementById('scenario-delta').style.color = delta >= 0 ? '#38a169' : '#e53e3e';

    // ── Δ H (Shannon mix-of-uses index) ───────────────────────────────────
    // Jobs/ha estimated for activity-generating density types
    const DENSITY_JOBS = {
        1: { jobs_ha: 20, category: 'services' },  // industrial/serviços
        6: { jobs_ha: 15, category: 'commerce' },  // uso misto
    };

    // Step 1: aggregate current H baseline from jobsData
    const entries = Object.values(jobsData);
    const hasJobsData = entries.length > 0;

    let baseBreakdown   = { commerce: 0, services: 0, education_health: 0, culture_leisure: 0, industry: 0 };
    let baseTotalJobs   = 0;
    let baseResidentSum = 0;

    if (hasJobsData) {
        entries.forEach(e => {
            Object.keys(baseBreakdown).forEach(k => {
                baseBreakdown[k] += (e.jobs_breakdown || {})[k] || 0;
            });
        });
        baseTotalJobs = Object.values(baseBreakdown).reduce((s, v) => s + v, 0);
        baseResidentSum = stations.reduce((s, st) => s + (st.population_5min || 0), 0);
    }

    // Step 2: extra jobs introduced by density overrides (BGRI changes)
    let overrideJobs = { commerce: 0, services: 0, education_health: 0, culture_leisure: 0, industry: 0 };
    let overrideResidentDelta = 0;

    if (censusGeoJSON) {
        censusGeoJSON.features.forEach(f => {
            const props = f.properties;
            const bgriId = props.BGRI2021 || props.SUBSECCAO || props.OBJECTID;
            const override = densityOverrides[bgriId];
            if (!override) return;

            const area_ha = (props.SHAPE_Area || 0) / 10000;
            const coverage = (override.coverage || 40) / 100;
            const djSpec = DENSITY_JOBS[override.densityType];
            if (djSpec) {
                overrideJobs[djSpec.category] += djSpec.jobs_ha * area_ha * coverage;
            }
            // Resident delta vs original BGRI population
            const origPop = props.N_INDIVIDUOS || 0;
            overrideResidentDelta += (override.populationOverride - origPop);
        });
    }

    // Step 3: extra jobs from new urbanizations
    let urbJobs = { commerce: 0, services: 0, education_health: 0, culture_leisure: 0, industry: 0 };
    newUrbanizations.forEach(u => {
        const djSpec = DENSITY_JOBS[u.densityType];
        if (!djSpec) return;
        const area_ha = turf.area({ type: 'Feature', geometry: u.geometry, properties: {} }) / 10000;
        const coverage = (u.coverage || 40) / 100;
        urbJobs[djSpec.category] += djSpec.jobs_ha * area_ha * coverage;
    });

    // Step 4: compute base H and projected H
    if (!hasJobsData && Object.values(overrideJobs).every(v => v === 0) && Object.values(urbJobs).every(v => v === 0)) {
        // No data at all — tell user why
        if (deltaHEl) {
            deltaHEl.textContent = '— (adicione estações primeiro)';
            deltaHEl.style.color = '#718096';
        }
        return;
    }

    function shannonH(residents, breakdown) {
        const cats = {
            residents:        Math.max(0, residents),
            commerce:         Math.max(0, breakdown.commerce || 0),
            services:         Math.max(0, breakdown.services || 0),
            education_health: Math.max(0, breakdown.education_health || 0),
            culture_leisure:  Math.max(0, breakdown.culture_leisure || 0),
            industry:         Math.max(0, breakdown.industry || 0),
        };
        const total = Object.values(cats).reduce((s, v) => s + v, 0);
        if (total === 0) return 0;
        const nPos = Object.values(cats).filter(v => v > 0).length;
        if (nPos < 2) return 0;
        let h = 0;
        Object.values(cats).forEach(v => { if (v > 0) { const p = v / total; h -= p * Math.log(p); } });
        return h / Math.log(nPos);
    }

    const currentH = hasJobsData ? shannonH(baseResidentSum, baseBreakdown) : 0;

    const projBreakdown = {};
    Object.keys(baseBreakdown).forEach(k => {
        projBreakdown[k] = baseBreakdown[k] + (overrideJobs[k] || 0) + (urbJobs[k] || 0);
    });
    const projResidents = Math.max(0, baseResidentSum + overrideResidentDelta + urbPop);
    const projH = shannonH(projResidents, projBreakdown);

    const deltaH = projH - currentH;

    if (deltaHEl) {
        if (!hasJobsData) {
            // Overrides/urbanizations exist but no station jobs data yet
            const totalNewJobs = [...Object.values(overrideJobs), ...Object.values(urbJobs)].reduce((s, v) => s + v, 0);
            deltaHEl.textContent = totalNewJobs > 0
                ? `~+${Math.round(totalNewJobs)} empregos não-residenciais estimados (calcule com estações para H completo)`
                : '— (adicione estações para calcular H)';
            deltaHEl.style.color = '#718096';
        } else {
            const dSign = deltaH >= 0 ? '+' : '';
            deltaHEl.textContent = `${dSign}${deltaH.toFixed(3)}  (base: ${currentH.toFixed(2)} → proj: ${projH.toFixed(2)})`;
            deltaHEl.style.color = deltaH > 0.005 ? '#38a169' : deltaH < -0.005 ? '#e53e3e' : '#718096';
        }
    }
}

async function recalculateCatchment() {
    await calculatePopulation();
    updateScenarioSummary();
    renderUncoveredBgris();
    toast('Cobertura recalculada com as alterações do cenário.', 'success');
}

// ============================================================
//        UNCOVERED BGRIs — scenario tab list + map highlight
// ============================================================
function renderUncoveredBgris() {
    const container = document.getElementById('uncov-list');
    if (!container) return;
    const list = (globalPopStats && globalPopStats.uncovered_bgris) || [];

    if (list.length === 0) {
        const hasIsochrones = stations.some(s => s.isochrones && !s.isochroneError);
        container.innerHTML = `<p class="no-stations">${hasIsochrones ? 'Sem zonas não cobertas — boa cobertura de rede!' : 'Calcule as isócronas para ver as zonas.'}</p>`;
        return;
    }

    const totalPop = list.reduce((s, b) => s + b.population, 0);
    let html = `<p class="uncov-summary">${list.length} zona${list.length !== 1 ? 's' : ''} · <strong>${formatNumber(totalPop)}</strong> hab. não cobertos</p>`;

    html += list.map((b, i) => {
        const active = b.id === selectedUncoveredBgriId ? ' active' : '';
        const areaStr = b.area_ha != null ? `<span class="uncov-area">${b.area_ha.toFixed(1)} ha</span>` : '';
        return `<div class="uncov-list-item${active}" data-idx="${i}">
            <span class="uncov-rank">${i + 1}</span>
            <span class="uncov-id" title="${escapeHtml(b.id)}">${escapeHtml(b.id)}</span>
            ${areaStr}
            <span class="uncov-pop">${formatNumber(b.population)} hab.</span>
        </div>`;
    }).join('');

    container.innerHTML = html;

    container.querySelectorAll('.uncov-list-item').forEach((el, i) => {
        el.addEventListener('click', () => toggleUncoveredBgri(list[i], el));
    });
}

function clearUncoveredHighlight() {
    if (selectedUncoveredLayer) {
        try {
            if (selectedUncoveredLayer.feature) {
                selectedUncoveredLayer.setStyle(getCensusStyle(selectedUncoveredLayer.feature));
            }
        } catch {}
        selectedUncoveredLayer = null;
    }
    selectedUncoveredBgriId = null;
    document.querySelectorAll('.uncov-list-item').forEach(el => el.classList.remove('active'));
}

function toggleUncoveredBgri(bgri, itemEl) {
    // Clicking the already-active one → deselect
    if (selectedUncoveredBgriId === bgri.id) {
        clearUncoveredHighlight();
        return;
    }

    clearUncoveredHighlight();
    selectedUncoveredBgriId = bgri.id;
    if (itemEl) itemEl.classList.add('active');

    // Find and highlight the Leaflet layer on the census choropleth
    if (censusLayer) {
        censusLayer.eachLayer(layer => {
            const props = layer.feature && layer.feature.properties;
            if (!props) return;
            const fid = String(props.BGRI2021 || props.SUBSECCAO || props.OBJECTID || '');
            if (fid === bgri.id) {
                layer.setStyle({ color: '#c05621', weight: 3, dashArray: null, fillColor: '#dd6b20', fillOpacity: 0.45 });
                layer.bringToFront();
                selectedUncoveredLayer = layer;
            }
        });
    }

    // Pan/zoom to the zone centroid
    if (map && bgri.lat && bgri.lng) {
        map.flyTo([bgri.lat, bgri.lng], Math.max(map.getZoom(), 15), { duration: 0.7 });
    }
}

function resetScenario() {
    if (!confirm('Limpar todas as alterações de cenário?')) return;
    densityOverrides = {};
    newUrbanizations.forEach(u => u.layers.forEach(l => { try { map.removeLayer(l); } catch {} }));
    newUrbanizations = [];
    urbanizationLayers = [];
    drawnItems.clearLayers();
    if (censusLayer) {
        censusLayer.setStyle((feature) => getCensusStyle(feature));
    }
    renderUrbanizations();
    updateScenarioSummary();
    cancelEdit();
}

// ============================================================
//                  DENSITY HELPERS
// ============================================================
function populateDensitySelects() {
    const options = DENSITY_TYPES.map((dt, i) => `<option value="${i}">${dt.label} (${dt.residents_ha} hab/ha)</option>`).join('');
    const blankOption = '<option value="">— Selecionar —</option>';
    document.getElementById('edit-density-select').innerHTML = blankOption + options;
    document.getElementById('urb-density-type').innerHTML = options;
}

function renderDensityLegend() {
    document.getElementById('density-types-list').innerHTML = DENSITY_TYPES.map(dt => `
        <div class="density-type-row">
            <div class="density-type-swatch" style="background:${dt.color}"></div>
            <span class="density-type-label">${dt.label}</span>
            <span class="density-type-value">${dt.residents_ha} hab/ha</span>
        </div>
    `).join('');
}

// ============================================================
//                  PROJECT SAVE / LOAD
// ============================================================
function saveProject() {
    const project = {
        version: '2.1',
        saved_at: new Date().toISOString(),
        groups: groups.map(g => {
            const route = ensureRouteShape(g);
            return {
                id: g.id, name: g.name, color: g.color, visible: g.visible,
                route: {
                    trunk: route.trunk || null,
                    variants: (route.variants || []).map(v => ({
                        id: v.id, direction: v.direction, geometry: v.geometry
                    }))
                }
            };
        }),
        activeGroupId,
        stations: stations.map(s => ({
            id: s.id, lat: s.lat, lng: s.lng, groupId: s.groupId,
            name: s.name || null,
            population_5min: s.population_5min || 0,
            population_10min: s.population_10min || 0,
            population_total: s.population_total || 0
        })),
        densityOverrides,
        newUrbanizations: newUrbanizations.map(u => ({
            id: u.id, name: u.name, geometry: u.geometry, densityType: u.densityType,
            coverage: u.coverage, diffuse: u.diffuse, estimatedPop: u.estimatedPop
        }))
    };

    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `territorio_evora_projeto_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a); a.click();
    URL.revokeObjectURL(url); document.body.removeChild(a);
}

async function loadProject(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const project = JSON.parse(text);

        if (!project.version || !project.groups) {
            toast('Ficheiro de projeto inválido.', 'error');
            return;
        }

        // Clear current state
        stations.forEach(s => removeStationIsochrones(s.id));
        stationMarkers.forEach(m => { try { map.removeLayer(m); } catch {} });
        newUrbanizations.forEach(u => u.layers.forEach(l => { try { map.removeLayer(l); } catch {} }));
        groups.forEach(g => removeGroupRouteLayers(g.id));
        if (isDrawingRoute) cancelRouteDrawing();
        if (editingRoute) finishRouteEdit(false);
        if (censusLayer) { map.removeLayer(censusLayer); censusLayer = null; }
        drawnItems.clearLayers();

        // Restore groups (incluindo migração de projetos v2.0 sem rotas)
        groups = project.groups.map(g => ({
            ...g,
            route: g.route
                ? {
                    trunk: g.route.trunk || null,
                    variants: Array.isArray(g.route.variants)
                        ? g.route.variants.map(v => ({
                            id: v.id != null ? v.id : (Date.now() + Math.random()),
                            direction: v.direction === 'inbound' ? 'inbound' : 'outbound',
                            geometry: v.geometry || null
                        })).filter(v => v.geometry)
                        : []
                }
                : { trunk: null, variants: [] }
        }));
        activeGroupId = project.activeGroupId || (groups[0] && groups[0].id);

        // Restore stations (will trigger isochrone fetch)
        stations = project.stations.map(s => ({
            id: s.id, lat: s.lat, lng: s.lng, groupId: s.groupId,
            name: s.name || null,
            population_5min: s.population_5min || 0,
            population_10min: s.population_10min || 0,
            population_total: s.population_total || 0
        }));

        // Restore scenario
        densityOverrides = project.densityOverrides || {};
        // Refresh census layer styles to reflect restored overrides
        if (censusLayer) {
            censusLayer.setStyle(feature => getCensusStyle(feature));
        }
        newUrbanizations = [];
        urbanizationLayers = [];

        // Re-create urbanization visuals
        if (project.newUrbanizations && project.newUrbanizations.length > 0) {
            project.newUrbanizations.forEach(u => {
                const dt = DENSITY_TYPES[u.densityType] || DENSITY_TYPES[2];
                const layers = [];
                const coreLayer = L.geoJSON({ type: 'Feature', geometry: u.geometry, properties: {} }, {
                    style: { color: '#276749', weight: 2, fillColor: dt.color, fillOpacity: 0.45, dashArray: '5,5' }
                }).addTo(map);
                layers.push(coreLayer);
                urbanizationLayers.push(coreLayer);

                const center = turf.centroid({ type: 'Feature', geometry: u.geometry, properties: {} });
                const labelMarker = L.marker([center.geometry.coordinates[1], center.geometry.coordinates[0]], {
                    icon: L.divIcon({
                        className: '',
                        html: `<div style="display:inline-block;background:rgba(39,103,73,0.85);color:white;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.3);">${escapeHtml(u.name)}: ${formatNumber(u.estimatedPop)} hab</div>`,
                        iconSize: null,
                        iconAnchor: [0, 0]
                    })
                }).addTo(map);
                layers.push(labelMarker);
                urbanizationLayers.push(labelMarker);

                newUrbanizations.push({ ...u, layers });
            });
        }

        // Update UI
        stationMarkers = [];
        stationIsochroneLayers = {};
        isochroneLayers = [];
        if (stations.length > 0) {
            showStationsLoading(`A recarregar isócronas para ${stations.length} estação(ões)…`);
        } else {
            hideStationsLoading();
        }
        renderGroups();
        updateMap();
        updateSidebar();
        renderUrbanizations();
        updateScenarioSummary();
        saveState();
        // No stations to enqueue → refresh global totals directly so the coverage card reflects density/urbanisation changes
        if (stations.length === 0) {
            await calculatePopulation(false);
        }

        const urbs = project.newUrbanizations ? project.newUrbanizations.length : 0;
        const overrides = Object.keys(project.densityOverrides || {}).length;
        toast(`Projeto carregado: ${groups.length} grupo(s), ${stations.length} estação(ões), ${overrides} alteração(s), ${urbs} urbanização(es).`, 'success', 5000);
    } catch (e) {
        console.error('Erro ao carregar projeto:', e);
        toast('Erro ao carregar projeto: ' + e.message, 'error', 6000);
    }

    event.target.value = '';
}

// ============================================================
//                       UTILITIES
// ============================================================
function formatNumber(num) {
    return new Intl.NumberFormat('pt-PT').format(Math.round(num || 0));
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

/**
 * Linha de estatística com label à esquerda e valor à direita.
 * Reutilizada nos cartões de estação e no bloco de empregos.
 *
 * @param {string} label
 * @param {string|number} value
 * @param {object} [opts]
 * @param {boolean} [opts.total]      Aplica modificador `is-total` (separador + bold).
 * @param {boolean} [opts.sub]        Aplica modificador `is-sub` (label indentado).
 * @param {string}  [opts.valueClass] Classe CSS extra a aplicar ao valor (ex.: tier-good).
 * @param {boolean} [opts.raw]        Se true, `value` é injetado como HTML (sem escape).
 */
function statRow(label, value, opts = {}) {
    const rowCls = ['station-stat-row'];
    if (opts.total) rowCls.push('is-total');
    if (opts.sub)   rowCls.push('is-sub');
    const valCls = ['station-stat-value'];
    if (opts.valueClass) valCls.push(opts.valueClass);
    const safeValue = opts.raw ? value : escapeHtml(String(value));
    return `<div class="${rowCls.join(' ')}"><span class="station-stat-label">${escapeHtml(label)}</span><span class="${valCls.join(' ')}">${safeValue}</span></div>`;
}

/**
 * Devolve a classe CSS do tier consoante limites (good ≥ ok, warn ≥ warnAt, bad senão).
 * Usado para colorir Shannon H, auto-suficiência, etc.
 */
function tierClass(value, okAt, warnAt) {
    const v = value || 0;
    if (v >= okAt)   return 'tier-good';
    if (v >= warnAt) return 'tier-warn';
    return 'tier-bad';
}

// ==================== Toast notifications ====================
// Uso: toast('Mensagem'), toast('Erro', 'error'), toast('OK', 'success', 5000)
function toast(message, type = 'info', durationMs = 3500) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    el.addEventListener('click', () => el.remove());
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('toast-visible'));
    setTimeout(() => {
        el.classList.remove('toast-visible');
        setTimeout(() => { try { el.remove(); } catch {} }, 250);
    }, durationMs);
}

// ============================================================
//               OFF-SCREEN MAP CAPTURE HELPER
// ============================================================
/**
 * Renders a Leaflet map in a hidden off-screen container and captures it with
 * html2canvas. Does NOT touch the live map at all.
 *
 * @param {Object}   opts
 * @param {L.LatLngBounds} opts.bounds            - Bounds to fitBounds to
 * @param {number}   opts.width                   - Container width in px
 * @param {number}   opts.height                  - Container height in px
 * @param {Array}    [opts.stationMarkers=[]]      - [{lat,lng,color}]
 * @param {Array}    [opts.isochroneFeatures=[]]   - [{feature:GeoJSON, color}]
 * @param {Array}    [opts.routeLines=[]]          - [{feature:GeoJSON LineString, color, kind:'trunk'|'variant'}]
 * @param {Array}    [opts.labelledDots=[]]        - [{lat,lng,label}] numbered dots
 * @returns {Promise<string|null>}  dataURL PNG or null on failure
 */
async function captureMapToImage({ bounds, width, height, stationMarkers = [], isochroneFeatures = [], routeLines = [], labelledDots = [] }) {
    const container = document.createElement('div');
    container.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${width}px;height:${height}px;z-index:-1;overflow:hidden;`;
    document.body.appendChild(container);

    let offMap = null;
    try {
        offMap = L.map(container, {
            zoomControl: false,
            attributionControl: false,
            preferCanvas: true,
            fadeAnimation: false,
            zoomAnimation: false,
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            crossOrigin: 'anonymous',
        }).addTo(offMap);

        if (bounds && bounds.isValid()) {
            offMap.fitBounds(bounds, { padding: [48, 48], animate: false });
        }

        // Isochrone outlines (10 min, coloured by group)
        isochroneFeatures.forEach(({ feature, color }) => {
            try {
                L.geoJSON(feature, {
                    style: {
                        color: color || '#667eea',
                        weight: 2,
                        opacity: 0.75,
                        fillColor: color || '#667eea',
                        fillOpacity: 0.13,
                    },
                }).addTo(offMap);
            } catch (_) {}
        });

        // Routes (trunk + variants), drawn above isochrones and below station dots.
        // Para cada rota: primeiro um casing branco translúcido (halo) e depois a
        // linha colorida — espelha o que se vê no mapa principal e mantém as rotas
        // legíveis sobre as isócronas.
        routeLines.forEach(({ feature, color, kind }) => {
            if (!feature) return;
            try {
                const isVariant = kind === 'variant';
                const baseWeight = isVariant ? 3 : 4;
                L.geoJSON(feature, {
                    style: {
                        color: '#ffffff',
                        weight: baseWeight + 4,
                        opacity: 0.55,
                        lineCap: 'round',
                        lineJoin: 'round',
                    },
                }).addTo(offMap);
                L.geoJSON(feature, {
                    style: {
                        color: color || '#667eea',
                        weight: baseWeight,
                        opacity: 0.95,
                        dashArray: isVariant ? '6,5' : null,
                        lineCap: 'round',
                        lineJoin: 'round',
                    },
                }).addTo(offMap);
                // Setas direcionais nas variantes (igual ao mapa principal)
                if (isVariant && feature.geometry) {
                    computeArrowAnchors(feature.geometry).forEach(anchor => {
                        buildArrowMarker(anchor, color || '#667eea').addTo(offMap);
                    });
                }
            } catch (_) {}
        });

        // Station circle markers (coloured by group)
        stationMarkers.forEach(({ lat, lng, color }) => {
            L.circleMarker([lat, lng], {
                radius: 7,
                color: '#fff',
                weight: 2.5,
                fillColor: color || '#667eea',
                fillOpacity: 1,
            }).addTo(offMap);
        });

        // Numbered dot markers for uncovered BGRIs
        labelledDots.forEach(({ lat, lng, label }) => {
            const icon = L.divIcon({
                className: '',
                iconSize: [22, 22],
                iconAnchor: [11, 11],
                html: `<div style="width:22px;height:22px;border-radius:50%;background:#e53e3e;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;font-family:system-ui,sans-serif;">${label}</div>`,
            });
            L.marker([lat, lng], { icon }).addTo(offMap);
        });

        // Wait for tiles: resolve on map 'load' event OR after a hard cap
        await new Promise(resolve => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            offMap.once('load', () => setTimeout(finish, 200));
            setTimeout(finish, 2500);    // hard cap
            setTimeout(() => { if (!done) finish(); }, 900); // fallback min
        });

        const canvas = await html2canvas(container, {
            useCORS: true,
            scale: 1.5,
            logging: false,
            width,
            height,
        });
        return canvas.toDataURL('image/png');
    } catch (e) {
        console.warn('captureMapToImage falhou:', e);
        return null;
    } finally {
        try { if (offMap) offMap.remove(); } catch (_) {}
        try { container.remove(); } catch (_) {}
    }
}

// ============================================================
//                       INIT
// ============================================================
//                     EXPORT REPORT (PDF via browser print)
// ============================================================
async function exportReport() {
    if (stations.length === 0) {
        toast('Não existem estações para incluir no relatório.', 'warning');
        return;
    }

    const btn = document.getElementById('btn-export-report');
    const originalText = btn.innerHTML;
    btn.innerHTML = '⏳ A gerar...';
    btn.disabled = true;

    // ── 1. Capturar mapas em off-screen (sem perturbar o mapa activo) ─────
    // Visão geral: marcas das estações + contorno das isócronas de 10 min + rotas dos grupos
    const overviewBounds = L.latLngBounds(stations.map(s => [s.lat, s.lng]));
    const overviewMarkers = stations.map(s => ({
        lat: s.lat, lng: s.lng,
        color: (getGroupForStation(s) || {}).color || '#667eea',
    }));
    const overviewIsochrones = stations.flatMap(s => {
        const iso10 = s.isochrones && s.isochrones[1];
        if (!iso10) return [];
        return [{ feature: iso10, color: (getGroupForStation(s) || {}).color || '#667eea' }];
    });
    // Rotas: tronco + variantes para cada grupo visível com geometria.
    // Estende os bounds para incluir as rotas (caso passem por fora das paragens).
    const overviewRoutes = [];
    groups.forEach(g => {
        if (g.visible === false) return;
        const r = g.route;
        if (!r) return;
        const extendBounds = (geom) => {
            if (!geom || !geom.coordinates) return;
            geom.coordinates.forEach(([lng, lat]) => overviewBounds.extend([lat, lng]));
        };
        if (r.trunk) {
            overviewRoutes.push({
                feature: { type: 'Feature', geometry: r.trunk, properties: {} },
                color: g.color, kind: 'trunk',
            });
            extendBounds(r.trunk);
        }
        (r.variants || []).forEach(v => {
            if (!v.geometry) return;
            overviewRoutes.push({
                feature: { type: 'Feature', geometry: v.geometry, properties: {} },
                color: g.color, kind: 'variant',
            });
            extendBounds(v.geometry);
        });
    });
    const mapImgSrc = await captureMapToImage({
        bounds: overviewBounds, width: 1120, height: 630,
        stationMarkers: overviewMarkers, isochroneFeatures: overviewIsochrones,
        routeLines: overviewRoutes,
    });

    // Mapa de zonas sem cobertura (capturado aqui para manter a construção HTML síncrona)
    const uncoveredList = globalPopStats.uncovered_bgris || [];
    let uncovImgSrc = null;
    if (uncoveredList.length > 0) {
        const uncovBounds = L.latLngBounds(uncoveredList.map(b => [b.lat, b.lng]));
        const uncovDots = uncoveredList.map((b, i) => ({ lat: b.lat, lng: b.lng, label: i + 1 }));
        uncovImgSrc = await captureMapToImage({
            bounds: uncovBounds, width: 900, height: 506,
            labelledDots: uncovDots,
        });
    }

    btn.innerHTML = originalText;
    btn.disabled = false;

    // ── 2. Calcular totais globais ────────────────────────────
    // Pop: use union-based server totals (no cross-station double-counting)
    const totalPop5  = globalPopStats.total_population_5min  || stations.reduce((s, st) => s + (st.population_5min  || 0), 0);
    const totalPop10 = globalPopStats.total_population_10min || stations.reduce((s, st) => s + (st.population_10min || 0), 0);
    // Jobs: de-duplicate POIs by osm_id
    const _seenJ = new Map();
    Object.values(jobsData).forEach(e => {
        (e.pois || []).forEach(p => { if (p.osm_id && !_seenJ.has(p.osm_id)) _seenJ.set(p.osm_id, p.jobs || 0); });
    });
    const totalJobsAll = _seenJ.size > 0
        ? Array.from(_seenJ.values()).reduce((s, v) => s + v, 0)
        : Object.values(jobsData).reduce((s, j) => s + (j.jobs_total || 0), 0);
    const hValues = Object.values(jobsData).map(j => j.shannon_h).filter(h => h != null);
    const avgH = hValues.length > 0 ? (hValues.reduce((a, b) => a + b, 0) / hValues.length) : null;

    const scenarioActive = Object.keys(densityOverrides).length > 0 || newUrbanizations.length > 0;

    // ── 3. Helpers ────────────────────────────────────────────
    const fmt = n => (n == null ? '—' : Math.round(n).toLocaleString('pt-PT'));
    const fmtF = n => (n == null ? '—' : n.toFixed(2));
    const todColor = cls => ({
        'Centralidade multifuncional': '#276749', 'Misto equilibrado': '#0e7490',
        'Nó de emprego': '#3730a3', 'Misto desequilibrado': '#92400e',
        'Dormitório': '#9b1c1c'
    }[cls] || '#4a5568');
    const todBg = cls => ({
        'Centralidade multifuncional': '#f0fff4', 'Misto equilibrado': '#ecfeff',
        'Nó de emprego': '#eef2ff', 'Misto desequilibrado': '#fffbeb',
        'Dormitório': '#fff5f5'
    }[cls] || '#f8fafc');

    const now = new Date();
    const dateStr = now.toLocaleDateString('pt-PT', { day: '2-digit', month: 'long', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

    // ── 4. Construir HTML ─────────────────────────────────────
    let html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<title>Análise de Cobertura Pedonal das Paragens — Évora</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #2d3748; background: #fff; padding: 32px; }
  h1 { font-size: 22px; color: #2d3748; margin-bottom: 4px; }
  h2 { font-size: 15px; color: #4a5568; font-weight: 600; margin: 28px 0 10px; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; }
  h3 { font-size: 13px; font-weight: 700; margin: 20px 0 8px; }
  .subtitle { font-size: 12px; color: #718096; margin-bottom: 6px; }
  .meta { font-size: 11px; color: #a0aec0; margin-top: 2px; }
  .map-img { width: 100%; aspect-ratio: 16/9; object-fit: contain; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 4px; background: #f8fafc; }
  .map-placeholder { background: #f8fafc; border: 1px dashed #cbd5e0; border-radius: 8px; height: 180px; display: flex; align-items: center; justify-content: center; color: #a0aec0; font-size: 12px; margin-bottom: 4px; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 8px; }
  .kpi { background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; padding: 12px 14px; }
  .kpi-label { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #718096; margin-bottom: 4px; }
  .kpi-value { font-size: 20px; font-weight: 700; color: #2d3748; }
  .kpi-sub { font-size: 10px; color: #a0aec0; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { background: #f8fafc; text-align: left; padding: 6px 8px; font-weight: 600; color: #4a5568; border-bottom: 2px solid #e2e8f0; white-space: nowrap; }
  td { padding: 6px 8px; border-bottom: 1px solid #f0f4f8; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #fafbff; }
  .group-header { display: flex; align-items: center; gap: 8px; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 3px solid; }
  .group-dot { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; }
  .group-title { font-size: 15px; font-weight: 700; color: #2d3748; }
  .group-count { font-size: 11px; color: #718096; }
  .badge-tod { display: inline-block; padding: 2px 7px; border-radius: 9999px; font-size: 10px; font-weight: 600; }
  .tag-overlap { display: inline-block; background: #fffbeb; color: #92400e; border-left: 3px solid #ed8936; padding: 2px 6px; font-size: 10px; border-radius: 2px; white-space: nowrap; }
  .tag-overlap.danger { background: #fff5f5; color: #9b1c1c; border-color: #e53e3e; }
  .scenario-box { background: #fffbeb; border: 1px solid #f6ad55; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; }
  .scenario-title { font-size: 12px; font-weight: 700; color: #92400e; margin-bottom: 8px; }
  .tz-table { margin-top: 8px; }
  .coords { font-family: monospace; font-size: 10px; color: #718096; }
  .no-data { color: #a0aec0; font-style: italic; }
  @media print {
    body { padding: 16px; }
    .map-img { max-height: none; width: 100%; }
    .group-header { page-break-after: avoid; break-after: avoid; }
    h2 { page-break-after: avoid; break-after: avoid; }
    .kpi { break-inside: avoid; }
  }
  @page { margin: 18mm 18mm 20mm; }
</style>
</head>
<body>

<!-- ===== CABEÇALHO ===== -->
<h1>Análise de Cobertura Pedonal das Paragens</h1>
<p class="subtitle">Mobilidade e Território — Évora</p>
<p class="meta">Gerado em ${dateStr} às ${timeStr} &nbsp;·&nbsp; ${groups.length} grupo${groups.length !== 1 ? 's' : ''} &nbsp;·&nbsp; ${stations.length} ${stations.length !== 1 ? 'estações' : 'estação'}</p>

<!-- ===== MAPA ===== -->
<h2>Mapa</h2>
${mapImgSrc
    ? `<img class="map-img" src="${mapImgSrc}" alt="Mapa das estações">`
    : `<div class="map-placeholder">Imagem do mapa não disponível</div>`
}

<!-- ===== RESUMO GLOBAL ===== -->
<h2>Resumo Global</h2>
<div class="summary-grid">
  <div class="kpi">
    <div class="kpi-label">Pop. 5 min (total)</div>
    <div class="kpi-value">${fmt(totalPop5)}</div>
    <div class="kpi-sub">sem dupla contagem</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Pop. 10 min (total)</div>
    <div class="kpi-value">${fmt(totalPop10)}</div>
    <div class="kpi-sub">sem dupla contagem</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Empregos estimados</div>
    <div class="kpi-value">${hValues.length > 0 ? fmt(totalJobsAll) : '—'}</div>
    <div class="kpi-sub">área de 5 min (OSM)</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">H médio (mix de usos)</div>
    <div class="kpi-value">${avgH != null ? fmtF(avgH) : '—'}</div>
    <div class="kpi-sub">índice Shannon norm.</div>
  </div>
</div>`;

    // Coverage KPIs row — pop usa SEMPRE 5 min (uniforme com o cartão da sidebar)
    const coveredPop5 = globalPopStats.total_population_5min || 0;
    const popCovPct  = cityTotalPop > 0 && coveredPop5 > 0 ? (coveredPop5 / cityTotalPop * 100).toFixed(1) : null;
    const jobsCovPct = CITY_TOTAL_JOBS > 0 && hValues.length > 0 && totalJobsAll > 0 ? (totalJobsAll / CITY_TOTAL_JOBS * 100).toFixed(1) : null;
    html += `
<div class="summary-grid" style="grid-template-columns:repeat(2,1fr); margin-top:-4px;">
  <div class="kpi" style="border-color:#c6f6d5; background:linear-gradient(135deg,rgba(56,161,105,.06),rgba(49,130,206,.06));">
    <div class="kpi-label">Cobertura pop. (5 min)</div>
    <div class="kpi-value">${popCovPct != null ? popCovPct + '%' : '—'}</div>
    <div class="kpi-sub">${fmt(coveredPop5)} hab. de ${fmt(cityTotalPop)} totais</div>
  </div>
  <div class="kpi" style="border-color:#bee3f8; background:linear-gradient(135deg,rgba(49,130,206,.06),rgba(159,122,234,.06));">
    <div class="kpi-label">Cobertura empregos (5 min)</div>
    <div class="kpi-value">${jobsCovPct != null ? jobsCovPct + '%' : '—'}</div>
    <div class="kpi-sub">${hValues.length > 0 ? fmt(totalJobsAll) : '—'} emp. de ${fmt(CITY_TOTAL_JOBS)} totais (CME)</div>
  </div>
</div>`;

    // ── Scenario section ─────────────────────────────────────
    if (scenarioActive) {
        const nOverrides = Object.keys(densityOverrides).length;
        html += `
<h2>Cenário Urbano</h2>
<div class="scenario-box">
  <div class="scenario-title">Alterações ao cenário base activas</div>`;

        if (nOverrides > 0) {
            html += `<p style="font-size:11px; color:#92400e; margin-bottom:8px;">${nOverrides} subsecção${nOverrides !== 1 ? 'ões' : ''} com densidade ajustada manualmente.</p>`;
        }

        if (newUrbanizations.length > 0) {
            html += `<table class="tz-table">
<thead><tr><th>Nome</th><th>Densidade</th><th>Cobertura (%)</th><th>Pop. estimada</th></tr></thead>
<tbody>`;
            newUrbanizations.forEach(u => {
                const dt = DENSITY_TYPES[u.densityType] || DENSITY_TYPES[2];
                html += `<tr>
  <td>${u.name || 'Sem nome'}</td>
  <td>${dt.label}</td>
  <td>${u.coverage || 0}</td>
  <td>${fmt(u.estimatedPop)}</td>
</tr>`;
            });
            html += `</tbody></table>`;
        }

        html += `</div>`;
    }

    // ── Per-group sections ────────────────────────────────────
    html += `<h2>Análise por Grupo</h2>`;

    groups.forEach(group => {
        const groupStations = stations.filter(s => s.groupId === group.id);
        if (groupStations.length === 0) return; // ocultar grupos vazios
        const grpPop5  = groupStations.reduce((s, st) => s + (st.population_5min  || 0), 0);
        const grpPop10 = groupStations.reduce((s, st) => s + (st.population_10min || 0), 0);

        html += `
<div class="group-header" style="border-color:${group.color};">
  <div class="group-dot" style="background:${group.color};"></div>
  <span class="group-title">${group.name}</span>
  <span class="group-count">${groupStations.length} ${groupStations.length !== 1 ? 'estações' : 'estação'} &nbsp;·&nbsp; ${fmt(grpPop5)} hab. (5 min) &nbsp;·&nbsp; ${fmt(grpPop10)} hab. (10 min)</span>
</div>
<table>
<thead>
  <tr>
    <th>#</th>
    <th>Nome</th>
    <th>Coordenadas</th>
    <th>Pop. 5 min</th>
    <th>Pop. 10 min</th>
    <th>Empregos</th>
    <th>H (Shannon)</th>
    <th>Perfil funcional</th>
    <th>Autossuficiência</th>
    <th>Sobreposições</th>
  </tr>
</thead>
<tbody>`;

        groupStations.forEach((station, idx) => {
            const jd  = jobsData[station.id] || {};
            const ovl = overlapData[station.id] || [];
            const todCls = jd.tod_classification || null;

            const overlapCells = ovl.map(o => {
                const pct = Math.round((o.areaFraction || 0) * 100);
                const cls = pct >= 40 ? 'danger' : '';
                return `<span class="tag-overlap ${cls}">${o.withName || 'Estação'} ${pct}%</span>`;
            }).join(' ');

            html += `<tr>
  <td>${idx + 1}</td>
  <td style="font-weight:600;">${station.name || ('Estação ' + (stations.indexOf(station) + 1))}</td>
  <td class="coords">${Number(station.lat).toFixed(5)}, ${Number(station.lng).toFixed(5)}</td>
  <td>${fmt(station.population_5min)}</td>
  <td>${fmt(station.population_10min)}</td>
  <td>${jd.jobs_total != null ? fmt(jd.jobs_total) : '<span class="no-data">—</span>'}</td>
  <td>${jd.shannon_h != null ? fmtF(jd.shannon_h) : '<span class="no-data">—</span>'}</td>
  <td>${todCls ? `<span class="badge-tod" style="background:${todBg(todCls)};color:${todColor(todCls)};">${todCls}</span>` : '<span class="no-data">—</span>'}</td>
  <td>${jd.self_sufficiency != null ? fmtF(jd.self_sufficiency) : '<span class="no-data">—</span>'}</td>
  <td>${overlapCells || '<span class="no-data">nenhuma</span>'}</td>
</tr>`;
        });

        html += `</tbody></table>`;
    });

    // ── Underserved BGRIs section ─────────────────────────────
    if (uncoveredList.length > 0) {
        const totalUncovPop = uncoveredList.reduce((s, b) => s + b.population, 0);
        html += `
<h2>Zonas com menor cobertura de paragens</h2>
<p style="font-size:11px;color:#718096;margin-bottom:10px;">
  Subsecções estatísticas (BGRI) com população ≥ 50 habitantes não abrangidas por qualquer isócrona de 10 minutos.
  Ordenadas por população residente (descendente).
  Total não coberto: <strong>${fmt(totalUncovPop)} habitantes</strong>.
</p>`;
        if (uncovImgSrc) {
            html += `<img class="map-img" src="${uncovImgSrc}" alt="Mapa de zonas sem cobertura de paragens" style="margin-bottom:14px;">`;
        }
        html += `
<table>
<thead>
  <tr>
    <th>#</th>
    <th>BGRI</th>
    <th>Pop. residente</th>
    <th>Área (ha)</th>
  </tr>
</thead>
<tbody>`;
        uncoveredList.forEach((b, i) => {
            const areaStr = b.area_ha != null ? b.area_ha.toFixed(1) : '—';
            html += `<tr>
  <td>${i + 1}</td>
  <td class="coords">${b.id || '—'}</td>
  <td style="font-weight:600;">${fmt(b.population)}</td>
  <td>${areaStr}</td>
</tr>`;
        });
        html += `</tbody></table>`;
    }

    html += `
</body>
</html>`;

    // ── 5. Abrir em novo tab e imprimir ───────────────────────
    // O script de impressão está embutido no HTML gerado: dispara após window.onload
    const blobHtml = html.replace(
        '</body>',
        '<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script></body>'
    );
    const blob = new Blob([blobHtml], { type: 'text/html;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const tab  = window.open(url, '_blank');
    if (!tab) {
        // Popups bloqueados — fallback: descarregar o HTML para o utilizador abrir manualmente
        try {
            const a = document.createElement('a');
            a.href = url;
            a.download = `relatorio_evora_${new Date().toISOString().split('T')[0]}.html`;
            document.body.appendChild(a); a.click(); a.remove();
            toast('Popups bloqueados. Relatório descarregado como HTML.', 'warning', 6000);
        } catch (_) {
            toast('O browser bloqueou a abertura do relatório.', 'error', 6000);
        }
    }
    // Revogar o URL após tempo suficiente para o tab/download carregar
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ============================================================
document.addEventListener('DOMContentLoaded', function() {
    try { initMap(); console.log('App v2.0 inicializada'); } catch (e) { console.error('Erro init:', e); }
});

// Global exports
window.removeStation = removeStation;
window.removeUrbanization = removeUrbanization;
window.togglePOILayer = togglePOILayer;
window.exportReport = exportReport;

