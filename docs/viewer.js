/**
 * SVS Dual Viewer - H&E + CosMx Panels (GitHub Pages DEMO version)
 * Left: H&E with annotations (polygon drawing enabled)
 * Right: CosMx only (no H&E background)
 *
 * DEMO MODE: Flask API replaced with static slides.json (generate_manifest.py)
 * Annotations are kept in-memory + localStorage (no backend to save to).
 */

// 로컬(file://, localhost) 또는 GitHub Pages 양쪽 지원
const _SLIDES_JSON_URLS = ['./slides.json', '/Pathology_Demo/slides.json'];
let _SLIDES_CACHE = null;

async function _loadSlidesJSON() {
  if (_SLIDES_CACHE) return _SLIDES_CACHE;
  for (const url of _SLIDES_JSON_URLS) {
    try {
      const res = await fetch(url);
      if (res.ok) { _SLIDES_CACHE = await res.json(); return _SLIDES_CACHE; }
    } catch (e) {}
  }
  throw new Error('slides.json not found. Run generate_manifest.py first.');
}

// Dual viewers
let viewerLeft = null;
let viewerRight = null;
let annotorious = null;

// State
let currentSlideId = null;
let currentLabel = 'tumor';
let slideDziMap = {};
let slideCosmxMap = {};   // DEMO: slide_id -> cosmx info object from slides.json
let cosmxVisible = true;

// cosmxData: { dziUrl, tiledImage, transform }
let cosmxData = null;

// Prevent sync loops
let isSyncing = false;

const LABEL_COLORS = {
  tumor: { stroke: '#e74c3c', fill: 'rgba(231, 76, 60, 0.2)' },
  stroma: { stroke: '#3498db', fill: 'rgba(52, 152, 219, 0.2)' },
  lymphocyte: { stroke: '#27ae60', fill: 'rgba(39, 174, 96, 0.2)' },
  other: { stroke: '#f39c12', fill: 'rgba(243, 156, 18, 0.2)' }
};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('🚀 Starting dual viewer (DEMO mode)...');

  initDualViewers();
  initAnnotorious();
  setupSync();
  setupUI();

  await loadSlides();

  console.log('✅ Ready - Left: H&E, Right: CosMx only');
});

function initDualViewers() {
  viewerLeft = OpenSeadragon({
    id: 'viewerLeft',
    prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
    showNavigator: true,
    navigatorPosition: 'TOP_RIGHT',
    gestureSettingsMouse: {
      scrollToZoom: true,
      clickToZoom: false,
      dragToPan: false,
      pinchToZoom: true
    }
  });

  viewerRight = OpenSeadragon({
    id: 'viewerRight',
    prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
    showNavigator: true,
    navigatorPosition: 'TOP_RIGHT',
    gestureSettingsMouse: {
      scrollToZoom: true,
      clickToZoom: false,
      dragToPan: false,
      pinchToZoom: true
    }
  });

  console.log('✅ Dual viewers initialized');
}

function initAnnotorious() {
  const customFormatter = (anno) => {
    const label = anno.body?.find(b => b.purpose === 'tagging')?.value || 'other';
    const style = LABEL_COLORS[label] || LABEL_COLORS.other;
    return { style: `stroke:${style.stroke}; stroke-width:2; fill:${style.fill};` };
  };

  annotorious = OpenSeadragon.Annotorious(viewerLeft, {
    allowEmpty: true,
    drawOnSingleClick: false,
    disableEditor: true,
    formatter: customFormatter
  });

  annotorious.setDrawingTool('polygon');
  annotorious.setDrawingEnabled(false);
  console.log('💡 Click Polygon/Rectangle to draw (LEFT panel only)');

  annotorious.on('createAnnotation', (anno) => {
    const labeled = {
      ...anno,
      body: [{ type: 'TextualBody', purpose: 'tagging', value: currentLabel }]
    };

    annotorious.removeAnnotation(anno.id);
    
    setTimeout(() => {
      annotorious.addAnnotation(labeled);
      updateCount();
      console.log('✅ Created:', currentLabel);
      
      setTimeout(() => {
        const allAnnos = annotorious.getAnnotations();
        annotorious.setAnnotations(allAnnos);
      }, 50);
    }, 10);

    annotorious.setDrawingEnabled(false);
    console.log('💡 Click Polygon/Rectangle to draw again');
  });
}

// ============================================================================
// SYNCHRONIZATION (Delta-based: move together, not snap to position)
// ============================================================================

let syncEnabled = true;  // Sync toggle state
let lastLeftCenter = null;
let lastLeftZoom = null;

