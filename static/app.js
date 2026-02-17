// Coordenadas de Évora (centro da cidade)
const EVORA_CENTER = [38.5667, -7.9075];
const EVORA_ZOOM = 13;

// Velocidade a pé: ~5 km/h = ~83 m/min
// Raio em metros
const RADIUS_5MIN = 417;  // ~5 minutos a pé
const RADIUS_10MIN = 833; // ~10 minutos a pé

// Estado da aplicação
let map;
let stations = [];
let stationMarkers = [];
let isochroneLayers = [];
let stationIsochroneLayers = {}; // Mapear station.id -> array de camadas
let isUpdating = false;

// Sistema de undo/redo
let historyStack = []; // Histórico de estados
let historyIndex = -1; // Índice atual no histórico
const MAX_HISTORY = 50; // Limite de histórico
let isSavingState = false; // Flag para evitar salvar estado duplicado

// Inicializar mapa
function initMap() {
    const mapElement = document.getElementById('map');
    if (!mapElement) {
        console.error('Elemento #map não encontrado!');
        return;
    }
    
    console.log('Criando mapa Leaflet...');
    map = L.map('map').setView(EVORA_CENTER, EVORA_ZOOM);
    
    // Adicionar tile layer (OpenStreetMap)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);
    
    console.log('Tile layer adicionado');
    
    // Event listener para adicionar estação ao clicar no mapa
    map.on('click', function(e) {
        if (!isUpdating) {
            addStation(e.latlng.lat, e.latlng.lng);
        }
    });
    
    // Botão limpar
    document.getElementById('btn-clear').addEventListener('click', clearAllStations);
    
    // Botão exportar
    document.getElementById('btn-export').addEventListener('click', exportToCSV);
    
    // Botão importar
    document.getElementById('btn-import').addEventListener('click', () => {
        document.getElementById('file-input').click();
    });
    
    // Input de arquivo
    document.getElementById('file-input').addEventListener('change', importFromCSV);
    
    // Atalhos de teclado para undo/redo
    document.addEventListener('keydown', function(e) {
        // Ctrl+Z ou Cmd+Z para undo
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            undo();
        }
        // Ctrl+Shift+Z ou Cmd+Shift+Z para redo
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) {
            e.preventDefault();
            redo();
        }
        // Ctrl+Y ou Cmd+Y para redo (alternativa)
        if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
            e.preventDefault();
            redo();
        }
    });
    
    // Salvar estado inicial
    saveState();
}

// Salvar estado atual no histórico
function saveState(skipDuplicateCheck = false) {
    // Evitar salvar estado duplicado (a menos que explicitamente solicitado)
    if (!skipDuplicateCheck && isSavingState) {
        return;
    }
    
    isSavingState = true;
    
    // Criar deep copy do estado atual (apenas dados essenciais: id, lat, lng)
    // Não salvar isócronas, população, etc. - apenas posições
    const state = stations.map(s => ({
        id: s.id,
        lat: s.lat,
        lng: s.lng
    }));
    
    // Verificar se o estado é diferente do último estado salvo
    if (historyStack.length > 0 && historyIndex >= 0 && historyIndex < historyStack.length) {
        const lastState = historyStack[historyIndex];
        // Comparar se é realmente diferente (apenas coordenadas e IDs)
        // Ordenar por ID para comparação consistente
        const normalizeState = (s) => {
            const sorted = [...s].sort((a, b) => String(a.id).localeCompare(String(b.id)));
            return JSON.stringify(sorted);
        };
        if (normalizeState(lastState) === normalizeState(state)) {
            isSavingState = false;
            return; // Estado idêntico, não salvar
        }
    }
    
    // Remover estados futuros se estamos no meio do histórico
    if (historyIndex < historyStack.length - 1) {
        historyStack = historyStack.slice(0, historyIndex + 1);
    }
    
    // Adicionar novo estado
    historyStack.push(state);
    
    // Limitar tamanho do histórico
    if (historyStack.length > MAX_HISTORY) {
        historyStack.shift();
    }
    
    // historyIndex sempre aponta para o último estado (estado atual)
    historyIndex = historyStack.length - 1;
    
    isSavingState = false;
}

