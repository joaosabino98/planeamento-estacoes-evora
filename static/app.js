// ============================================================
// Mobilidade e Território — Desenvolvimento Orientado ao Transporte (TOD) — Évora
// ============================================================

// Coordenadas de Évora (centro da cidade)
const EVORA_CENTER = [38.5667, -7.9075];
const EVORA_ZOOM = 13;

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
let isUpdating = false;

// -- Active tab --
let activeTab = 'stations'; // 'stations' | 'scenario'

// -- Scenario mode --
let censusGeoJSON = null;        // raw GeoJSON data
let censusLayer = null;          // Leaflet GeoJSON layer
let densityOverrides = {};       // { bgriId: { densityType: <int>, populationOverride: <number> } }
let newUrbanizations = [];       // [{ id, name, geometry, densityType, coverage, diffuse, estimatedPop, layers[] }]
let urbanizationLayers = [];     // all Leaflet layers for urbanizations
let selectedCensusFeature = null;
let drawControl = null;
let drawnItems = null;
let isDrawingUrbanization = false;
let pendingUrbanizationGeometry = null;

// -- Jobs / Mix de Usos --
let jobsData = {};            // { stationId: { jobs_total, jobs_breakdown, shannon_h, tod_classification, self_sufficiency, poi_count, low_coverage_warning, pois[] } }
let jobsPOILayer = null;      // Leaflet layer group for POI circle markers
let jobsPOIVisible = false;
let overlapData = {};         // { stationId: [{ withId, withName, areaFraction, sharedPop }] }

// -- Isochrone request queue (serialises ORS calls to avoid rate-limit) --
let isochroneQueue = [];
let isochroneQueueRunning = false;

// -- Undo/Redo --
let historyStack = [];
let historyIndex = -1;
const MAX_HISTORY = 50;
let isSavingState = false;

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

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    // Leaflet.draw setup (for urbanization polygons)
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // Map click — add station (only in stations tab, not drawing)
    map.on('click', function(e) {
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
    document.getElementById('btn-add-group').addEventListener('click', () => {
        const name = `Grupo ${groups.length + 1}`;
        createGroup(name);
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

    // ESC closes the edit panel
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') cancelEdit();
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

    // Keyboard shortcuts
    document.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }
    });

    // Populate density selects
    populateDensitySelects();
    renderDensityLegend();
    renderGroups();
    saveState();
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
    const group = { id, name, color, visible: true };
    groups.push(group);
    activeGroupId = id;
    renderGroups();
    return group;
}

function deleteGroup(groupId) {
    // Move stations of this group to the first remaining group, or delete them
    const remaining = groups.filter(g => g.id !== groupId);
    if (remaining.length === 0) {
        alert('Deve existir pelo menos um grupo.');
        return;
    }
    const targetGroup = remaining[0];
    stations.forEach(s => {
        if (s.groupId === groupId) s.groupId = targetGroup.id;
    });
    groups = remaining;
    if (activeGroupId === groupId) activeGroupId = targetGroup.id;
    renderGroups();
    updateMap();
    updateSidebar();
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
}

