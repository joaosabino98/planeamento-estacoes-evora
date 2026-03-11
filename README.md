# Mobilidade e Território — Análise de Cobertura Pedonal das Paragens — Évora

Ferramenta web interativa para avaliar a cobertura pedonal de redes de transporte público em Évora. Permite colocar paragens/estações no mapa, calcular isócronas reais a pé de 5 e 10 minutos, estimar a população e o emprego abrangidos por cada área de captação, e simular cenários de densificação urbana para comparar alternativas de localização.

<img width="1317" height="800" alt="Screenshot da ferramenta com a rede TREVO importada" src="https://github.com/user-attachments/assets/8d5e2994-7795-4fce-aa4e-806928438ced" />

## Funcionalidades

### Planeamento de paragens / estações

- Adicionar paragens clicando no mapa; arrastar para reposicionar; remover com ×
- Organização em **grupos com nome e cor** personalizáveis; visibilidade por grupo
- **Isócronas reais** de 5 e 10 minutos a pé via OpenRouteService (fallback para círculo quando a API não está disponível)
- Cálculo de **população residente** nas áreas de captação, sem dupla contagem entre estações sobrepostas
- Estatísticas por grupo (5 min / 10 min / total) e totais globais em tempo real
- **Cobertura da rede** no menu lateral: percentagem de população e empregos da cidade abrangidos pela rede proposta face aos totais municipais (53 577 hab. / 23 674 empregos, fonte CME)
- Undo/redo com Ctrl+Z / Ctrl+Shift+Z

### Análise de Empregos e Mix de Usos

- **Estimativa de emprego** por área de captação de 5 minutos, calculada automaticamente após colocar estações com isócronas válidas
- Dados recolhidos em tempo real via **API Overpass (OpenStreetMap)** — não requer chave de API
- Decomposição em **6 categorias funcionais**: Comércio, Serviços, Educação/Saúde, Cultura/Lazer, Restauração e Indústria
- **Índice H de Shannon normalizado** (0–1): mede a diversidade do mix de usos na área de captação — um valor elevado indica maior equilíbrio entre funções urbanas
- **Perfil funcional** automático por estação, com base no índice H e no rácio de empregos: *Centralidade multifuncional* · *Misto equilibrado* · *Nó de emprego* · *Misto desequilibrado* · *Dormitório*
- **Rácio de autossuficiência**: relação entre empregos estimados e população residente — valores próximos de 0.5 indicam equilíbrio entre residência e emprego
- **Layer de POI** no mapa: visualização opcional dos pontos de interesse geolocalizados, coloridos por categoria
- **Δ Mix de usos** no tab Cenário Urbano: estima a variação do índice H ao aplicar alterações de densidade ou novas urbanizações

### Cenário urbano

- Visualização **coroplética** de todas as subsecções estatísticas (BGRI) por densidade populacional (hab/ha)
- **Painel flutuante de edição**: clicar numa BGRI abre um painel sobreposto ao mapa com densidade atual, tipo de uso do solo e cobertura edificável; fecha com ESC ou clique fora
- Aplicar **overrides de densidade** por subsecção; reverter para valores originais dos censos
- **Novas urbanizações**: desenhar um polígono no mapa, definir tipo de densidade e cobertura do solo, obter estimativa de população instantânea; nome editável inline
- As novas urbanizações **substituem** a população das BGRI que cobrem (sem dupla contagem)
- Resumo do cenário: população base (censos) vs. projetada vs. delta
- Recalcular catchment com as alterações do cenário ativas
- **Zonas com menor cobertura de paragens**: secção no fundo do tab com a lista de subsecções (BGRI) com ≥ 50 hab. não cobertas por qualquer isócrona de 10 min; clique numa zona para a destacar no mapa (laranja) e centrar a vista; clique novamente para desselecionar

### Gestão de projetos

- **Guardar JSON**: exporta um ficheiro JSON com grupos, estações, todas as alterações de densidade por BGRI e urbanizações desenhadas
- **Carregar JSON**: restaura o estado completo, incluindo o cenário urbano e as isócronas
- **Carregar GTFS**: carrega um ficheiro `.zip` com dados GTFS — as paragens são importadas como estações organizadas por linha; substitui os grupos e estações existentes; as isócronas são calculadas sequencialmente para evitar erros de rate-limit

### Análise de sobreposição de isócronas

