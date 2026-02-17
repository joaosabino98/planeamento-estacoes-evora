# Planeamento de Estações de Transporte Público - Évora

Ferramenta web interativa para planeamento de estações de transporte público em Évora, com visualização de isócronas reais e cálculo de população residente.

## Funcionalidades

- 🗺️ Mapa interativo centrado em Évora
- 📍 Adicionar estações clicando no mapa
- 🖱️ Arrastar estações para reposicionar
- ⏱️ Isócronas reais de 5 e 10 minutos a pé (baseadas em caminhos reais, não círculos)
- 👥 Cálculo de população residente dentro das áreas de captação
- 📊 Estatísticas em tempo real no menu lateral
- 🔄 Atualização automática ao mover estações

## Instalação

1. **Instalar dependências Python:**
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

2. **Configurar a API Key do OpenRouteService:**

   A aplicação utiliza a API do [OpenRouteService](https://openrouteservice.org/) para calcular isócronas. É necessário obter uma chave de API gratuita:

   - Criar conta em: https://openrouteservice.org/dev/#/signup
   - Copiar a API Key gerada
   - Criar o ficheiro `.env` a partir do template:
     ```bash
     cp .env.example .env
     ```
   - Editar o ficheiro `.env` e substituir `a_tua_api_key_aqui` pela tua chave:
     ```
     ORS_API_KEY=a_tua_chave_real_aqui
     ```

   > ⚠️ O ficheiro `.env` está no `.gitignore` e **não deve ser commitado** no repositório.

3. **Processar dados de censos:**
```bash
python3 process_data.py
```

Isso irá:
- Ler o arquivo `BGRI2021_0705/BGRI2021_0705.gpkg`
- Converter para GeoJSON em `data/census_data.geojson`
- Criar metadados em `data/metadata.json`

## Uso

1. **Iniciar o servidor:**
```bash
source venv/bin/activate
python3 server.py
```

2. **Abrir no navegador:**
```
http://localhost:5000
```

> 💡 Se a `ORS_API_KEY` não estiver definida, a aplicação mostrará um aviso no terminal e as isócronas usarão círculos como fallback.

## Como usar

1. **Adicionar estação:** Clique em qualquer ponto do mapa
2. **Mover estação:** Arraste o marcador para reposicionar
3. **Remover estação:** Clique no botão "×" na sidebar
4. **Limpar todas:** Clique no botão "Limpar Todas" no mapa

## Áreas de Captação

- **Área Primária (5 min):** População dentro da área acessível em 5 minutos a pé
- **Área Secundária (10 min):** População dentro da área acessível em 10 minutos a pé (excluindo a área primária)

As isócronas são calculadas usando a API do OpenRouteService, que considera os caminhos reais a pé baseados na rede viária do OpenStreetMap. A velocidade a pé considerada é de aproximadamente 5 km/h (~1.39 m/s).

Quando as isócronas de diferentes estações se sobrepõem, o cálculo de população **evita contagem dupla** — cada subsecção estatística é contabilizada apenas uma vez, mesmo que esteja abrangida por múltiplas estações. Assim, a população total apresentada reflete o número real de residentes cobertos pela rede de estações.

Se a API não estiver disponível, o sistema usa círculos como fallback.

## Estrutura do Projeto

```
.
├── BGRI2021_0705/          # Dados de censos originais
├── data/                    # Dados processados (GeoJSON)
├── static/                  # Frontend (HTML, CSS, JS)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── server.py               # Servidor Flask
├── process_data.py         # Script de processamento
├── requirements.txt        # Dependências Python
└── README.md
```

## Tecnologias

- **Backend:** Python, Flask, GeoPandas, Shapely, Requests
- **Frontend:** HTML5, CSS3, JavaScript (vanilla)
- **Mapa:** Leaflet.js
- **Cálculos geográficos:** Turf.js
- **Isócronas:** OpenRouteService API

## Dados

Os dados de censos são do INE (Instituto Nacional de Estatística) de 2021, por arruamento (BGRI - Blocos Geográficos de Referência de Informação).

A coluna utilizada para população é `N_INDIVIDUOS` (número de indivíduos residentes).
