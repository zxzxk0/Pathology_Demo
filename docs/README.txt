Files in this package:
- index.html
- viewer.js
- data/gene_expression/PreSCCT1_HE.ome/cell_polygons.json

Corrected polygon dataset: 191,704 unique cells, 101 cell types.
viewer.js uses a viewport-sized high-resolution Canvas with spatial-grid filtering instead of
a fixed 2048px full-slide raster for the gene-expression overlay.
Validation performed: JSON parse/structure and node --check for viewer.js.
Browser/runtime visual behavior was not executed here.