function setupSync() {
  // Initialize last position when left panel opens
  viewerLeft.addHandler('open', () => {
    lastLeftCenter = viewerLeft.viewport.getCenter();
    lastLeftZoom = viewerLeft.viewport.getZoom();
  });

  // Left pan → Right moves by same delta
  viewerLeft.addHandler('pan', (event) => {
    if (!syncEnabled || isSyncing) return;
    if (!viewerRight.viewport) return;
    
    isSyncing = true;
    try {
      const currentCenter = viewerLeft.viewport.getCenter();
      
      if (lastLeftCenter) {
        // Calculate delta (how much left panel moved)
        const dx = currentCenter.x - lastLeftCenter.x;
        const dy = currentCenter.y - lastLeftCenter.y;
        
        // Apply same delta to right panel
        const rightCenter = viewerRight.viewport.getCenter();
        if (rightCenter) {
          viewerRight.viewport.panTo(
            new OpenSeadragon.Point(rightCenter.x + dx, rightCenter.y + dy),
            true  // immediate
          );
        }
      }
      
      lastLeftCenter = currentCenter.clone();
    } finally {
      isSyncing = false;
    }
  });

  // Left zoom → Right zooms by same ratio
  viewerLeft.addHandler('zoom', (event) => {
    if (!syncEnabled || isSyncing) return;
    if (!viewerRight.viewport) return;
    
    isSyncing = true;
    try {
      const currentZoom = viewerLeft.viewport.getZoom();
      
      if (lastLeftZoom && lastLeftZoom > 0) {
        // Calculate zoom ratio
        const zoomRatio = currentZoom / lastLeftZoom;
        
        // Apply same ratio to right panel
        const rightZoom = viewerRight.viewport.getZoom();
        if (rightZoom) {
          viewerRight.viewport.zoomTo(rightZoom * zoomRatio, null, true);
        }
      }
      
      lastLeftZoom = currentZoom;
    } finally {
      isSyncing = false;
    }
  });

  // Right panel: independent movement (no sync back to left)
  // This allows manual adjustment of CosMx position

  console.log('✅ Delta-based sync enabled (move together)');
}

// Toggle sync on/off
function toggleSync() {
  syncEnabled = !syncEnabled;
  
  // Update last position when re-enabling sync
  if (syncEnabled && viewerLeft.viewport) {
    lastLeftCenter = viewerLeft.viewport.getCenter();
    lastLeftZoom = viewerLeft.viewport.getZoom();
  }
  
  const btn = document.getElementById('syncToggle');
  if (btn) {
    btn.textContent = syncEnabled ? 'Sync: ON' : 'Sync: OFF';
    btn.classList.toggle('active', syncEnabled);
  }
  
  console.log('🔄 Sync:', syncEnabled ? 'ON' : 'OFF');
  
  // Update status
  const status = document.getElementById('syncStatus');
  if (status) {
    status.textContent = syncEnabled ? '🔄 Moving Together' : '🔓 Right Panel Independent';
  }
}

// Re-sync: Reset tracking (doesn't snap position)
function resyncPanels() {
  if (viewerLeft.viewport) {
    lastLeftCenter = viewerLeft.viewport.getCenter();
    lastLeftZoom = viewerLeft.viewport.getZoom();
  }
  console.log('📍 Sync position reset');
}

// Save current CosMx position (for manual alignment)
function saveCosMxPosition() {
  if (!cosmxData?.tiledImage) {
    console.error('No CosMx layer loaded');
    return null;
  }
  
  const item = cosmxData.tiledImage;
  const bounds = item.getBounds();
  
  // 왼쪽 H&E 기준 정보
  const heLayer = viewerLeft.world.getItemAt(0);
  let normX = bounds.x;
  let normY = bounds.y;
  
  if (heLayer) {
    const heBounds = heLayer.getBounds();
    normX = bounds.x / heBounds.width;
    normY = bounds.y / heBounds.height;
  }
  
  // Use UI state (not effective values)
  const position = {
    rotation: cosmxTransformState.rotation,
    flipX: cosmxTransformState.flipX,
    flipY: cosmxTransformState.flipY,
    translateX: normX,
    translateY: normY,
    scale: cosmxTransformState.scale
  };
  
  const output = {
    version: "4.0",
    slide_id: currentSlideId,
    method: "manual_adjustment",
    transform: position
  };
  
  console.log('═'.repeat(60));
  console.log('📍 SAVE THIS TO transform.json:');
  console.log('═'.repeat(60));
  console.log(JSON.stringify(output, null, 2));
  console.log('═'.repeat(60));
  console.log('File location: D:\\병리\\data\\cosmx_tiles\\' + currentSlideId + '\\transform.json');
  
  // Copy to clipboard if possible
  try {
    navigator.clipboard.writeText(JSON.stringify(output, null, 2));
    console.log('📋 Copied to clipboard!');
  } catch (e) {
    console.log('(Manual copy required)');
  }
  
  return position;
}

// ============================================================================
// UI SETUP
// ============================================================================