// Desfazer última ação
function undo() {
    // historyIndex aponta para o estado atual (último estado salvo)
    // Para desfazer, precisamos ir para o estado anterior (historyIndex - 1)
    if (historyIndex >= 0 && historyStack.length > 0) {
        if (historyIndex > 0) {
            historyIndex--;
            restoreState(historyStack[historyIndex], true);
        } else {
            // Se estamos no primeiro estado (índice 0), ir para estado vazio
            historyIndex = -1;
            stations = [];
            isSavingState = true;
            updateMap();
            updateSidebar();
            calculatePopulation();
            isSavingState = false;
        }
    }
}

// Refazer ação desfeita
function redo() {
    if (historyIndex < historyStack.length - 1) {
        historyIndex++;
        restoreState(historyStack[historyIndex], true);
    }
}

// Restaurar estado do histórico
function restoreState(state, skipSave = false) {
    // Preservar cache de isócronas para estações que não mudaram
    const cachePreservation = {};
    stations.forEach(oldStation => {
        const matchingState = state.find(s => String(s.id) === String(oldStation.id));
        if (matchingState && 
            oldStation.isochrones && 
            Array.isArray(oldStation.isochrones) &&
            oldStation.isochrones.length >= 2 &&
            !oldStation.isochroneError &&
            oldStation.cachedLat === matchingState.lat &&
            oldStation.cachedLng === matchingState.lng) {
            // Preservar cache se coordenadas não mudaram
            cachePreservation[String(oldStation.id)] = {
                isochrones: oldStation.isochrones,
                cachedLat: oldStation.cachedLat,
                cachedLng: oldStation.cachedLng,
                isochroneError: oldStation.isochroneError
            };
        }
    });
    
    // Criar deep copy do estado e restaurar apenas dados essenciais
    // As estações no histórico só têm id, lat, lng
    stations = state.map(s => {
        const cached = cachePreservation[String(s.id)];
        return {
            id: s.id,
            lat: s.lat,
            lng: s.lng,
            // Preservar cache se disponível
            ...(cached ? cached : {})
        };
    });
    
    // Atualizar interface (sem salvar estado durante restauração)
    isSavingState = true; // Prevenir saveState durante restore
    updateMap();
    updateSidebar();
    calculatePopulation();
    isSavingState = false;
    
    // Se skipSave for true, não salvar estado após restaurar (para undo/redo)
    // Caso contrário, salvar o estado restaurado (para importação, etc.)
    if (!skipSave) {
        // Ajustar historyIndex para apontar para o estado atual
        // Não adicionar novo estado, apenas ajustar o índice
        const currentState = stations.map(s => ({ id: s.id, lat: s.lat, lng: s.lng }));
        const stateIndex = historyStack.findIndex(s => JSON.stringify(s) === JSON.stringify(currentState));
        if (stateIndex !== -1) {
            historyIndex = stateIndex;
        }
    }
}

// Adicionar estação
function addStation(lat, lng) {
    saveState(); // Salvar estado antes de adicionar
    
    const stationId = Date.now();
    const station = {
        id: stationId,
        lat: lat,
        lng: lng
    };
    
    stations.push(station);
    updateMap();
    updateSidebar();
    // calculatePopulation será chamado quando as isócronas estiverem prontas
}

// Remover estação
function removeStation(stationId) {
    saveState(); // Salvar estado antes de remover
    
    stations = stations.filter(s => s.id !== stationId);
    updateMap();
    updateSidebar();
    calculatePopulation();
}

// Limpar todas as estações
function clearAllStations() {
    if (confirm('Tem a certeza que deseja remover todas as estações?')) {
        saveState(); // Salvar estado antes de limpar
        
        stations = [];
        updateMap();
        updateSidebar();
        calculatePopulation();
    }
}

// Verificar se uma estação tem isócronas válidas em cache
function hasValidCache(station) {
    return station.isochrones && 
           Array.isArray(station.isochrones) && 
           station.isochrones.length >= 2 &&
           !station.isochroneError &&
           station.cachedLat === station.lat &&
           station.cachedLng === station.lng;
}