function getGroupForStation(station) {
    return groups.find(g => g.id === station.groupId) || groups[0];
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
        return `
            <div class="group-row ${isActive ? 'active' : ''}" data-group-id="${g.id}">
                <div class="group-color-swatch" style="background:${g.color}" data-action="color" title="Mudar cor"></div>
                <input class="group-name-input" value="${escapeHtml(g.name)}" data-action="rename" />
                <span class="group-badge">${count}</span>
                <button class="group-btn btn-visibility" data-action="visibility" title="${g.visible ? 'Ocultar' : 'Mostrar'}">${g.visible ? '👁️' : '👁️‍🗨️'}</button>
                <button class="group-btn btn-delete-group" data-action="delete" title="Apagar grupo">×</button>
            </div>
        `;
    }).join('');

    // Event delegation
    container.querySelectorAll('.group-row').forEach(row => {
        const gid = parseFloat(row.dataset.groupId);

        row.addEventListener('click', (e) => {
            const action = e.target.dataset.action || e.target.closest('[data-action]')?.dataset.action;
            if (!action) { setActiveGroup(gid); return; }
            if (action === 'color') { showColorPicker(e.target, gid); }
            else if (action === 'visibility') { toggleGroupVisibility(gid); }
            else if (action === 'delete') { deleteGroup(gid); }
            else if (action === 'rename') { /* handled by input change */ }
            else { setActiveGroup(gid); }
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
    updateMap(); updateSidebar(); calculatePopulation();
    isSavingState = false;
}

// ============================================================
//                      STATIONS
// ============================================================
function addStation(lat, lng) {
    saveState();
    const gid = activeGroupId || (groups[0] && groups[0].id);
    if (!gid) { createGroup('Grupo 1'); }
    const station = { id: Date.now(), lat, lng, groupId: activeGroupId || groups[0].id };
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

async function runIsochroneQueue() {
    if (isochroneQueueRunning) return;
    isochroneQueueRunning = true;
    while (isochroneQueue.length > 0) {
        const station = isochroneQueue.shift();
        // Skip if station was removed or already has a valid cache since it was enqueued
        if (!stations.find(s => s.id === station.id)) continue;
        if (hasValidCache(station)) continue;
        await createIsochrones(station);
        updateSidebar(); // progressive feedback
        if (isochroneQueue.length > 0) await new Promise(r => setTimeout(r, 350));
    }
    isochroneQueueRunning = false;
    calculatePopulation();
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
//                  POPULATION CALCULATION
// ============================================================
async function calculatePopulation() {
    if (stations.length === 0) {
        updateSidebarStats({ total_population: 0, total_population_5min: 0, total_population_10min: 0, points: [] });
        updateSidebar();
        return;
    }

    try {
        const payload = {
            points: stations.map(s => ({
                id: s.id, lat: s.lat, lng: s.lng,
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

        const response = await fetch('/api/population-in-isochrones', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error('Erro ao calcular população');
        const data = await response.json();

        stations = stations.map(station => {
            const pd = data.points.find(p => String(p.id) === String(station.id));
            if (pd) {
                return { ...station, population_5min: Number(pd.population_5min) || 0, population_10min: Number(pd.population_10min) || 0, population_total: Number(pd.population_total) || 0 };
            }
            return { ...station, population_5min: Number(station.population_5min) || 0, population_10min: Number(station.population_10min) || 0, population_total: Number(station.population_total) || 0 };
        });

        updateSidebarStats(data);
        updateSidebar();

        // Calculate jobs after population is known (non-blocking)
        calculateJobs();
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

    try {
        const resp = await fetch('/api/jobs-in-isochrones', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        jobsData = {};
        (data.stations || []).forEach(s => { jobsData[String(s.id)] = s; });
    } catch (e) {
        console.error('Erro ao calcular empregos:', e);
    }

    if (jobsPOIVisible) renderPOILayer();
    updateJobsSummary();
    updateSidebar();
    computeOverlaps();
    // Refresh scenario ΔH now that jobsData is populated
    if (activeTab === 'scenario') updateScenarioSummary();
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
    const totalJobs = entries.reduce((s, e) => s + (e.jobs_total || 0), 0);
    const avgH      = entries.reduce((s, e) => s + (e.shannon_h || 0), 0) / entries.length;
    totalJobsEl.textContent = formatNumber(totalJobs);
    avgHEl.textContent      = avgH.toFixed(2);
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
        alert('Erro de rede ao enviar ficheiro GTFS.');
        return;
    }

    if (!data.routes || data.routes.length === 0) {
        alert('Nenhuma linha com paragens encontrada dentro da área de Évora.');
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
    renderGroups();
    updateMap();     // enqueues isochrone fetches for all new stations (sequential, 350 ms apart)
    updateSidebar();
    // calculatePopulation() is intentionally NOT called here:
    // runIsochroneQueue() calls it once after all isochrones are ready.

    const skipNote = data.skipped_stops > 0 ? ` (${data.skipped_stops} fora da área ignoradas)` : '';
    alert(`GTFS importado: ${data.total_routes} linha(s), ${addedStations} paragem(ns) adicionada(s).${skipNote}\n\nAs isócronas estão a ser calculadas em sequência — a população e empregos aparecerão progressivamente.`);
}

// ============================================================
//                      SIDEBAR
// ============================================================
function updateSidebarStats(data) {
    document.getElementById('total-population').textContent = formatNumber(data.total_population);
    document.getElementById('total-pop-5min').textContent = formatNumber(data.total_population_5min);
    document.getElementById('total-pop-10min').textContent = formatNumber(data.total_population_10min);
}

function updateSidebar() {
    // Per-group stats
    const groupStatsContainer = document.getElementById('group-stats-container');
    groupStatsContainer.innerHTML = groups.map(g => {
        const groupStations = stations.filter(s => s.groupId === g.id);
        const pop5 = groupStations.reduce((sum, s) => sum + (s.population_5min || 0), 0);
        const pop10 = groupStations.reduce((sum, s) => sum + (s.population_10min || 0), 0);
        const total = pop5 + pop10;
        if (groupStations.length === 0) return '';
        return `
            <div class="stat-card group-stat-card" style="border-left: 4px solid ${g.color};">
                <div class="group-stat-header">
                    <div class="group-stat-color" style="background:${g.color}"></div>
                    <span class="group-stat-name">${escapeHtml(g.name)}</span>
                    <span class="group-stat-count">${groupStations.length} est.</span>
                </div>
                <div class="stat-breakdown">
                    <span class="breakdown-item"><span class="breakdown-label">5 min:</span><span class="breakdown-value">${formatNumber(pop5)}</span></span>
                    <span class="breakdown-item"><span class="breakdown-label">10 min:</span><span class="breakdown-value">${formatNumber(pop10)}</span></span>
                    <span class="breakdown-item" style="font-weight:700;"><span class="breakdown-label">Total:</span><span class="breakdown-value">${formatNumber(total)}</span></span>
                </div>
            </div>
        `;
    }).join('');

    // Station cards
    const container = document.getElementById('stations-container');
    if (stations.length === 0) {
        container.innerHTML = '<p class="no-stations">Nenhuma estação adicionada</p>';
        return;
    }

    const CAT_LABELS = {
        commerce:         'Comércio',
        services:         'Serviços',
        education_health: 'Educação / Saúde',
        culture_leisure:  'Cultura / Lazer',
        industry:         'Indústria',
    };

    container.innerHTML = stations.map((station, index) => {
        const group = getGroupForStation(station);
        const pop5 = station.population_5min || 0;
        const pop10 = station.population_10min || 0;
        const popT = station.population_total || 0;
        const hasError = station.isochroneError;

        const jd = jobsData[String(station.id)];
        let jobsHtml = '';
        if (jd) {
            const hPct    = Math.round((jd.shannon_h || 0) * 100);
            const hColor  = jd.shannon_h >= 0.6 ? '#38a169' : jd.shannon_h >= 0.3 ? '#d69e2e' : '#e53e3e';
            const ssColor = jd.self_sufficiency >= 0.4 ? '#38a169' : jd.self_sufficiency >= 0.2 ? '#d69e2e' : '#e53e3e';
            const breakdown = Object.entries(jd.jobs_breakdown || {})
                .filter(([, v]) => v > 0)
                .sort(([, a], [, b]) => b - a)
                .map(([k, v]) =>
                    `<div class="station-stat-row"><span class="station-stat-label">&nbsp;↳ ${CAT_LABELS[k] || k}:</span><span class="station-stat-value">${formatNumber(v)}</span></div>`
                ).join('');
            const warning = jd.low_coverage_warning
                ? `<div class="jobs-warning">⚠️ Cobertura OSM limitada — estimativa indicativa (${jd.poi_count} POIs)</div>` : '';
            jobsHtml = `
                <div class="station-jobs-section">
                    <div class="station-jobs-header">Empregos estimados (5 min)</div>
                    ${warning}
                    <div class="station-stat-row">
                        <span class="station-stat-label">Total empregos:</span>
                        <span class="station-stat-value">${formatNumber(jd.jobs_total)}</span>
                    </div>
                    ${breakdown}
                    <div class="station-stat-row" style="margin-top:6px;">
                        <span class="station-stat-label">Mix de usos (H):</span>
                        <span class="station-stat-value" style="color:${hColor};font-weight:700;">${jd.shannon_h.toFixed(2)} <span style="font-size:10px;font-weight:400;">(${jd.tod_classification})</span></span>
                    </div>
                    <div class="h-bar-bg"><div class="h-bar-fill" style="width:${hPct}%;background:${hColor};"></div></div>
                    <div class="station-stat-row">
                        <span class="station-stat-label">Auto-suficiência:</span>
                        <span class="station-stat-value" style="color:${ssColor};font-weight:700;">${jd.self_sufficiency.toFixed(2)}</span>
                    </div>
                </div>
            `;
        }

        const overlaps = overlapData[String(station.id)] || [];
        const overlapBadgesHtml = overlaps.length === 0 ? '' : overlaps.map(ov => {
            const pct = Math.round(ov.areaFraction * 100);
            const cls = ov.areaFraction >= 0.4 ? 'danger' : 'warning';
            const icon = cls === 'danger' ? '⛔' : '⚠️';
            const popNote = ov.sharedPop > 0 ? ' · ' + formatNumber(ov.sharedPop) + ' hab' : '';
            return `<div class="overlap-badge ${cls}">${icon} Sobreposição com ${escapeHtml(ov.withName)}: ${pct}% área${popNote}</div>`;
        }).join('');

        return `
            <div class="station-item ${hasError ? 'station-error' : ''}">
                <div class="station-item-header">
                    <span class="station-name"><span class="station-group-dot" style="background:${group.color}"></span> ${escapeHtml(station.name || ('Estação ' + (index + 1)))}${hasError ? ' ⚠️' : ''}</span>
                    <button class="btn-remove" onclick="removeStation(${station.id})" title="Remover">×</button>
                </div>
                ${hasError ? `<div style="background:#fed7d7;color:#c53030;padding:8px;border-radius:4px;margin-bottom:8px;font-size:12px;">⚠️ ${station.isochroneError}</div>` : ''}
                <div class="station-stats">
                    <div class="station-stat-row"><span class="station-stat-label">Área Primária (5 min):</span><span class="station-stat-value">${formatNumber(pop5)}</span></div>
                    <div class="station-stat-row"><span class="station-stat-label">Área Secundária (10 min):</span><span class="station-stat-value">${formatNumber(pop10)}</span></div>
                    <div class="station-stat-row" style="border-top:2px solid #e2e8f0;margin-top:4px;padding-top:8px;font-weight:600;"><span class="station-stat-label">Total:</span><span class="station-stat-value">${formatNumber(popT)}</span></div>
                </div>
                ${jobsHtml}
                ${overlapBadgesHtml}
            </div>
        `;
    }).join('');
}

// ============================================================
//            SCENARIO MODE — CENSUS LAYER
// ============================================================
async function loadCensusLayer() {
    if (censusLayer) return; // already loaded

    try {
        const res = await fetch('/api/census-geojson');
        if (!res.ok) throw new Error('Erro ao carregar GeoJSON');
        censusGeoJSON = await res.json();

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

function showUrbanizationModal() {
    const modal = document.getElementById('urbanization-modal');
    modal.classList.remove('hidden');
    document.getElementById('urb-name').value = `Urbanização ${newUrbanizations.length + 1}`;
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

    const name = document.getElementById('urb-name').value || `Urbanização ${newUrbanizations.length + 1}`;
    const typeIdx = parseInt(document.getElementById('urb-density-type').value);
    const coverage = parseInt(document.getElementById('urb-coverage').value);
    const diffuse = document.getElementById('urb-diffuse').checked;

    const dt = DENSITY_TYPES[typeIdx] || DENSITY_TYPES[2];
    const area = turf.area(pendingUrbanizationGeometry);
    const area_ha = area / 10000;
    const est = Math.round(dt.residents_ha * area_ha * (coverage / 100));

    const urb = {
        id: Date.now(),
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
            { dist: 0.05, pctLabel: '60%', opacity: 0.25 },
            { dist: 0.1, pctLabel: '30%', opacity: 0.15 },
            { dist: 0.2, pctLabel: '10%', opacity: 0.08 }
        ];
        rings.forEach(r => {
            try {
                const buffered = turf.buffer(pendingUrbanizationGeometry, r.dist, { units: 'kilometers' });
                const ring = turf.difference(turf.featureCollection([
                    turf.feature(buffered.geometry || buffered),
                    turf.feature(pendingUrbanizationGeometry)
                ].filter(Boolean)));
                // Simpler: just draw the buffer
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

    // Cleanup
    drawnItems.clearLayers();
    pendingUrbanizationGeometry = null;
    isDrawingUrbanization = false;
    document.getElementById('urbanization-modal').classList.add('hidden');
    renderUrbanizations();
    updateScenarioSummary();
}

function cancelUrbanization() {
    drawnItems.clearLayers();
    pendingUrbanizationGeometry = null;
    isDrawingUrbanization = false;
    document.getElementById('urbanization-modal').classList.add('hidden');
}

function removeUrbanization(urbId) {
    const idx = newUrbanizations.findIndex(u => u.id === urbId);
    if (idx === -1) return;
    const urb = newUrbanizations[idx];
    urb.layers.forEach(l => { try { map.removeLayer(l); } catch {} });
    newUrbanizations.splice(idx, 1);
    renderUrbanizations();
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
                <div class="urbanization-details">
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

    let baseResidents   = hasJobsData ? entries.reduce((s, e) => s + (e.jobs_breakdown ? 0 : 0) + 0, 0) : 0;
    let baseBreakdown   = { commerce: 0, services: 0, education_health: 0, culture_leisure: 0, industry: 0 };
    let baseTotalJobs   = 0;
    let baseResidentSum = 0;

    if (hasJobsData) {
        entries.forEach(e => {
            baseResidentSum += (e.jobs_breakdown ? 0 : 0); // placeholder — residents come from station pop
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
    alert('Catchment recalculado com as alterações do cenário!');
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
        version: '2.0',
        saved_at: new Date().toISOString(),
        groups: groups.map(g => ({ id: g.id, name: g.name, color: g.color, visible: g.visible })),
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
            alert('Ficheiro de projeto inválido.');
            return;
        }

        // Clear current state
        stations.forEach(s => removeStationIsochrones(s.id));
        stationMarkers.forEach(m => { try { map.removeLayer(m); } catch {} });
        newUrbanizations.forEach(u => u.layers.forEach(l => { try { map.removeLayer(l); } catch {} }));
        if (censusLayer) { map.removeLayer(censusLayer); censusLayer = null; }
        drawnItems.clearLayers();

        // Restore groups
        groups = project.groups.map(g => ({ ...g }));
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
        renderGroups();
        updateMap();
        updateSidebar();
        renderUrbanizations();
        updateScenarioSummary();
        saveState();

        const urbs = project.newUrbanizations ? project.newUrbanizations.length : 0;
        const overrides = Object.keys(project.densityOverrides || {}).length;
        alert(`Projeto carregado:\n• ${groups.length} grupo(s)\n• ${stations.length} estação(ões)\n• ${overrides} alteração(s) de densidade BGRI\n• ${urbs} urbanização(es) no cenário`);
    } catch (e) {
        console.error('Erro ao carregar projeto:', e);
        alert('Erro ao carregar projeto: ' + e.message);
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

// ============================================================
//                       INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
    try { initMap(); console.log('App v2.0 inicializada'); } catch (e) { console.error('Erro init:', e); }
});

// Global exports
window.removeStation = removeStation;
window.removeUrbanization = removeUrbanization;
window.togglePOILayer = togglePOILayer;