function setupUI() {
  document.getElementById('slideSelect').onchange = (e) => {
    if (e.target.value) loadSlide(e.target.value);
  };

  document.querySelectorAll('.label-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.label-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      currentLabel = btn.dataset.label;
      console.log('Label:', currentLabel);
    };
  });

  document.getElementById('drawPolygon').onclick = () => {
    annotorious.setDrawingEnabled(false);
    setTimeout(() => {
      annotorious.setDrawingTool('polygon');
      annotorious.setDrawingEnabled(true);
      document.getElementById('drawPolygon').classList.add('selected');
      document.getElementById('drawRectangle').classList.remove('selected');
      console.log('🖊️ Polygon ready (LEFT panel)');
    }, 50);
  };

  document.getElementById('drawRectangle').onclick = () => {
    annotorious.setDrawingEnabled(false);
    setTimeout(() => {
      annotorious.setDrawingTool('rect');
      annotorious.setDrawingEnabled(true);
      document.getElementById('drawRectangle').classList.add('selected');
      document.getElementById('drawPolygon').classList.remove('selected');
      console.log('📐 Rectangle ready (LEFT panel)');
    }, 50);
  };

  let deleteMode = false;

  document.getElementById('deleteMode').onclick = (e) => {
    deleteMode = !deleteMode;
    e.target.style.background = deleteMode ? '#e74c3c' : '';
    e.target.style.color = deleteMode ? 'white' : '';
    e.target.textContent = deleteMode ? 'Exit Delete' : 'Delete Mode';

    if (deleteMode) {
      annotorious.setDrawingEnabled(false);
      viewerLeft.gestureSettingsMouse.dragToPan = true;
      console.log('🗑️ Delete mode');
    } else {
      annotorious.setDrawingEnabled(true);
      viewerLeft.gestureSettingsMouse.dragToPan = false;
      console.log('✏️ Drawing mode');
    }
  };

  annotorious.on('selectAnnotation', (anno) => {
    if (deleteMode && anno?.id) {
      annotorious.removeAnnotation(anno.id);
      updateCount();
      console.log('🗑️ Deleted');
    }
  });

  document.getElementById('deleteSelected').onclick = () => {
    const sel = annotorious.getSelected();
    if (!sel) return alert('Select annotation first');
    if (confirm('Delete?')) {
      annotorious.removeAnnotation(sel.id);
      updateCount();
    }
  };

  document.getElementById('clearAll').onclick = () => {
    const count = annotorious.getAnnotations().length;
    if (count === 0) return alert('No annotations');
    if (confirm(`Delete all ${count}?`)) {
      annotorious.clearAnnotations();
      updateCount();
    }
  };

  document.getElementById('saveBtn').onclick = saveAnnotations;
  document.getElementById('loadBtn').onclick = () => loadAnnotations();
  document.getElementById('exportBtn').onclick = exportGeoJSON;
  
  document.getElementById('importBtn').onclick = () => {
    document.getElementById('importInput').click();
  };
  
  document.getElementById('importInput').onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      importGeoJSON(file);
      e.target.value = '';
    }
  };

  // CosMx toggle
  document.getElementById('cosmxToggle').onclick = (e) => {
    cosmxVisible = !cosmxVisible;
    e.target.textContent = cosmxVisible ? 'CosMx: ON' : 'CosMx: OFF';
    e.target.classList.toggle('active', cosmxVisible);

    if (cosmxVisible) {
      if (cosmxData?.dziUrl) renderCosMxOverlay();
    } else {
      removeCosMxLayerOnly();
    }

    console.log('CosMx overlay:', cosmxVisible ? 'ON' : 'OFF');
  };

  // Sync toggle button
  const syncBtn = document.getElementById('syncToggle');
  if (syncBtn) {
    syncBtn.onclick = toggleSync;
  }

  // Re-sync button
  const resyncBtn = document.getElementById('resyncBtn');
  if (resyncBtn) {
    resyncBtn.onclick = resyncPanels;
  }

  // ====== CosMx Transform Controls ======
  
  // Rotation slider
  const rotationSlider = document.getElementById('rotationSlider');
  const rotationValue = document.getElementById('rotationValue');
  if (rotationSlider) {
    rotationSlider.oninput = (e) => {
      const rotation = parseInt(e.target.value);
      rotationValue.textContent = rotation;
      setCosMxRotation(rotation);
    };
  }

  // Rotation preset buttons
  document.querySelectorAll('.preset-btn[data-rotation]').forEach(btn => {
    btn.onclick = () => {
      const rotation = parseInt(btn.dataset.rotation);
      if (rotationSlider) rotationSlider.value = rotation;
      if (rotationValue) rotationValue.textContent = rotation;
      setCosMxRotation(rotation);
      
      // Highlight active preset
      document.querySelectorAll('.preset-btn[data-rotation]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  // Flip X button
  const flipXBtn = document.getElementById('flipXBtn');
  if (flipXBtn) {
    flipXBtn.onclick = () => {
      toggleCosMxFlipX();
      flipXBtn.classList.toggle('active');
    };
  }

  // Flip Y button
  const flipYBtn = document.getElementById('flipYBtn');
  if (flipYBtn) {
    flipYBtn.onclick = () => {
      toggleCosMxFlipY();
      flipYBtn.classList.toggle('active');
    };
  }

  // Scale slider
  const scaleSlider = document.getElementById('scaleSlider');
  const scaleValue = document.getElementById('scaleValue');
  if (scaleSlider) {
    scaleSlider.oninput = (e) => {
      const scale = parseFloat(e.target.value);
      scaleValue.textContent = scale.toFixed(2);
      setCosMxScale(scale);
    };
  }

  // Save position button
  const savePositionBtn = document.getElementById('savePositionBtn');
  if (savePositionBtn) {
    savePositionBtn.onclick = () => {
      const pos = saveCosMxPosition();
      if (pos) {
        alert('Position saved to console!\nCopy the JSON to transform.json');
      }
    };
  }

  // Space key
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      viewerLeft.gestureSettingsMouse.dragToPan = true;
      viewerRight.gestureSettingsMouse.dragToPan = true;
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      const deleteBtn = document.getElementById('deleteMode');
      const isDeleteMode = deleteBtn.textContent === 'Exit Delete';
      if (!isDeleteMode) {
        viewerLeft.gestureSettingsMouse.dragToPan = false;
        viewerRight.gestureSettingsMouse.dragToPan = false;
      }
      e.preventDefault();
    }
  });
}