- Após o cálculo das isócronas, a aplicação detecta automaticamente pares de estações cujas áreas de captação de 5 minutos se sobrepõem
- Cada cartão de estação apresenta **badges de sobreposição** indicando a percentagem de área partilhada e a população potencialmente duplicada
- Dois níveis de alerta: **aviso** (⚠️ sobreposição ≥ 10%) e **perigo** (⛔ sobreposição ≥ 40%)
- Útil para identificar paragens redundantes ou desnecessariamente próximas numa rede

### Relatório de cobertura

- **Exportar relatório** gera um documento HTML imprimível (PDF via impressão do browser) com mapa, resumo global e tabela completa por grupo
- O mapa no relatório é capturado em formato **16:9** (1 120 × 630 px) com todas as paragens visíveis e sem isócronas para evitar artefactos gráficos
- Inclui população abrangida (5 e 10 min, sem dupla contagem), empregos estimados, índice H, perfil funcional, rácio de autossuficiência e badges de sobreposição por estação
- **Cobertura relativa da rede**: dois KPIs adicionais mostram a percentagem de população e empregos da cidade cobertos pela rede proposta (face aos totais municipais)
- **Zonas com menor cobertura pedonal**: tabela no fim do relatório com as subsecções estatísticas (BGRI) de população ≥ 50 habitantes não abrangidas por qualquer isócrona de 10 minutos, ordenadas por população descrescente
- A **dupla contagem de população** entre estações com isócronas sobrepostas é eliminada usando a união das isócronas no servidor; os valores globais reflectem a população única abrangida pela rede
- Os **empregos** são desduplicados por `osm_id` quando várias estações captam os mesmos POIs

### Carregamento com indicador de progresso

- Ao importar um ficheiro GTFS ou carregar um projeto JSON, um **overlay de carregamento** cobre o painel «Estações» e bloqueia o scroll enquanto as isócronas são calculadas e a população e empregos contabilizados
- O overlay mostra três fases sequenciais: `A calcular isócronas… X / N` → `A calcular população…` → `A calcular empregos…`, desaparecendo apenas quando todos os cálculos terminam
- Se o cálculo de empregos falhar, o overlay apresenta um **estado de erro** com ícone ⚠️, mensagem descritiva, botão × para fechar e botão **Tentar novamente** que re-executa o pedido
- Isócronas servidas a partir da cache local não introduzem atraso entre pedidos (apenas chamadas reais à API ORS têm o intervalo de 350 ms)

## Como usar o mix de usos para localizar estações

A análise de empregos e mix funcional é diretamente útil para decisões de localização de paragens em três dimensões:

### 1. Maximizar a procura potencial de transporte

Estações bem posicionadas captam tanto **residentes** (viagens de casa para o trabalho) como **empregados** (viagens do trabalho para outros destinos). Um rácio de autossuficiência próximo de **0.4–0.6** indica que a estação serve simultaneamente origens e destinos — o perfil ideal para uma paragem com procura bidirecional estável ao longo do dia.

> Estações com autossuficiência < 0.2 servem principalmente dormitórios — elevada procura nas horas de ponta matinais mas fraca no restante dia. Estações > 0.8 servem principalmente zonas de emprego — o padrão inverso.

### 2. Gerar procura em múltiplos períodos do dia

O índice H de Shannon captura a variedade funcional da área de captação. Uma área com **H ≥ 0.6** (perfil *Centralidade multifuncional* ou *Misto equilibrado*) combina residência, emprego, comércio, serviços e equipamentos — o que gera viagens distribuídas ao longo de todo o dia e não apenas nas horas de ponta. Isto traduz-se em:
- Taxa de ocupação mais uniforme nos veículos
- Menor necessidade de sobredimensionar a capacidade para as horas de ponta
- Melhor viabilidade económica de linhas de baixa frequência

### 3. Comparar localizações alternativas com o cenário urbano

O **Δ H** do tab *Cenário Urbano* permite comparar o impacto de intervenções urbanísticas no mix funcional:

1. Desenhar uma nova urbanização residencial próxima de uma estação candidata.
2. Verificar se o Δ H sobe ou desce — uma urbanização exclusivamente residencial numa área já monofuncional **diminui** o H.
3. Comparar alternativas: uma estação posicionada ligeiramente mais perto de uma centralidade de serviços pode ter um H substancialmente mais elevado com a mesma proposta de urbanização.

### 4. Identificar zonas de investimento prioritário

Estações com perfil *Misto desequilibrado* ou *Dormitório* e **autossuficiência < 0.3** são candidatas a intervenção de usos mistos nos seus arredores — a localização da estação pode ser um catalisador para atrair comércio e serviços de proximidade. Neste caso, o Δ H do cenário de urbanização permite quantificar o benefício esperado de incluir pisos não-residenciais na nova urbanização.

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
