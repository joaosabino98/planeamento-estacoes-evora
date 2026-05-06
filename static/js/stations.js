
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
