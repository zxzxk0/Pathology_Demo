from pathlib import Path
import pandas as pd
import numpy as np
import json

BASE = Path(r"C:\Users\zxzxk\Downloads")

# 파일명은 실제 이름에 맞게 바꿔줘
POLY_CSV = BASE / "cell_polygons(in).csv"
GENE_CSV = BASE / "GeneExpression(in).csv"

OUT_DIR = BASE / "PreSCCT1_gene_expression"
OUT_DIR.mkdir(exist_ok=True)

POLY_JSON = OUT_DIR / "cell_polygons.json"
GENE_JSON = OUT_DIR / "gene_expression.json"

print("Loading CSV files...")

poly = pd.read_csv(POLY_CSV)
gene = pd.read_csv(GENE_CSV)

print("\n=== INPUT SUMMARY ===")
print(f"Polygon rows: {len(poly):,}")
print(f"Unique cells: {poly['cell'].nunique():,}")
print(f"Cell types: {poly['cell_type'].nunique():,}")
print(f"Genes: {len(gene):,}")

required = {"cell", "x_he_px", "y_he_px", "cell_type"}
missing = required - set(poly.columns)

if missing:
    raise ValueError(f"Missing polygon columns: {missing}")

if "gene" not in gene.columns:
    raise ValueError("GeneExpression.csv must contain a 'gene' column")

# -------------------------------------------------------
# Cell type mapping
# -------------------------------------------------------

cell_types = sorted(poly["cell_type"].dropna().astype(str).unique())

missing_types = [x for x in cell_types if x not in gene.columns]

if missing_types:
    print("\nWARNING:")
    print("These polygon cell types are missing from GeneExpression.csv:")
    for x in missing_types:
        print(" -", x)

type_to_idx = {
    cell_type: i
    for i, cell_type in enumerate(cell_types)
}

# -------------------------------------------------------
# Polygon JSON
# -------------------------------------------------------

print("\nBuilding polygon JSON...")

cells = []

for i, (cell_id, group) in enumerate(poly.groupby("cell", sort=False), 1):

    cell_type = str(group["cell_type"].iloc[0])

    xs = group["x_he_px"].to_numpy(dtype=float)
    ys = group["y_he_px"].to_numpy(dtype=float)

    coords = []

    for x, y in zip(xs, ys):
        coords.extend([
            round(float(x), 2),
            round(float(y), 2)
        ])

    bbox = [
        round(float(xs.min()), 2),
        round(float(ys.min()), 2),
        round(float(xs.max()), 2),
        round(float(ys.max()), 2),
    ]

    cells.append([
        str(cell_id),
        type_to_idx[cell_type],
        coords,
        bbox
    ])

    if i % 10000 == 0:
        print(f"Processed {i:,} cells")

polygon_payload = {
    "version": 1,
    "slide_id": "PreSCCT1_HE.ome",
    "coordinate_space": "he_level0_px",
    "types": cell_types,
    "cells": cells
}

print("Writing polygon JSON...")

with open(POLY_JSON, "w", encoding="utf-8") as f:
    json.dump(
        polygon_payload,
        f,
        ensure_ascii=False,
        separators=(",", ":")
    )

# -------------------------------------------------------
# Gene-expression JSON
# -------------------------------------------------------

print("\nBuilding gene-expression JSON...")

genes = {}

for _, row in gene.iterrows():

    gene_name = str(row["gene"])

    values = []

    for cell_type in cell_types:

        if cell_type not in gene.columns:
            values.append(None)
            continue

        value = row[cell_type]

        if pd.isna(value):
            values.append(None)
        else:
            values.append(round(float(value), 6))

    genes[gene_name] = values

expression_payload = {
    "version": 1,
    "slide_id": "PreSCCT1_HE.ome",
    "types": cell_types,
    "genes": genes
}

print("Writing gene-expression JSON...")

with open(GENE_JSON, "w", encoding="utf-8") as f:
    json.dump(
        expression_payload,
        f,
        ensure_ascii=False,
        separators=(",", ":")
    )

# -------------------------------------------------------
# Final summary
# -------------------------------------------------------

print("\n=== DONE ===")
print(f"Unique cells exported: {len(cells):,}")
print(f"Genes exported: {len(genes):,}")
print(f"Cell types: {len(cell_types):,}")

print("\nCreated:")
print(POLY_JSON)
print(GENE_JSON)

print("\nFile sizes:")
print(f"cell_polygons.json: {POLY_JSON.stat().st_size / 1024 / 1024:.2f} MB")
print(f"gene_expression.json: {GENE_JSON.stat().st_size / 1024 / 1024:.2f} MB")