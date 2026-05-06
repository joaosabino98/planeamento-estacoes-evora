
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
    document.getElementById('urb-density-type').addEventListener('change', () => {
        // Ao mudar de tipo, repõe os defaults de empregos/mix.
        applyUrbJobFieldsFromType();
        updateUrbanizationEstimate();
    });
    document.getElementById('urb-jobs-ha').addEventListener('input', updateUrbanizationEstimate);

    // Toggle do overlay "preenche polígono"
    const augToggle = document.getElementById('toggle-augmented-overlay');
    if (augToggle) {
        augToggle.addEventListener('change', (e) => {
            showAugmentedOverlay = !!e.target.checked;
            refreshAugmentedIsochrones();
        });
    }

    // Toggle visibilidade das novas urbanizações no mapa (não afeta cálculos)
    const urbToggle = document.getElementById('toggle-new-urbanizations');
    if (urbToggle) {
        urbToggle.addEventListener('change', (e) => {
            showNewUrbanizations = !!e.target.checked;
            applyUrbanizationVisibility();
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