// Verificar se as camadas de uma estação estão desenhadas no mapa
function areLayersOnMap(stationId) {
    const existingLayers = stationIsochroneLayers[stationId] || [];
    const layersOnMap = existingLayers.filter(layer => {
        try {
            return map.hasLayer(layer);
        } catch (e) {
            return false;
        }
    });
    return layersOnMap.length >= 2;
}

// Atualizar mapa - apenas recria marcadores, preserva isócronas com cache válido
function updateMap() {
    // Remover apenas marcadores antigos (não tocar nas isócronas)
    stationMarkers.forEach(marker => {
        try {
            if (map.hasLayer(marker)) {
                map.removeLayer(marker);
            }
        } catch (e) {
            console.warn('Erro ao remover marker:', e);
        }
    });
    
    // Remover camadas de estações que não existem mais
    const existingStationIds = new Set(stations.map(s => String(s.id)));
    Object.keys(stationIsochroneLayers).forEach(stationId => {
        if (!existingStationIds.has(String(stationId))) {
            stationIsochroneLayers[stationId].forEach(layer => {
                try {
                    if (map.hasLayer(layer)) {
                        map.removeLayer(layer);
                    }
                } catch (e) {
                    console.warn('Erro ao remover layer:', e);
                }
                const index = isochroneLayers.indexOf(layer);
                if (index > -1) {
                    isochroneLayers.splice(index, 1);
                }
            });
            delete stationIsochroneLayers[stationId];
        }
    });
    
    // Limpar marcadores de carregamento
    stations.forEach(station => {
        if (station.loadingMarker) {
            try {
                if (map.hasLayer(station.loadingMarker)) {
                    map.removeLayer(station.loadingMarker);
                }
            } catch (e) {
                console.warn('Erro ao remover loading marker:', e);
            }
            station.loadingMarker = null;
        }
        station.creatingIsochrones = false;
    });
    
    stationMarkers = [];
    
    // Adicionar novos marcadores
    stations.forEach((station) => {
        const marker = createStationMarker(station);
        stationMarkers.push(marker);
        
        // Inicializar isócronas apenas se necessário (não tem cache válido ou não está desenhada)
        if (!hasValidCache(station) || !areLayersOnMap(station.id)) {
            initializeStationIsochrones(station);
        }
    });
    
    // Não calcular população aqui - será calculado quando as isócronas estiverem prontas
}

