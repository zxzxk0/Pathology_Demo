Pathogene Gene Expression Demo - modified files

Replace under your GitHub Pages docs/ folder:
  index.html
  viewer.js
  slides.json

Copy this folder under docs/data/:
  data/gene_expression/PreSCCT1_HE.ome/
    cell_polygons.json
    gene_expression.json

Implementation:
- Existing Cell Type view is unchanged.
- Gene Expression mode is enabled only for slides with gene_expression metadata.
- PreSCCT1_HE.ome loads 37,330 cell polygons and 6,175 genes.
- Polygons are colored by the expression value associated with their cell_type.
- Scale uses 2nd / 50th / 98th percentiles for blue / white / red.
- Polygon coordinates are treated as H&E level-0 pixel coordinates.
- Only polygons intersecting the current viewport are drawn.

Validation performed:
- JSON files parse successfully.
- Required HTML/JS hooks are present.
- This is structural validation; browser rendering on GitHub Pages has not been end-to-end tested here.

Integrated overlay revision:
- The gene-expression canvas is no longer a sibling HTML layer over viewerRight.
- It is created dynamically and attached with OpenSeadragon.addOverlay().
- The overlay occupies the H&E world rectangle (0,0,1,heH/heW), the same frame used by registered CosMx.
- OpenSeadragon now moves/scales the overlay together with the image during pan/zoom.
- Polygon paths are cached by cell type; changing genes only recolors 49 cached paths.
- Bright cell outlines were removed to reduce the 'floating transparent sheet' appearance.

Alignment debug revision:
- Toggle Alignment Debug ON.
- Adjust overlay opacity.
- Toggle Fill, Outline, Centroids, and Selected ID.
- Click the right viewer to inspect the nearest polygon.
- Sidebar reports cell ID, cell type, expression, centroid H&E px,
  clicked H&E px, and nearest-centroid distance.

Douglass feedback revision:
- Gene Expression mode now hides the colored CosMx base image and uses a white
  right-viewer background so only the blue-white-red expression layer is shown.
- The gene picker no longer truncates at ~60 results. All 6,175 loaded genes
  are available in the scroll list, and the search box filters the full catalog.
- The current supplied cell_polygons.csv contains 37,330 unique cell IDs, and
  the demo displays all 37,330 available polygons. The source CSV has 1,048,575
  data rows, which is exactly one less than Excel's 1,048,576-row worksheet
  limit when the header is counted; the missing ~200k polygons cannot be
  reconstructed safely from this file.
