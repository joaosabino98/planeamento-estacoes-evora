# Mobilidade e Território — Desenvolvimento Orientado ao Transporte (TOD) — Évora

Ferramenta web interativa para planeamento urbano orientado ao transporte público em Évora. Combina o posicionamento de paragens/estações com a simulação de cenários de densificação urbana, permitindo estimar a população abrangida por redes de transporte e projetar o impacto de alterações ao uso do solo.

## Funcionalidades

### Planeamento de paragens / estações

- Adicionar paragens clicando no mapa; arrastar para reposicionar; remover com ×
- Organização em **grupos com nome e cor** personalizáveis; visibilidade por grupo
- **Isócronas reais** de 5 e 10 minutos a pé via OpenRouteService (fallback para círculo quando a API não está disponível)
- Cálculo de **população residente** nas áreas de captação, sem dupla contagem entre estações sobrepostas
- Estatísticas por grupo (5 min / 10 min / total) e totais globais em tempo real
- Undo/redo com Ctrl+Z / Ctrl+Shift+Z

### Análise de Empregos e Mix de Usos

- **Estimativa de emprego** por área de captação de 5 minutos, calculada automaticamente após colocar estações com isócronas válidas
- Dados recolhidos em tempo real via **API Overpass (OpenStreetMap)** — não requer chave de API
- Decomposição em **6 categorias funcionais**: Comércio, Serviços, Educação/Saúde, Cultura/Lazer, Restauração e Indústria
- **Índice H de Shannon normalizado** (0–1): mede a diversidade do mix de usos na área de captação — um valor elevado indica maior equilíbrio entre funções urbanas
- **Classificação TOD** automática por estação: *Excelente* · *Bom* · *Moderado* · *Em Transição* · *Monofuncional*
- **Rácio de autossuficiência**: relação entre empregos estimados e população residente — valores próximos de 0.5 indicam equilíbrio entre residência e emprego
- **Layer de POI** no mapa: visualização opcional dos pontos de interesse geolocalizados, coloridos por categoria
- **Δ Mix de usos** no tab Cenário Urbano: estima a variação do índice H ao aplicar alterações de densidade ou novas urbanizações

### Cenário urbano (TOD)

- Visualização **coroplética** de todas as subsecções estatísticas (BGRI) por densidade populacional (hab/ha)
- **Painel flutuante de edição**: clicar numa BGRI abre um painel sobreposto ao mapa com densidade atual, tipo de uso do solo e cobertura edificável; fecha com ESC ou clique fora
- Aplicar **overrides de densidade** por subsecção; reverter para valores originais dos censos
- **Novas urbanizações**: desenhar um polígono no mapa, definir tipo de densidade e cobertura do solo, obter estimativa de população instantânea; nome editável inline
- As novas urbanizações **substituem** a população das BGRI que cobrem (sem dupla contagem)
- Resumo do cenário: população base (censos) vs. projetada vs. delta
- Recalcular catchment com as alterações do cenário ativas

### Gestão de projetos

- **Guardar projeto**: exporta um ficheiro JSON com grupos, estações, todas as alterações de densidade por BGRI e urbanizações desenhadas
- **Carregar projeto**: restaura o estado completo, incluindo o cenário urbano e as isócronas

## Como usar o mix de usos para localizar estações

A análise de empregos e mix funcional é diretamente útil para decisões de localização de paragens em três dimensões:

### 1. Maximizar a procura potencial de transporte

Estações bem posicionadas captam tanto **residentes** (viagens de casa para o trabalho) como **empregados** (viagens do trabalho para outros destinos). Um rácio de autossuficiência próximo de **0.4–0.6** indica que a estação serve simultaneamente origens e destinos — o perfil ideal para uma paragem com procura bidirecional estável ao longo do dia.

> Estações com autossuficiência < 0.2 servem principalmente dormitórios — elevada procura nas horas de ponta matinais mas fraca no restante dia. Estações > 0.8 servem principalmente zonas de emprego — o padrão inverso.