// ============================================================================
// SLIDES
// ============================================================================

async function loadSlides() {
  try {
    const slides = await _loadSlidesJSON();

    const select = document.getElementById('slideSelect');
    select.innerHTML = '<option value="">Select slide...</option>';

    slides.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name || s.id;
      select.appendChild(opt);
      slideDziMap[s.id] = s.dzi_url;
      slideCosmxMap[s.id] = s.cosmx || { has_cosmx: false };
    });

    console.log(`Loaded ${slides.length} slides (demo/static mode)`);
  } catch (err) {
    console.error('Failed to load slides:', err);
  }
}

// ============================================================================
// MODIFIED: loadSlide - Right panel no longer loads H&E
// ============================================================================

async function loadSlide(slideId) {
  currentSlideId = slideId;

  annotorious.clearAnnotations();
  clearCosMxOverlay(true);
  
  // Reset transform state
  cosmxTransformState = {
    rotation: 0,
    flipX: false,
    flipY: false,
    scale: 1.0
  };
  updateTransformUI();

  const dziUrl = slideDziMap[slideId];
  if (!dziUrl) return;

  console.log(`Loading: ${slideId}`);

  // Left panel: Load H&E
  viewerLeft.open(dziUrl);
  
  // Right panel: Close any existing image (will load CosMx only)
  viewerRight.close();

  // Wait for left panel to load
  await new Promise(resolve => viewerLeft.addOnceHandler('open', resolve));

  await onSlidesReady();
}

async function onSlidesReady() {
  await loadAnnotations();
  await loadCosMxData();
  updateCount();
  console.log('✅ Left: H&E loaded, Right: CosMx only');
}

// ============================================================================
// ANNOTATIONS
// ============================================================================

// DEMO MODE: no backend to save to. Persist to localStorage instead,
// so annotations survive a page reload during the demo session.
async function saveAnnotations() {
  if (!currentSlideId) return alert('Select slide first');

  try {
    const annos = annotorious.getAnnotations();
    const geojson = {
      type: 'FeatureCollection',
      features: annos.map(a => ({
        type: 'Feature',
        properties: {
          id: a.id,
          label: a.body?.find(b => b.purpose === 'tagging')?.value || 'other'
        },
        geometry: {
          type: 'Polygon',
          coordinates: [extractCoords(a)]
        }
      }))
    };

    localStorage.setItem('demo_anno_' + currentSlideId, JSON.stringify(geojson));
    console.log('✅ Saved to localStorage (demo mode)');
    alert('Saved! (Demo mode: stored in browser only, not on a server.)');
  } catch (err) {
    console.error('Save failed:', err);
    alert('Save failed');
  }
}

