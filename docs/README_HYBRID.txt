HYBRID gene-expression renderer
- Base overlay: one 4096px full-slide render per gene / alignment change.
- No redraw on every pan/zoom animation frame.
- Deep zoom: after animation finishes, visible cells are redrawn sharply in the viewport.
- Keeps 191,704 cells, 101 cell types, and 6,175 genes.
- viewer.js passed node --check.
