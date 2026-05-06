
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
        })),
        new_urbanizations: newUrbanizations.map(u => ({
            id: u.id,
            geometry: u.geometry,
            jobs_ha: (typeof u.jobs_ha === 'number') ? u.jobs_ha : (DENSITY_TYPES[u.densityType] || DENSITY_TYPES[2]).jobs_ha,
            coverage: u.coverage,                                    // 0..100
            mix: u.mix || (DENSITY_TYPES[u.densityType] || DENSITY_TYPES[2]).mix,
        })),
    };

    let success = true;
    try {
        const data = await fetchJSON('/api/jobs-in-isochrones', { body: payload });
        jobsData = {};
        (data.stations || []).forEach(s => { jobsData[String(s.id)] = s; });
        jobsTotalCovered = data.total_jobs_covered || 0;
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

    // Total único, devolvido pelo servidor: POIs deduplicados pela união das
    // isócronas 5 min (cada POI conta uma vez) + urbanizações prorated pela
    // mesma união. Sem dedup local nem fallback.
    const totalJobs = jobsTotalCovered;

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