// DEMO MODE: read back annotations previously saved to localStorage
// for this slide (if any). No backend GET.
async function loadAnnotations() {
  if (!currentSlideId) return;

  try {
    const raw = localStorage.getItem('demo_anno_' + currentSlideId);
    if (!raw) throw new Error('Not found');

    const geojson = JSON.parse(raw);
    const annos = geojson.features.map(f => ({
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      type: 'Annotation',
      id: f.properties.id || `anno_${Date.now()}`,
      body: [{
        type: 'TextualBody',
        purpose: 'tagging',
        value: f.properties.label || 'other'
      }],
      target: {
        selector: {
          type: 'SvgSelector',
          value: coordsToSvg(f.geometry.coordinates[0])
        }
      }
    }));

    annotorious.clearAnnotations();
    annotorious.setAnnotations(annos);

    setTimeout(() => {
      annotorious.setAnnotations(annotorious.getAnnotations());
      updateCount();
    }, 100);

    console.log(`Loaded ${annos.length} annotations (demo/localStorage)`);
  } catch (err) {
    console.log('No annotations');
  }
}

function exportGeoJSON() {
  if (!currentSlideId) return alert('Select slide first');

  const annos = annotorious.getAnnotations();
  const geojson = {
    type: 'FeatureCollection',
    features: annos.map(a => ({
      type: 'Feature',
      properties: {
        id: a.id,
        label: a.body?.find(b => b.purpose === 'tagging')?.value || 'other'
      },
      geometry: {
        type: 'Polygon',
        coordinates: [extractCoords(a)]
      }
    }))
  };

  const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentSlideId}_annotations.geojson`;
  a.click();
  URL.revokeObjectURL(url);
  console.log('Exported');
}

function importGeoJSON(file) {
  if (!currentSlideId) {
    alert('Please select a slide first');
    return;
  }

  const reader = new FileReader();
  
  reader.onload = (e) => {
    try {
      const geojson = JSON.parse(e.target.result);
      
      if (!geojson.type || geojson.type !== 'FeatureCollection') {
        alert('Invalid GeoJSON: Must be a FeatureCollection');
        return;
      }
      
      if (!geojson.features || !Array.isArray(geojson.features)) {
        alert('Invalid GeoJSON: Missing features array');
        return;
      }
      
      const annotations = geojson.features.map(feature => {
        const coords = feature.geometry.coordinates[0];
        const label = feature.properties?.label || 'other';
        
        if (!Array.isArray(coords)) {
          console.error('Invalid coordinates:', coords);
          return null;
        }
        
        const annotation = {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          body: [{
            type: 'TextualBody',
            purpose: 'tagging',
            value: label
          }],
          target: {
            selector: {
              type: 'SvgSelector',
              value: coordsToSvg(coords)
            }
          }
        };
        
        return annotation;
      }).filter(a => a !== null);
      
      annotorious.clearAnnotations();
      
      annotations.forEach(anno => {
        annotorious.addAnnotation(anno);
      });
      
      setTimeout(() => {
        annotorious.setAnnotations(annotorious.getAnnotations());
      }, 100);
      
      updateCount();
      
      console.log(`✅ Imported ${annotations.length} annotations from ${file.name}`);
      alert(`Successfully imported ${annotations.length} annotations`);
      
    } catch (err) {
      console.error('Import failed:', err);
      alert(`Failed to import GeoJSON: ${err.message}`);
    }
  };
  
  reader.onerror = () => {
    alert('Failed to read file');
  };
  
  reader.readAsText(file);
}

// ============================================================================
// COSMX OVERLAY (RIGHT PANEL) - CosMx ONLY (No H&E)
// ============================================================================

// DEMO MODE: CosMx dzi_url + transform now come straight from slides.json
// (see generate_manifest.py), no Flask /api/cosmx/... calls.
async function loadCosMxData() {
  console.log('🔍 loadCosMxData() called');
  console.log('   currentSlideId:', currentSlideId);

  try {
    clearCosMxOverlay(true);

    const info = slideCosmxMap[currentSlideId];
    if (!info || !info.has_cosmx || !info.dzi_url) {
      console.log('ℹ️ No CosMx data for this slide');
      return;
    }

    console.log('✅ CosMx DZI found:', info.dzi_url);
    console.log('📐 Transform:', info.transform);

    cosmxData = {
      dziUrl: info.dzi_url,
      tiledImage: null,
      transform: info.transform || { transform: 'identity' }
    };

    if (cosmxVisible) {
      console.log('   Adding CosMx DZI layer (standalone)...');
      await renderCosMxOverlay();
    }
  } catch (err) {
    console.log('❌ No CosMx data for this slide:', err.message);
    clearCosMxOverlay(true);
  }
}

// ============================================================================
// MODIFIED: renderCosMxOverlay - CosMx only, no H&E background
// ============================================================================

async function renderCosMxOverlay() {
  console.log('🎨 renderCosMxOverlay() called');

  if (!cosmxVisible) return;
  if (!cosmxData?.dziUrl || !viewerRight) {
    console.log('   ❌ Missing cosmxData or viewerRight');
    return;
  }

  // 이미 레이어가 있으면 재추가 금지
  if (cosmxData.tiledImage) return;

  const dziUrl = cosmxData.dziUrl;
  console.log('   DZI URL:', dziUrl);

  try {
    viewerRight.addTiledImage({
      tileSource: dziUrl,
      opacity: 1.0,  // 100% opacity (no H&E behind)
      index: 0,      // Base layer (no H&E)
      success: (event) => {
        cosmxData.tiledImage = event.item;
        
        // Transform 적용
        applyCosMxTransform(event.item, cosmxData.transform);
        
        // Sync viewport with left panel
        syncToLeftPanel();
        
        console.log('✅ CosMx DZI layer added (standalone)');
        console.log('🔎 world item count:', viewerRight.world.getItemCount());
      },
      error: (event) => {
        console.error('❌ Failed to load CosMx DZI:', event);
      }
    });
  } catch (err) {
    console.error('❌ Error rendering CosMx:', err);
  }
}

// ============================================================================
// NEW: Sync right panel viewport to match left panel
// ============================================================================

function syncToLeftPanel() {
  if (!viewerLeft || !viewerRight) return;
  if (!viewerLeft.viewport || !viewerRight.viewport) return;
  
  try {
    const leftViewport = viewerLeft.viewport;
    const zoom = leftViewport.getZoom();
    const center = leftViewport.getCenter();
    
    viewerRight.viewport.zoomTo(zoom, null, true);
    viewerRight.viewport.panTo(center, true);
    
    console.log('📍 Synced right panel to left panel viewport');
  } catch (err) {
    console.log('   Could not sync viewports:', err.message);
  }
}

// ============================================================================
// MODIFIED: applyCosMxTransform - FlipY support added
// ============================================================================

function applyCosMxTransform(tiledImage, transformData) {
  console.log('🔧 Applying CosMx transform...');

  // DEMO MODE NOTE: generate_manifest.py already unwraps the nested
  // transform_registered.json structure, so transformData here is either
  //   { transform: 'identity' }                       -> no registration
  //   { rotation, flipX, flipY, scale, translateX, ... } -> already flat
  const isIdentity = transformData.transform === 'identity' || !transformData.rotation && !transformData.translateX && !transformData.scale;
  if (transformData.transform === 'identity') {
    console.log('   ✅ Identity transform (no changes)');
    return;
  }

  if (transformData.affine_matrix) {
    console.warn('   ⚠️ Affine matrix not yet implemented');
    return;
  }

  // Already-flat transform object (no extra .transform nesting in demo mode)
  const t = transformData.transform && typeof transformData.transform === 'object'
    ? transformData.transform   // backward-compat: still nested
    : transformData;            // demo mode: already flat

  if (!t || (t.rotation === undefined && t.translateX === undefined && t.scale === undefined)) {
    console.warn('   ⚠️ No transform data');
    return;
  }
  
  // ====== 왼쪽 패널의 H&E를 기준으로 크기 계산 ======
  const heLayer = viewerLeft.world.getItemAt(0);
  if (!heLayer) {
    console.warn('   ⚠️ No H&E reference layer in left panel');
    return;
  }
  
  const heBounds = heLayer.getBounds();
  console.log(`   📐 H&E viewport size: ${heBounds.width.toFixed(4)} x ${heBounds.height.toFixed(4)}`);
  
  // ====== FlipY 처리 ======
  let effectiveRotation = t.rotation || 0;
  let effectiveFlipX = t.flipX || t.flip_h || false;
  
  if (t.flipY) {
    effectiveRotation = (effectiveRotation + 180) % 360;
    effectiveFlipX = !effectiveFlipX;
    console.log('   🔄 FlipY detected -> converted to rotation+flipX');
  }
  
  // 1. 회전
  if (effectiveRotation) {
    tiledImage.setRotation(effectiveRotation, true);
    console.log(`   🔄 Rotation: ${effectiveRotation}°`);
  }
  
  // 2. 뒤집기 (FlipX)
  if (effectiveFlipX) {
    tiledImage.setFlip(true);
    console.log('   🔃 FlipX: true');
  }
  
  // 3. 스케일 - H&E viewport 크기 기준으로 설정
  // transformScale은 "CosMx를 H&E의 몇 %로 표시할지"를 의미
  const transformScale = t.scale || 1.0;
  const finalWidth = heBounds.width * transformScale;
  
  tiledImage.setWidth(finalWidth, true);
  console.log(`   📏 Scale: ${transformScale} → width=${finalWidth.toFixed(4)}`);
  
  // 4. 이동 (translateX/Y는 H&E 크기 대비 비율)
  let dx = 0, dy = 0;
  
  if (t.translateX !== undefined || t.translateY !== undefined) {
    dx = (t.translateX || 0) * heBounds.width;
    dy = (t.translateY || 0) * heBounds.height;
  } else if (t.x !== undefined || t.y !== undefined) {
    dx = t.x || 0;
    dy = t.y || 0;
  }
  
  if (dx !== 0 || dy !== 0) {
    const bounds = tiledImage.getBounds();
    const newPos = new OpenSeadragon.Point(
      bounds.x + dx,
      bounds.y + dy
    );
    tiledImage.setPosition(newPos, true);
    console.log(`   📍 Translation: (${dx.toFixed(4)}, ${dy.toFixed(4)})`);
  }
  
  console.log('   ✅ Transform applied');
  console.log(`   📊 Final: rot=${effectiveRotation}°, flipX=${effectiveFlipX}, scale=${transformScale}`);
  
  // Update transform state for UI
  cosmxTransformState.rotation = t.rotation || 0;
  cosmxTransformState.flipX = t.flipX || t.flip_h || false;
  cosmxTransformState.flipY = t.flipY || false;
  cosmxTransformState.scale = t.scale || 1.0;
  
  // Update UI controls
  updateTransformUI();
}

function removeCosMxLayerOnly() {
  console.log('🧹 removeCosMxLayerOnly() called');

  if (!viewerRight) return;

  if (cosmxData?.tiledImage) {
    viewerRight.world.removeItem(cosmxData.tiledImage);
    cosmxData.tiledImage = null;
    console.log('   Removed CosMx layer (kept cosmxData)');
    console.log('🔎 world item count:', viewerRight.world.getItemCount());
  }
}

function clearCosMxOverlay(reset = false) {
  console.log('🧹 clearCosMxOverlay() called');

  if (!viewerRight) return;

  if (cosmxData?.tiledImage) {
    viewerRight.world.removeItem(cosmxData.tiledImage);
    console.log('   Removed CosMx layer');
  }

  if (reset) {
    cosmxData = null;
  } else {
    if (cosmxData) cosmxData.tiledImage = null;
  }
}

// ============================================================================
// COSMX TRANSFORM CONTROLS
// ============================================================================

// Current transform state
let cosmxTransformState = {
  rotation: 0,
  flipX: false,
  flipY: false,
  scale: 1.0
};

function setCosMxRotation(degrees) {
  if (!cosmxData?.tiledImage) {
    console.warn('No CosMx layer loaded');
    return;
  }
  
  cosmxTransformState.rotation = degrees;
  
  // Calculate effective rotation (considering flipY)
  let effectiveRotation = degrees;
  let effectiveFlipX = cosmxTransformState.flipX;
  
  if (cosmxTransformState.flipY) {
    effectiveRotation = (degrees + 180) % 360;
    effectiveFlipX = !cosmxTransformState.flipX;
  }
  
  cosmxData.tiledImage.setRotation(effectiveRotation, true);
  cosmxData.tiledImage.setFlip(effectiveFlipX);
  
  console.log(`🔄 Rotation: ${degrees}° (effective: ${effectiveRotation}°)`);
}

function toggleCosMxFlipX() {
  if (!cosmxData?.tiledImage) {
    console.warn('No CosMx layer loaded');
    return;
  }
  
  cosmxTransformState.flipX = !cosmxTransformState.flipX;
  
  // Recalculate effective transform
  let effectiveRotation = cosmxTransformState.rotation;
  let effectiveFlipX = cosmxTransformState.flipX;
  
  if (cosmxTransformState.flipY) {
    effectiveRotation = (cosmxTransformState.rotation + 180) % 360;
    effectiveFlipX = !cosmxTransformState.flipX;
  }
  
  cosmxData.tiledImage.setRotation(effectiveRotation, true);
  cosmxData.tiledImage.setFlip(effectiveFlipX);
  
  console.log(`🔃 FlipX: ${cosmxTransformState.flipX}`);
}

function toggleCosMxFlipY() {
  if (!cosmxData?.tiledImage) {
    console.warn('No CosMx layer loaded');
    return;
  }
  
  cosmxTransformState.flipY = !cosmxTransformState.flipY;
  
  // FlipY = Rotation 180 + FlipX toggle
  let effectiveRotation = cosmxTransformState.rotation;
  let effectiveFlipX = cosmxTransformState.flipX;
  
  if (cosmxTransformState.flipY) {
    effectiveRotation = (cosmxTransformState.rotation + 180) % 360;
    effectiveFlipX = !cosmxTransformState.flipX;
  }
  
  cosmxData.tiledImage.setRotation(effectiveRotation, true);
  cosmxData.tiledImage.setFlip(effectiveFlipX);
  
  console.log(`🔃 FlipY: ${cosmxTransformState.flipY}`);
}

function setCosMxScale(scale) {
  if (!cosmxData?.tiledImage) {
    console.warn('No CosMx layer loaded');
    return;
  }
  
  cosmxTransformState.scale = scale;
  
  // 왼쪽 패널의 H&E를 기준으로 크기 계산
  const heLayer = viewerLeft.world.getItemAt(0);
  if (!heLayer) {
    console.warn('No H&E reference');
    return;
  }
  
  const heBounds = heLayer.getBounds();
  const finalWidth = heBounds.width * scale;
  
  cosmxData.tiledImage.setWidth(finalWidth, true);
  
  console.log(`📏 Scale: ${scale.toFixed(3)} → width=${finalWidth.toFixed(4)}`);
}

// Update UI to match current transform (called after loading)
function updateTransformUI() {
  const rotationSlider = document.getElementById('rotationSlider');
  const rotationValue = document.getElementById('rotationValue');
  const scaleSlider = document.getElementById('scaleSlider');
  const scaleValue = document.getElementById('scaleValue');
  const flipXBtn = document.getElementById('flipXBtn');
  const flipYBtn = document.getElementById('flipYBtn');
  
  if (rotationSlider) rotationSlider.value = cosmxTransformState.rotation;
  if (rotationValue) rotationValue.textContent = cosmxTransformState.rotation;
  if (scaleSlider) scaleSlider.value = cosmxTransformState.scale;
  if (scaleValue) scaleValue.textContent = cosmxTransformState.scale.toFixed(2);
  if (flipXBtn) flipXBtn.classList.toggle('active', cosmxTransformState.flipX);
  if (flipYBtn) flipYBtn.classList.toggle('active', cosmxTransformState.flipY);
  
  // Update rotation presets
  document.querySelectorAll('.preset-btn[data-rotation]').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.rotation) === cosmxTransformState.rotation);
  });
}

// ============================================================================
// COSMX TRANSFORM ADJUSTMENT (개발자 도구용)
// ============================================================================

function adjustCosMxTransform(rotation, x, y, scale, flipH) {
  if (!cosmxData?.tiledImage) {
    console.error('No CosMx layer loaded');
    return;
  }
  
  const item = cosmxData.tiledImage;
  
  if (rotation !== undefined) {
    item.setRotation(rotation, true);
    console.log(`Rotation: ${rotation}°`);
  }
  
  if (x !== undefined || y !== undefined) {
    const bounds = item.getBounds();
    item.setPosition(new OpenSeadragon.Point(
      (x !== undefined) ? x : bounds.x,
      (y !== undefined) ? y : bounds.y
    ), true);
    console.log(`Position: (${x}, ${y})`);
  }
  
  if (scale !== undefined) {
    const currentWidth = item.getContentSize().x;
    item.setWidth(currentWidth * scale, true);
    console.log(`Scale: ${scale}x`);
  }
  
  if (flipH !== undefined) {
    item.setFlip(flipH);
    console.log(`Flip H: ${flipH}`);
  }
}

function getCosMxTransform() {
  if (!cosmxData?.tiledImage) {
    console.error('No CosMx layer loaded');
    return;
  }
  
  const item = cosmxData.tiledImage;
  const bounds = item.getBounds();
  const rotation = item.getRotation();
  
  const transform = {
    x: bounds.x,
    y: bounds.y,
    rotation: rotation,
    width: item.getContentSize().x,
    flip_h: item.getFlip()
  };
  
  console.log('Current transform:', transform);
  console.log('Copy to transform.json:');
  console.log(JSON.stringify({
    transform: {
      rotation: Math.round(rotation),
      flipX: item.getFlip(),
      flipY: false,
      translateX: bounds.x,
      translateY: bounds.y,
      scale: 1.0
    }
  }, null, 2));
  
  return transform;
}

// ============================================================================
// HELPERS
// ============================================================================

function extractCoords(annotation) {
  const sel = annotation.target?.selector;
  if (!sel || sel.type !== 'SvgSelector') return [];

  const m = sel.value.match(/points\s*=\s*["']([^"']+)["']/i);
  if (!m) return [];

  return m[1].trim().split(/\s+/).map(p => p.split(',').map(Number));
}

function coordsToSvg(coords) {
  if (!Array.isArray(coords)) {
    console.error('coordsToSvg: coords is not an array', coords);
    return '<svg><polygon points="0,0"/></svg>';
  }
  
  const pts = coords.map(([x, y]) => `${x},${y}`).join(' ');
  return `<svg><polygon points="${pts}"/></svg>`;
}

function updateCount() {
  const count = annotorious.getAnnotations().length;
  document.getElementById('annotationCount').textContent = count;
}

console.log('✅ Viewer script loaded (CosMx-only mode)');
console.log('💡 Transform controls available in sidebar');
console.log('💡 Console commands:');
console.log('   toggleSync()        - Toggle sync ON/OFF');
console.log('   resyncPanels()      - Reset sync tracking');
console.log('   saveCosMxPosition() - Save transform to console');
console.log('   setCosMxRotation(deg)');
console.log('   toggleCosMxFlipX()');
console.log('   toggleCosMxFlipY()');
console.log('   setCosMxScale(scale)');