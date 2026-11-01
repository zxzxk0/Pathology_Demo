FIXED3 changes:
- 191,704 corrected cell polygons / 101 polygon cell types.
- Rebuilt gene_expression.json to the same 101 type names using GeneExpression(in)(1).csv.
- Renderer maps polygon type -> expression type by name (not array position).
- Fixed onImgError('he'/'cosmx') handler signature.
- Removed intentional dzi_meta.json request; H&E dimensions come from the actual .dzi XML.
- Added one-time viewport diagnostics in browser console.
- viewer.js passed node --check.
