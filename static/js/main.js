
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
            coverage: u.coverage, diffuse: u.diffuse, estimatedPop: u.estimatedPop,
            jobs_ha: u.jobs_ha, mix: u.mix, estimatedJobs: u.estimatedJobs
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

                // Backwards compat: projetos antigos não têm jobs_ha/mix → usa defaults do tipo.
                const jobs_ha = (typeof u.jobs_ha === 'number') ? u.jobs_ha : dt.jobs_ha;
                const mix = u.mix || dt.mix;
                newUrbanizations.push({ ...u, jobs_ha, mix, layers });
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
        applyUrbanizationVisibility();
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
    // Jobs: total único deduplicado vindo do servidor (POIs + urbanizações).
    const totalJobsAll = jobsTotalCovered;
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

