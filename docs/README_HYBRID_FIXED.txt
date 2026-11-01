Critical HYBRID fix:
- loadSlide now passes the full slide object to loadHeDziMeta().
- Previously only slide.id was passed, so heOriginalW/heOriginalH stayed null.
- That caused buildGeneStaticOverlay() to return null without an exception,
  leaving Gene Expression mode as a blank white panel.
- loadHeDziMeta is now also robust to either a slide object or an ID string.
- Added console diagnostics for H&E dimensions and successful static overlay build.
- 191,704 cells / 101 types / 6,175 genes unchanged.
- viewer.js passed node --check.
