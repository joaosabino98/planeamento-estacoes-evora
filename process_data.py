#!/usr/bin/env python3
"""
Script para processar dados do GeoPackage e converter para GeoJSON
"""
import geopandas as gpd
import json
import os

def process_census_data():
    """Processa o GeoPackage e converte para GeoJSON"""
    input_file = "BGRI2021_0705/BGRI2021_0705.gpkg"
    output_file = "data/census_data.geojson"
    
    # Criar diretório de dados se não existir
    os.makedirs("data", exist_ok=True)
    
    print(f"Lendo arquivo: {input_file}")
    gdf = gpd.read_file(input_file)
    
    # Verificar colunas disponíveis
    print(f"\nColunas disponíveis: {gdf.columns.tolist()}")
    print(f"CRS: {gdf.crs}")
    print(f"Shape: {gdf.shape}")
    
    # Converter para WGS84 (EPSG:4326) se necessário
    if gdf.crs != "EPSG:4326":
        print(f"Convertendo de {gdf.crs} para EPSG:4326...")
        gdf = gdf.to_crs("EPSG:4326")
    
    # Procurar coluna de população
    # Prioridade: N_INDIVIDUOS (número de indivíduos/residentes)
    if 'N_INDIVIDUOS' in gdf.columns:
        pop_column = 'N_INDIVIDUOS'
        print(f"\nColuna de população encontrada: {pop_column}")
    else:
        # Procurar por outras colunas que possam conter população
        pop_columns = [col for col in gdf.columns if 'INDIVIDUOS' in col.upper() or 'POP' in col.upper() or 'HABITANTES' in col.upper() or 'RESIDENTES' in col.upper()]
        
        if pop_columns:
            pop_column = pop_columns[0]
            print(f"\nColuna de população encontrada: {pop_column}")
        else:
            # Se não encontrar, usar primeira coluna numérica (não ideal)
            numeric_cols = gdf.select_dtypes(include=['int64', 'float64']).columns.tolist()
            # Remover colunas de geometria e IDs
            numeric_cols = [col for col in numeric_cols if 'SHAPE' not in col and 'OBJECTID' not in col and 'ID' not in col]
            if numeric_cols:
                pop_column = numeric_cols[0]
                print(f"\nAVISO: Usando '{pop_column}' como população (pode não ser correto!)")
            else:
                pop_column = None
                print("\nAVISO: Nenhuma coluna de população encontrada!")
    
    # Salvar como GeoJSON
    print(f"\nSalvando em: {output_file}")
    gdf.to_file(output_file, driver="GeoJSON")
    
    # Criar um arquivo de metadados
    metadata = {
        "pop_column": pop_column,
        "total_features": len(gdf),
        "bounds": {
            "minx": float(gdf.total_bounds[0]),
            "miny": float(gdf.total_bounds[1]),
            "maxx": float(gdf.total_bounds[2]),
            "maxy": float(gdf.total_bounds[3])
        },
        "columns": gdf.columns.tolist()
    }
    
    with open("data/metadata.json", "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)
    
    print("\nProcessamento concluído!")
    print(f"Total de features: {len(gdf)}")
    if pop_column:
        total_pop = gdf[pop_column].sum() if pop_column in gdf.columns else 0
        print(f"População total: {total_pop:,.0f}")
    
    return pop_column

if __name__ == "__main__":
    process_census_data()

