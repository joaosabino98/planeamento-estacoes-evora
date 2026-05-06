
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

    // Empregos cobertos: total único deduplicado vindo do servidor.
    const coveredJobs = jobsTotalCovered;

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
        applyUrbJobFieldsFromUrb(existing);
        if (titleEl) titleEl.textContent = 'Editar Urbanização';
        if (btnConfirm) btnConfirm.textContent = 'Guardar';
    } else {
        editingUrbanizationId = null;
        document.getElementById('urb-name').value = `Urbanização ${newUrbanizations.length + 1}`;
        applyUrbJobFieldsFromType();
        if (titleEl) titleEl.textContent = 'Nova Urbanização';
        if (btnConfirm) btnConfirm.textContent = 'Criar';
    }
    modal.classList.remove('hidden');
    updateUrbanizationEstimate();
}

// Preenche os campos de empregos/mix com os defaults do tipo de densidade selecionado.
function applyUrbJobFieldsFromType() {
    const typeIdx = parseInt(document.getElementById('urb-density-type').value);
    const dt = DENSITY_TYPES[typeIdx] || DENSITY_TYPES[2];
    const jhEl = document.getElementById('urb-jobs-ha');
    const defEl = document.getElementById('urb-jobs-ha-default');
    if (jhEl) jhEl.value = dt.jobs_ha;
    if (defEl) defEl.textContent = `(default: ${dt.jobs_ha})`;
    MIX_CATEGORIES.forEach(cat => {
        const inp = document.getElementById('urb-mix-' + cat);
        if (inp) inp.value = Math.round((dt.mix[cat] || 0) * 100);
    });
}

// Preenche os campos de empregos/mix a partir de uma urb existente (para edição).
function applyUrbJobFieldsFromUrb(urb) {
    const dt = DENSITY_TYPES[urb.densityType] || DENSITY_TYPES[2];
    const jhEl = document.getElementById('urb-jobs-ha');
    const defEl = document.getElementById('urb-jobs-ha-default');
    if (jhEl) jhEl.value = (typeof urb.jobs_ha === 'number') ? urb.jobs_ha : dt.jobs_ha;
    if (defEl) defEl.textContent = `(default: ${dt.jobs_ha})`;
    const mix = urb.mix || dt.mix;
    MIX_CATEGORIES.forEach(cat => {
        const inp = document.getElementById('urb-mix-' + cat);
        if (inp) inp.value = Math.round((mix[cat] || 0) * 100);
    });
}

// Lê os campos do modal e devolve { jobs_ha, mix } com mix normalizado a soma 1.
function readUrbJobFields() {
    const jhRaw = parseFloat(document.getElementById('urb-jobs-ha').value);
    const jobs_ha = isFinite(jhRaw) && jhRaw >= 0 ? jhRaw : 0;
    const raw = {};
    let sum = 0;
    MIX_CATEGORIES.forEach(cat => {
        const v = parseFloat(document.getElementById('urb-mix-' + cat).value);
        const safe = isFinite(v) && v > 0 ? v : 0;
        raw[cat] = safe;
        sum += safe;
    });
    const mix = {};
    MIX_CATEGORIES.forEach(cat => {
        mix[cat] = sum > 0 ? raw[cat] / sum : 0;
    });
    return { jobs_ha, mix };
}

function updateUrbanizationEstimate() {
    const coverageSlider = document.getElementById('urb-coverage');
    document.getElementById('urb-coverage-value').textContent = coverageSlider.value + '%';

    const popEl = document.getElementById('urb-estimated-pop');
    const jobsEl = document.getElementById('urb-estimated-jobs');
    if (!pendingUrbanizationGeometry) {
        popEl.textContent = '—';
        if (jobsEl) jobsEl.textContent = '—';
        return;
    }

    const typeIdx = parseInt(document.getElementById('urb-density-type').value);
    if (isNaN(typeIdx)) { popEl.textContent = '—'; if (jobsEl) jobsEl.textContent = '—'; return; }

    const dt = DENSITY_TYPES[typeIdx];
    const area = turf.area(pendingUrbanizationGeometry); // m²
    const area_ha = area / 10000;
    const coverage = parseInt(coverageSlider.value) / 100;

    const est = Math.round(dt.residents_ha * area_ha * coverage);
    popEl.textContent = formatNumber(Math.max(0, est));

    // Empregos: usa os valores atuais dos campos (override do utilizador)
    if (jobsEl) {
        const jhInput = document.getElementById('urb-jobs-ha');
        const jhRaw = jhInput ? parseFloat(jhInput.value) : NaN;
        const jobs_ha = isFinite(jhRaw) && jhRaw >= 0 ? jhRaw : dt.jobs_ha;
        const estJobs = Math.round(jobs_ha * area_ha * coverage);
        jobsEl.textContent = formatNumber(Math.max(0, estJobs));
    }
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
    const { jobs_ha, mix } = readUrbJobFields();
    const estJobs = Math.round(jobs_ha * area_ha * (coverage / 100));

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
        jobs_ha,
        mix,
        estimatedJobs: Math.max(0, estJobs),
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
    applyUrbanizationVisibility();
    refreshAugmentedIsochrones();
    updateScenarioSummary();
    // Recalcular empregos: a urbanização altera o breakdown (POIs descartados
    // dentro do polígono + empregos paramétricos prorated) e o Shannon H.
    if (stations.length > 0) calculateJobs();
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
    if (stations.length > 0) calculateJobs();
}

// Mostra/oculta as camadas das novas urbanizações sem alterar o estado
// (newUrbanizations[]). Os cálculos de população, empregos e overlays "preenche
// polígono" continuam a usar os dados — só a visibilidade no mapa muda.
function applyUrbanizationVisibility() {
    urbanizationLayers.forEach(l => {
        try {
            if (showNewUrbanizations) {
                if (!map.hasLayer(l)) l.addTo(map);
            } else {
                if (map.hasLayer(l)) map.removeLayer(l);
            }
        } catch {}
    });
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
