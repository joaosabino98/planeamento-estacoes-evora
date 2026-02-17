#!/bin/bash
# Script para iniciar o servidor

# Ativar ambiente virtual
source venv/bin/activate

# Verificar se os dados foram processados
if [ ! -f "data/census_data.geojson" ]; then
    echo "Processando dados de censos..."
    python3 process_data.py
fi

# Iniciar servidor
echo "Iniciando servidor em http://localhost:5000"
python3 server.py