// Criar marcador para uma estação
function createStationMarker(station) {
    const marker = L.marker([station.lat, station.lng], {
        draggable: true,
        icon: L.divIcon({
            className: 'station-marker',
            html: `<div style="
                background: #667eea;
                width: 24px;
                height: 24px;
                border-radius: 50%;
                border: 3px solid white;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            "></div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        })
    }).addTo(map);
    
    let dragStartCoords = null;
    
    marker.on('dragstart', function() {
        isUpdating = true;
        dragStartCoords = { lat: station.lat, lng: station.lng };
        // Não salvar estado aqui - vamos salvar apenas no dragend se realmente mudou
    });
    
    marker.on('drag', function(e) {
        const newLat = e.target.getLatLng().lat;
        const newLng = e.target.getLatLng().lng;
        station.lat = newLat;
        station.lng = newLng;
        // Atualizar no array também
        const stationIndex = stations.findIndex(s => s.id === station.id);
        if (stationIndex !== -1) {
            stations[stationIndex].lat = newLat;
            stations[stationIndex].lng = newLng;
        }
    });
    
    marker.on('dragend', async function(e) {
        isUpdating = false;
        const newLat = e.target.getLatLng().lat;
        const newLng = e.target.getLatLng().lng;
        
        // Encontrar a estação atual no array (pode ter mudado)
        const stationIndex = stations.findIndex(s => s.id === station.id);
        if (stationIndex === -1) {
            console.error('Estação não encontrada após dragend');
            return;
        }
        
        const currentStation = stations[stationIndex];
        
        const coordsChanged = dragStartCoords && 
                              (Math.abs(dragStartCoords.lat - newLat) > 0.0001 || 
                               Math.abs(dragStartCoords.lng - newLng) > 0.0001);
        
        if (!coordsChanged) {
            // Restaurar coordenadas
            currentStation.lat = dragStartCoords.lat;
            currentStation.lng = dragStartCoords.lng;
            dragStartCoords = null;
            calculatePopulation();
            return;
        }
        
        // Atualizar coordenadas
        currentStation.lat = newLat;
        currentStation.lng = newLng;
        dragStartCoords = null;
        
        // Salvar estado ANTES de limpar cache (para undo funcionar corretamente)
        saveState();
        
        // Limpar cache e recriar isócronas
        removeStationIsochrones(currentStation.id);
        currentStation.isochrones = null;
        currentStation.cachedLat = null;
        currentStation.cachedLng = null;
        currentStation.isochroneError = null;
        currentStation.creatingIsochrones = false;
        
        // Recriar isócronas (forçar) e calcular população após terminar
        await createIsochrones(currentStation, true);
        // Calcular população após recriar isócronas
        await calculatePopulation();
    });
    
    return marker;
}

// Inicializar isócronas de uma estação (apenas se necessário)
function initializeStationIsochrones(station) {
    // Verificar cache novamente antes de criar
    if (hasValidCache(station) && areLayersOnMap(station.id)) {
        return; // Já tem cache válido e desenhado
    }
    
    // Criar isócronas (assíncrono)
    createIsochrones(station).then(() => {
        // Após criar isócronas, calcular população
        calculatePopulation();
    }).catch(error => {
        console.error('Erro ao criar isócronas:', error);
        // Mesmo em caso de erro, calcular população (pode ter outras estações válidas)
        calculatePopulation();
    });
}

// Desenhar isócronas do cache no mapa
function drawCachedIsochrones(station) {
    if (!station.isochrones || !Array.isArray(station.isochrones) || station.isochrones.length < 2) {
        return;
    }
    
    if (!stationIsochroneLayers[station.id]) {
        stationIsochroneLayers[station.id] = [];
    }
    
    // Desenhar isócrona de 5 minutos
    if (station.isochrones[0]) {
        const layer5min = L.geoJSON(station.isochrones[0], {
            style: {
                color: '#667eea',
                fillColor: '#667eea',
                fillOpacity: 0.2,
                weight: 2,
                opacity: 0.8
            }
        }).addTo(map);
        isochroneLayers.push(layer5min);
        stationIsochroneLayers[station.id].push(layer5min);
    }
    
    // Desenhar isócrona de 10 minutos
    if (station.isochrones[1]) {
        const layer10min = L.geoJSON(station.isochrones[1], {
            style: {
                color: '#764ba2',
                fillColor: '#764ba2',
                fillOpacity: 0.15,
                weight: 2,
                opacity: 0.7
            }
        }).addTo(map);
        isochroneLayers.push(layer10min);
        stationIsochroneLayers[station.id].push(layer10min);
    }
}

// Criar isócronas reais para uma estação
async function createIsochrones(station, forceRefresh = false) {
    // Evitar criar isócronas múltiplas vezes simultaneamente para a mesma estação
    if (station.creatingIsochrones) {
        return;
    }
    
    // Se não forçar refresh, verificar cache
    if (!forceRefresh && hasValidCache(station)) {
        // Se já estão desenhadas, não fazer nada
        if (areLayersOnMap(station.id)) {
            return;
        }
        // Se não estão desenhadas, desenhar do cache
        drawCachedIsochrones(station);
        return;
    }
    
    // Remover isócronas antigas desta estação antes de criar novas
    removeStationIsochrones(station.id);
    
    station.creatingIsochrones = true;
    
    try {
        // Mostrar indicador de carregamento
        const loadingMarker = L.marker([station.lat, station.lng], {
            icon: L.divIcon({
                className: 'loading-marker',
                html: '<div style="background: #ffa500; width: 20px; height: 20px; border-radius: 50%; border: 2px solid white; animation: pulse 1s infinite;"></div>',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            })
        }).addTo(map);
        
        // Guardar referência do marcador de carregamento para poder removê-lo depois
        station.loadingMarker = loadingMarker;
        
        // Obter isócronas reais da API
        const response = await fetch('http://localhost:5000/api/isochrones', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                lat: station.lat,
                lng: station.lng,
                ranges: [300, 600] // 5 min e 10 min em segundos (5 km/h = 1.39 m/s)
            })
        });
        
        if (!response.ok) {
            throw new Error('Erro ao obter isócronas');
        }
        
        const data = await response.json();
        
        // Remover marcador de carregamento
        if (station.loadingMarker && map.hasLayer(station.loadingMarker)) {
            map.removeLayer(station.loadingMarker);
        }
        station.loadingMarker = null;
        
        // Inicializar array de camadas para esta estação
        if (!stationIsochroneLayers[station.id]) {
            stationIsochroneLayers[station.id] = [];
        }
        
        // Desenhar isócrona de 5 minutos (área primária)
        if (data.isochrones && data.isochrones[0]) {
            const layer5min = L.geoJSON(data.isochrones[0], {
                style: {
                    color: '#667eea',
                    fillColor: '#667eea',
                    fillOpacity: 0.2,
                    weight: 2,
                    opacity: 0.8
                }
            }).addTo(map);
            isochroneLayers.push(layer5min);
            stationIsochroneLayers[station.id].push(layer5min);
        }
        
        // Desenhar isócrona de 10 minutos (área secundária)
        if (data.isochrones && data.isochrones[1]) {
            const layer10min = L.geoJSON(data.isochrones[1], {
                style: {
                    color: '#764ba2',
                    fillColor: '#764ba2',
                    fillOpacity: 0.15,
                    weight: 2,
                    opacity: 0.7
                }
            }).addTo(map);
            isochroneLayers.push(layer10min);
            stationIsochroneLayers[station.id].push(layer10min);
        }
        
        // Guardar geometrias das isócronas na estação para cálculo de população
        // E também guardar as coordenadas para verificar cache no futuro
        station.isochrones = data.isochrones || [];
        station.cachedLat = station.lat;
        station.cachedLng = station.lng;
        station.isochroneError = null; // Limpar erro anterior se houver
        
        // Atualizar também no array stations se necessário
        const stationIndex = stations.findIndex(s => s.id === station.id);
        if (stationIndex !== -1) {
            stations[stationIndex].isochrones = station.isochrones;
            stations[stationIndex].cachedLat = station.cachedLat;
            stations[stationIndex].cachedLng = station.cachedLng;
            stations[stationIndex].isochroneError = null;
        }
        
    } catch (error) {
        console.error('Erro ao criar isócronas:', error);
        
        // Remover marcador de carregamento em caso de erro
        if (station.loadingMarker && map.hasLayer(station.loadingMarker)) {
            map.removeLayer(station.loadingMarker);
        }
        station.loadingMarker = null;
        
        // Não criar círculos de fallback - mostrar erro
        station.isochrones = null;
        station.isochroneError = error.message || 'Erro ao obter isócronas';
        
        // Atualizar também no array stations
        const stationIndex = stations.findIndex(s => s.id === station.id);
        if (stationIndex !== -1) {
            stations[stationIndex].isochrones = null;
            stations[stationIndex].isochroneError = station.isochroneError;
        }
        
        // Inicializar array de camadas para esta estação
        if (!stationIsochroneLayers[station.id]) {
            stationIsochroneLayers[station.id] = [];
        }
        
        // Mostrar mensagem de erro no marcador
        const errorMarker = L.marker([station.lat, station.lng], {
            icon: L.divIcon({
                className: 'error-marker',
                html: `<div style="
                    background: #fc8181;
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    border: 3px solid white;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                    position: relative;
                " title="Erro ao carregar isócronas"></div>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            })
        }).addTo(map);
        
        errorMarker.bindPopup(`
            <div style="padding: 8px;">
                <strong>Erro ao carregar isócronas</strong><br>
                <small>${station.isochroneError}</small><br>
                <small style="color: #718096;">As isócronas não estão disponíveis para esta estação.</small>
            </div>
        `).openPopup();
        
        isochroneLayers.push(errorMarker);
        stationIsochroneLayers[station.id].push(errorMarker);
    } finally {
        // Sempre limpar a flag de criação
        station.creatingIsochrones = false;
    }
}

// Remover isócronas de uma estação específica
function removeStationIsochrones(stationId) {
    // Remover apenas as camadas desta estação
    if (stationIsochroneLayers[stationId]) {
        stationIsochroneLayers[stationId].forEach(layer => {
            try {
                if (map.hasLayer(layer)) {
                    map.removeLayer(layer);
                }
            } catch (e) {
                console.warn('Erro ao remover layer:', e);
            }
            // Remover do array global também
            const index = isochroneLayers.indexOf(layer);
            if (index > -1) {
                isochroneLayers.splice(index, 1);
            }
        });
        // Limpar referências desta estação
        delete stationIsochroneLayers[stationId];
    }
    
    // Também remover marcador de carregamento se existir
    const station = stations.find(s => s.id === stationId);
    if (station && station.loadingMarker) {
        try {
            if (map.hasLayer(station.loadingMarker)) {
                map.removeLayer(station.loadingMarker);
            }
        } catch (e) {
            console.warn('Erro ao remover loading marker:', e);
        }
        station.loadingMarker = null;
    }
}

// Calcular população
async function calculatePopulation() {
    if (stations.length === 0) {
        updateSidebarStats({
            total_population: 0,
            total_population_5min: 0,
            total_population_10min: 0,
            points: []
        });
        updateSidebar();
        return;
    }
    
    try {
        const response = await fetch('http://localhost:5000/api/population-in-isochrones', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                points: stations.map(s => ({
                    id: s.id,
                    lat: s.lat,
                    lng: s.lng,
                    isochrones: (s.isochrones && !s.isochroneError && Array.isArray(s.isochrones) && s.isochrones.length >= 2) ? s.isochrones : null  // Enviar isócronas apenas se disponíveis e sem erro
                }))
            })
        });
        
        if (!response.ok) {
            throw new Error('Erro ao calcular população');
        }
        
        const data = await response.json();
        
        // Atualizar dados das estações
        stations = stations.map(station => {
            // Comparar IDs convertendo ambos para string para garantir correspondência
            const pointData = data.points.find(p => {
                const pId = String(p.id);
                const sId = String(station.id);
                return pId === sId;
            });
            
            if (pointData) {
                // Garantir que os valores são números
                return {
                    ...station,
                    population_5min: Number(pointData.population_5min) || 0,
                    population_10min: Number(pointData.population_10min) || 0,
                    population_total: Number(pointData.population_total) || 0
                };
            }
            // Se não encontrou, manter valores existentes ou zerar
            return {
                ...station,
                population_5min: Number(station.population_5min) || 0,
                population_10min: Number(station.population_10min) || 0,
                population_total: Number(station.population_total) || 0
            };
        });
        
        updateSidebarStats(data);
        updateSidebar(); // Atualizar sidebar para mostrar valores atualizados
    } catch (error) {
        console.error('Erro ao calcular população:', error);
        // Em caso de erro, ainda atualizamos a sidebar sem dados de população
        // Mas mantemos os valores existentes se houver
        stations = stations.map(s => ({
            ...s,
            population_5min: Number(s.population_5min) || 0,
            population_10min: Number(s.population_10min) || 0,
            population_total: Number(s.population_total) || 0
        }));
        
        updateSidebarStats({
            total_population: 0,
            total_population_5min: 0,
            total_population_10min: 0,
            points: stations.map(s => ({
                id: s.id,
                population_5min: s.population_5min || 0,
                population_10min: s.population_10min || 0,
                population_total: s.population_total || 0
            }))
        });
        updateSidebar(); // Atualizar sidebar mesmo em caso de erro
    }
}