### 2. Gerar procura em múltiplos períodos do dia

O índice H de Shannon captura a variedade funcional da área de captação. Uma área com **H ≥ 0.65** (TOD Bom ou Excelente) combina residência, emprego, comércio, serviços e equipamentos — o que gera viagens distribuídas ao longo de todo o dia e não apenas nas horas de ponta. Isto traduz-se em:
- Taxa de ocupação mais uniforme nos veículos
- Menor necessidade de sobredimensionar a capacidade para as horas de ponta
- Melhor viabilidade económica de linhas de baixa frequência

### 3. Comparar localizações alternativas com o cenário urbano

O **Δ H** do tab *Cenário Urbano* permite comparar o impacto de intervenções urbanísticas no mix funcional:

1. Desenhar uma nova urbanização residencial próxima de uma estação candidata.
2. Verificar se o Δ H sobe ou desce — uma urbanização exclusivamente residencial numa área já monofuncional **diminui** o H.
3. Comparar alternativas: uma estação posicionada ligeiramente mais perto de uma centralidade de serviços pode ter um H substancialmente mais elevado com a mesma proposta de urbanização.

### 4. Identificar zonas de investimento prioritário

Estações com **classificação *Em Transição* ou *Monofuncional*** e **autossuficiência < 0.3** são candidatas a intervenção de usos mistos nos seus arredores — a localização da estação pode ser um catalisador para atrair comércio e serviços de proximidade. Neste caso, o Δ H do cenário de urbanização permite quantificar o benefício esperado de incluir pisos não-residenciais na nova urbanização.

---

## Stack

| Camada | Tecnologias |
|---|---|
| Backend | Python, Flask, GeoPandas, Shapely, Requests |
| Frontend | HTML/CSS/JS vanilla, Leaflet 1.9.4, Turf.js 6.5.0, Leaflet.draw 1.0.4 |
| Dados | BGRI 2021 (Instituto Nacional de Estatística), OpenStreetMap via OpenRouteService |
| Isócronas | OpenRouteService Isochrones API (foot-walking) |

## Instalação

1. **Criar ambiente virtual e instalar dependências:**
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

2. **Configurar a chave da API OpenRouteService:**

   Obter chave gratuita em https://openrouteservice.org/dev/#/signup

   ```bash
   cp .env.example .env
   # editar .env e substituir o valor de ORS_API_KEY
   ```

   > O ficheiro `.env` está no `.gitignore` e não deve ser commitado.

3. **Processar os dados de censos:**
```bash
python3 process_data.py
```
   Lê `BGRI2021_0705/BGRI2021_0705.gpkg` e gera `data/census_data.geojson` e `data/metadata.json`.

4. **Iniciar o servidor:**
```bash
source venv/bin/activate && python3 server.py
```
   Abrir em `http://localhost:5000`

## Estrutura do projeto

```
.
├── BGRI2021_0705/          # Dados de censos originais (.gpkg)
├── data/                   # Dados processados (GeoJSON + metadados)
├── static/
│   ├── index.html          # Estrutura da interface
│   ├── style.css           # Estilos
│   └── app.js              # Lógica do cliente (Leaflet, estado, API calls)
├── server.py               # API Flask (isócronas, cálculo de população, export)
├── process_data.py         # Pré-processamento dos dados BGRI
├── requirements.txt
└── README.md
```

- **Frontend:** HTML5, CSS3, JavaScript (vanilla)
- **Mapa:** Leaflet.js
- **Cálculos geográficos:** Turf.js
- **Isócronas:** OpenRouteService API

## Dados

Os dados de censos são do INE (Instituto Nacional de Estatística) de 2021, por arruamento (BGRI - Blocos Geográficos de Referência de Informação).

A coluna utilizada para população é `N_INDIVIDUOS` (número de indivíduos residentes).