// Atualizar sidebar com estatísticas
function updateSidebarStats(data) {
    document.getElementById('total-population').textContent = formatNumber(data.total_population);
    document.getElementById('total-pop-5min').textContent = formatNumber(data.total_population_5min);
    document.getElementById('total-pop-10min').textContent = formatNumber(data.total_population_10min);
}

// Atualizar sidebar
function updateSidebar() {
    const container = document.getElementById('stations-container');
    
    if (stations.length === 0) {
        container.innerHTML = '<p class="no-stations">Nenhuma estação adicionada</p>';
        return;
    }
    
    container.innerHTML = stations.map((station, index) => {
        const pop5min = station.population_5min || 0;
        const pop10min = station.population_10min || 0;
        const popTotal = station.population_total || 0;
        const hasError = station.isochroneError;
        
        return `
            <div class="station-item ${hasError ? 'station-error' : ''}">
                <div class="station-item-header">
                    <span class="station-name">Estação ${index + 1}${hasError ? ' ⚠️' : ''}</span>
                    <button class="btn-remove" onclick="removeStation(${station.id})" title="Remover">×</button>
                </div>
                ${hasError ? `
                    <div style="background: #fed7d7; color: #c53030; padding: 8px; border-radius: 4px; margin-bottom: 8px; font-size: 12px;">
                        ⚠️ Erro ao carregar isócronas: ${station.isochroneError}
                    </div>
                ` : ''}
                <div class="station-stats">
                    <div class="station-stat-row">
                        <span class="station-stat-label">Área Primária (5 min):</span>
                        <span class="station-stat-value">${formatNumber(pop5min)}</span>
                    </div>
                    <div class="station-stat-row">
                        <span class="station-stat-label">Área Secundária (10 min):</span>
                        <span class="station-stat-value">${formatNumber(pop10min)}</span>
                    </div>
                    <div class="station-stat-row" style="border-top: 2px solid #e2e8f0; margin-top: 4px; padding-top: 8px; font-weight: 600;">
                        <span class="station-stat-label">Total:</span>
                        <span class="station-stat-value">${formatNumber(popTotal)}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Formatar número
function formatNumber(num) {
    return new Intl.NumberFormat('pt-PT').format(Math.round(num || 0));
}

// Inicializar quando a página carregar
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM carregado, inicializando mapa...');
    try {
        initMap();
        console.log('Mapa inicializado com sucesso');
    } catch (error) {
        console.error('Erro ao inicializar mapa:', error);
    }
});

// Exportar pontos para CSV
async function exportToCSV() {
    if (stations.length === 0) {
        alert('Não há estações para exportar');
        return;
    }
    
    try {
        const response = await fetch('http://localhost:5000/api/export-points', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                points: stations.map(s => ({
                    id: s.id,
                    lat: s.lat,
                    lng: s.lng,
                    population_5min: s.population_5min || 0,
                    population_10min: s.population_10min || 0,
                    population_total: s.population_total || 0
                }))
            })
        });
        
        if (!response.ok) {
            throw new Error('Erro ao exportar CSV');
        }
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `estacoes_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    } catch (error) {
        console.error('Erro ao exportar CSV:', error);
        alert('Erro ao exportar CSV: ' + error.message);
    }
}

// Importar pontos de CSV
async function importFromCSV(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }
    
    if (!file.name.endsWith('.csv')) {
        alert('Por favor, selecione um arquivo CSV');
        return;
    }
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        const response = await fetch('http://localhost:5000/api/import-points', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erro ao importar CSV');
        }
        
        const data = await response.json();
        
        if (data.success && data.points && data.points.length > 0) {
            // Salvar estado antes de importar
            saveState();
            
            // Perguntar se quer substituir ou adicionar
            const action = confirm(
                `Encontrados ${data.count} pontos no CSV.\n\n` +
                'OK = Adicionar aos pontos existentes\n' +
                'Cancelar = Substituir todos os pontos'
            );
            
            if (action) {
                // Adicionar aos existentes
                data.points.forEach(point => {
                    // Verificar se já existe (mesma lat/lng)
                    const exists = stations.some(s => 
                        Math.abs(s.lat - point.lat) < 0.0001 && 
                        Math.abs(s.lng - point.lng) < 0.0001
                    );
                    if (!exists) {
                        stations.push({
                            id: point.id || Date.now() + Math.random(),
                            lat: point.lat,
                            lng: point.lng
                        });
                    }
                });
            } else {
                // Substituir todos
                stations = data.points.map(point => ({
                    id: point.id || Date.now() + Math.random(),
                    lat: point.lat,
                    lng: point.lng
                }));
            }
            
            // Limpar input
            event.target.value = '';
            
            // Atualizar mapa e calcular população
            updateMap();
            updateSidebar();
            calculatePopulation();
            
            alert(`Importados ${data.count} pontos com sucesso!`);
        } else {
            alert('Nenhum ponto válido encontrado no CSV');
        }
    } catch (error) {
        console.error('Erro ao importar CSV:', error);
        alert('Erro ao importar CSV: ' + error.message);
        event.target.value = '';
    }
}

// Tornar removeStation acessível globalmente
window.removeStation = removeStation;

