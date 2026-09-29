'use strict';

/*
 * Pathogene Demo viewer.js
 * Derived from the current Pathogene frontend.
 * Demo mode uses pre-generated H&E/CosMx DZI data served by the lightweight Flask backend.
 * Registration/pipeline UI entry points are intentionally hidden in index.html.
 */

'use strict';

function apiUrl(path) {
  return path;
}

function normalizeSlideUrls(slides) {
  return slides || [];
}

function normalizeCosMxInfo(info) {
  return info;
}

function normalizePreviewPayload(data) {
  return data;
}

function getSlideDziUrl(slide) {
  if (!slide) return null;
  return slide.dzi_url || slide.dzi || slide.tileSource || slide.tile_source || null;
}

async function loadHeDziMeta(slideId) {
  S.heDziDownsample = 1;
  S.heOriginalW = 0;
  S.heOriginalH = 0;
  if (!slideId) return;

  try {
    const r = await fetch('/tiles/' + encodeURIComponent(slideId) + '/dzi_meta.json', { cache: 'no-store' });
    if (!r.ok) {
      console.warn('[H&E] DZI metadata not found; using 1:1 annotation coordinates.');
      return;
    }

    const m = await r.json();
    const ds = Number(m.dzi_downsample || 1);
    S.heDziDownsample = Number.isFinite(ds) && ds > 0 ? ds : 1;
    S.heOriginalW = Number(m.slide_w || 0);
    S.heOriginalH = Number(m.slide_h || 0);
    console.log('[H&E] DZI metadata:', m);
  } catch (e) {
    console.warn('[H&E] DZI metadata unavailable; using 1:1 annotation coordinates:', e);
  }
}

function getCosMxDziUrl(info) {
  if (!info) return null;
  return info.dzi_url || info.dzi || info.tileSource || info.tile_source || null;
}


// ===========================================================================
// STATE
// ===========================================================================

const S = {
  slides: [], current: null,
  rightBase: 'cosmx', rightHeDzi: null, rightCosMxDzi: null,
  osdHE: null, osdCosMx: null, anno: null,
  syncEnabled: false, syncing: false,
  cosmxVisible: true, annoCount: 0,
  cosmxRot: 0, cosmxFlipX: false, cosmxFlipY: false, cosmxScale: 1.0,
  cosmxTransformPayload: null,
  svsPath: null, cosmxPath: null,
  transformType: 'affine', regMode: 'auto',
  anchorPairs: [], pendingHE: null,
  anchorSlideId: null, anchorTransformType: 'rigid', anchorMinPairs: 3,
  cosmxOrigW: 0, cosmxOrigH: 0,
  anchorCosmxOriginalUrl: '', anchorCosmxBaseImg: null,
  anchorCosmxRotation: 0, anchorCosmxFlipX: false, anchorCosmxFlipY: false,
  heImgLoaded: false, cosmxImgLoaded: false,
  importedAnnoIds: [],
  lassoEnabled: false,
  lassoDrawing: false,
  lassoPoints: [],
  lassoPointerTarget: null,
  lassoDownHandler: null,
  lassoMoveHandler: null,
  lassoUpHandler: null,
  lassoCancelHandler: null,
  magicWandEnabled: false,
  magicWandBusy: false,
  magicWandHistory: [],
  magicWandToken: 0,
  magicWandSeed: null,
  magicWandPreviewPolygon: null,
  magicWandPreviewMeta: null,
  magicWandStrength: 0.0,
  magicWandDragging: false,
  magicWandDragStartPx: null,
  magicWandDragCurrentPx: null,
  magicWandPointerTarget: null,
  magicWandPointerDownHandler: null,
  magicWandPointerMoveHandler: null,
  magicWandPointerUpHandler: null,
  magicWandActivePointerId: null,
  // H&E DZI coordinate metadata. External pathology GeoJSON is assumed to use
  // original level-0 H&E pixel coordinates; Annotorious uses DZI pixel coordinates.
  heDziDownsample: 1, heOriginalW: 0, heOriginalH: 0,
};
const ZOOM = {
  he:    { scale:1, tx:0, ty:0, _drag:false, _sx:0, _sy:0, _moved:false },
  cosmx: { scale:1, tx:0, ty:0, _drag:false, _sx:0, _sy:0, _moved:false },
};
const ZOOM_MIN = 0.3, ZOOM_MAX = 20;

// ADDED: Confidence threshold state
const TH = { features:[], scores:[], threshold:0.10, useLog:false, chart:null };
let TH_BINS = [];

// ===========================================================================
// ANNOTATION CLASS STYLE
// ===========================================================================

const ANNO_CLASS_STYLES = {
  tumor: {
    stroke: '#e74c3c',
    fill: 'rgba(231,76,60,0.28)',
    label: 'Tumor'
  },
  stroma: {
    stroke: '#2ecc71',
    fill: 'rgba(46,204,113,0.26)',
    label: 'Stroma'
  },
  'other / in-situ': {
    stroke: '#9b59b6',
    fill: 'rgba(155,89,182,0.24)',
    label: 'Other / In-situ'
  },
  'other': {
    stroke: '#9b59b6',
    fill: 'rgba(155,89,182,0.24)',
    label: 'Other'
  },
  'in-situ': {
    stroke: '#9b59b6',
    fill: 'rgba(155,89,182,0.24)',
    label: 'In-situ'
  },
  lymphocyte: {
    stroke: '#00ffff',
    fill: 'rgba(0,255,255,0.20)',
    label: 'Lymphocyte'
  }
};

function normalizeAnnoClassName(value) {
  return String(value || 'other')
    .trim()
    .replace(/\*+$/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function annotationClassFromAnnotation(annotation) {
  // Robustly read class labels from both Annotorious WebAnnotation body
  // and imported/exported GeoJSON-like properties. Missing labels must not
  // silently become purple unless they are truly "other".
  const rawBody = annotation?.body;
  const body = Array.isArray(rawBody) ? rawBody : (rawBody ? [rawBody] : []);

  const tag = body.find(b =>
    (b?.purpose === 'tagging' || b?.type === 'TextualBody') &&
    (b?.value || b?.label || b?.name)
  );

  const props = annotation?.properties || annotation?.target?.properties || {};
  const cls = tag?.value || tag?.label || tag?.name ||
              props?.classification?.name || props?.className ||
              props?.label || props?.name || annotation?.className || '';

  return normalizeAnnoClassName(cls || 'other');
}

function styleForAnnoClass(className) {
  const key = normalizeAnnoClassName(className);
  if (ANNO_CLASS_STYLES[key]) return ANNO_CLASS_STYLES[key];
  if (key.includes('tumor')) return ANNO_CLASS_STYLES.tumor;
  if (key.includes('stroma')) return ANNO_CLASS_STYLES.stroma;
  if (key.includes('lymph')) return ANNO_CLASS_STYLES.lymphocyte;
  if (key.includes('situ')) return ANNO_CLASS_STYLES['other / in-situ'];
  return ANNO_CLASS_STYLES.other;
}

function annoFormatter(annotation) {
  const cls = annotationClassFromAnnotation(annotation);
  const st = styleForAnnoClass(cls);
  return {
    style:
      'stroke:' + st.stroke + ';' +
      'stroke-width:3;' +
      'fill:' + st.fill + ';' +
      'fill-opacity:1;' +
      'stroke-opacity:1;'
  };
}


// ===========================================================================
// SCREEN
// ===========================================================================

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function goViewer()     { showScreen('screen-viewer'); }
function goRegister()   { alert('Registration is disabled in the Demo build. Use pre-generated DZI data.'); }
function goProcessing() { showScreen('screen-processing'); }
function goAnchor()     { showScreen('screen-anchor'); }

// ===========================================================================
// INIT
// ===========================================================================

window.addEventListener('DOMContentLoaded', () => {
  // Show UI immediately. Without this, a slow/failed /api/slides request can leave
  // every .screen hidden and the page looks blank.
  goViewer();

  try {
    ['he', 'cosmx'].forEach(side => {
      const wrap = document.getElementById(side + 'ImgWrap');
      if (!wrap) return;
      wrap.addEventListener('wheel',      e => onPanelWheel(e, side),     { passive: false });
      wrap.addEventListener('mousedown',  e => onPanelMouseDown(e, side));
      wrap.addEventListener('mousemove',  e => onPanelMouseMove(e, side));
      wrap.addEventListener('mouseup',    e => onPanelMouseUp(e, side));
      wrap.addEventListener('mouseleave', e => onPanelMouseLeave(e, side));
      wrap.addEventListener('contextmenu', e => e.preventDefault());
    });

    const thInput = document.getElementById('thImportInput');
    if (thInput) {
      thInput.addEventListener('change', e => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          try { thImportLymp(JSON.parse(ev.target.result)); }
          catch(err) { alert('Invalid GeoJSON: ' + err.message); }
        };
        reader.readAsText(file);
        e.target.value = '';
      });
    }

    window.addEventListener('resize', thResizeCanvas);
    bindThresholdControls();

    const previewOpacity = document.getElementById('previewOpacity');
    if (previewOpacity) {
      previewOpacity.addEventListener('input', renderPreviewCanvas);
    }
  } catch (e) {
    console.error('UI event binding failed:', e);
    statusText('UI event binding failed: ' + e.message);
  }

  initWebApp();
});

window.addEventListener('error', e => {
  console.error('Global JS error:', e.error || e.message);
  try {
    goViewer();
    statusText('JavaScript error: ' + (e.message || e.error));
  } catch (_) {}
});

// ===========================================================================
// WEB API HELPERS - Flask backend version
// ===========================================================================

// (PIPELINE_TIMER and related vars declared below in WEB PIPELINE POLLING section)
let PIPELINE_ANCHOR_SHOWN = false;

async function apiJSON(url, options = {}) {
  const res = await fetch(url, options);

  // Read body only once. Do not call res.json() and res.text() on the same response.
  const rawText = await res.text();

  let data = {};
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      data = { error: rawText };
    }
  }

  if (!res.ok) {
    throw new Error(data.error || ('HTTP ' + res.status));
  }

  return data;
}
async function apiGetSlides() {
  return apiJSON('/api/slides');
}

async function apiGetCosmxInfo(slideId) {
  try {
    return await apiJSON('/api/cosmx/' + encodeURIComponent(slideId) + '/dzi');
  } catch(e) {
    return { has_cosmx:false };
  }
}

async function apiGetCosmxTransform(slideId) {
  try {
    return await apiJSON('/api/cosmx/' + encodeURIComponent(slideId) + '/transform');
  } catch(e) {
    console.warn('CosMx transform load failed:', e);
    return { transform: 'identity' };
  }
}

async function initWebApp() {
  try {
    statusText('Connecting to backend...');
    const slides = await apiGetSlides();
    S.slides = normalizeSlideUrls(slides);
    populateSlideSelect(S.slides);

    if (S.slides.length > 0) {
      await loadSlide(S.slides[0]);
      document.getElementById('slideSelect').value = S.slides[0].id;
    } else {
      statusText('Ready');
    }
  } catch(e) {
    console.error('Init error:', e);
    statusText('Backend connection failed: ' + e.message);
  }
}

function normalizeWinPath(path) {
  return (path || '').trim().replace(/^"|"$/g, '');
}

async function apiChooseLocalPath(kind) {
  // Local/demo mode: do NOT upload huge SVS files through the browser.
  // Instead, ask the Flask backend to open a native file dialog on the same PC
  // and return the real Windows path.
  const endpoint = kind === 'he' ? '/api/dialog/svs' : '/api/dialog/cosmx';
  const data = await apiJSON(endpoint);
  if (data.error) throw new Error(data.error);
  return normalizeWinPath(data.path || '');
}

function fileNameFromPath(path) {
  return (path || '').split(/[\\\/]/).pop();
}

function setHELocalPath(path) {
  path = normalizeWinPath(path);
  if (!path) return;
  S.svsPath = path;
  document.getElementById('heName').textContent = fileNameFromPath(path);
  document.getElementById('dzHE').classList.add('filled');
  document.getElementById('pathDebug').style.display = 'block';
  document.getElementById('dbgSVS').textContent = path;
  checkStartBtn();
}

function setCosMxLocalPath(path) {
  path = normalizeWinPath(path);
  if (!path) return;
  S.cosmxPath = path;
  document.getElementById('cosmxName').textContent = fileNameFromPath(path);
  document.getElementById('dzCosMx').classList.add('filled');
  document.getElementById('pathDebug').style.display = 'block';
  document.getElementById('dbgCosMx').textContent = path;
}

async function selectHE() {
  try {
    document.getElementById('heName').textContent = 'Choosing local path...';
    document.getElementById('pathDebug').style.display = 'block';
    document.getElementById('dbgSVS').textContent = 'Opening file dialog...';

    const path = await apiChooseLocalPath('he');
    if (!path) {
      document.getElementById('heName').textContent = S.svsPath ? fileNameFromPath(S.svsPath) : '';
      document.getElementById('dbgSVS').textContent = S.svsPath || '';
      return;
    }
    setHELocalPath(path);

  } catch(e) {
    S.svsPath = null;
    document.getElementById('dzHE').classList.remove('filled');
    document.getElementById('heName').textContent = '';
    document.getElementById('dbgSVS').textContent = '';
    checkStartBtn();
    alert('Failed to select H&E local path: ' + e.message);
  }
}

async function selectCosMx() {
  try {
    document.getElementById('cosmxName').textContent = 'Choosing local path...';
    document.getElementById('pathDebug').style.display = 'block';
    document.getElementById('dbgCosMx').textContent = 'Opening file dialog...';

    const path = await apiChooseLocalPath('cosmx');
    if (!path) {
      document.getElementById('cosmxName').textContent = S.cosmxPath ? fileNameFromPath(S.cosmxPath) : '';
      document.getElementById('dbgCosMx').textContent = S.cosmxPath || '—';
      return;
    }
    setCosMxLocalPath(path);

  } catch(e) {
    S.cosmxPath = null;
    document.getElementById('dzCosMx').classList.remove('filled');
    document.getElementById('cosmxName').textContent = '';
    document.getElementById('dbgCosMx').textContent = '—';
    alert('Failed to select CosMx local path: ' + e.message);
  }
}
function onDragOver(e,id) { e.preventDefault(); document.getElementById(id).classList.add('dragover'); }
function onDragLeave(id)  { document.getElementById(id).classList.remove('dragover'); }
async function onDrop(e,type) {
  // Browser drag/drop does not reliably expose the real Windows path.
  // So dropping a file simply opens the backend local file dialog.
  e.preventDefault();
  document.getElementById(type==='he'?'dzHE':'dzCosMx').classList.remove('dragover');
  if (type === 'he') await selectHE();
  else await selectCosMx();
}
function checkStartBtn() {
  // Enable Preview button when H&E file is selected
  const btn = document.getElementById('btnPreview');
  if (btn) btn.disabled = !S.svsPath;
  // Reset preview section when files change
  const ps = document.getElementById('previewSection');
  if (ps) ps.style.display = 'none';
  const st = document.getElementById('previewStatus');
  if (st) st.textContent = '';
}

async function generatePreview() {
  if (!S.svsPath) return;
  const btn = document.getElementById('btnPreview');
  btn.disabled = true;
  btn.innerHTML = '<span>&#8987;</span> Generating preview...';
  document.getElementById('previewStatus').textContent = S.regMode === 'tiling-only'
    ? 'Generating thumbnails only. Registration will be skipped...'
    : 'Generating thumbnails and fast registration preview...';

  try {
    const slideId = S.svsPath
      ? S.svsPath.split(/[\\\/]/).pop().replace(/\.[^.]+$/, '')
      : '';

    const modeForBackend = S.regMode === 'semi-auto' ? 'manual' : S.regMode;

    const r = await apiJSON('/api/pipeline/run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        svs_path: S.svsPath,
        cosmx_path: S.cosmxPath || '',
        slide_id: slideId,
        transform_type: S.transformType,
        mode: modeForBackend
      }),
    });

    if (r.error) throw new Error(r.error);

    const payload = r.preview_payload || r.preview || r;
    if (payload.registration_skipped || S.regMode === 'tiling-only') {
      document.getElementById('previewStatus').textContent =
        'Tiling-only preview ready. No registration transform was estimated.';
    } else if (payload.registration_warning) {
      document.getElementById('previewStatus').textContent =
        'Auto registration warning: ' + payload.registration_warning + ' — use anchor adjustment if needed.';
    } else {
      document.getElementById('previewStatus').textContent = 'Preview ready.';
    }

    initPreviewScreen(payload);

  } catch(e) {
    document.getElementById('previewStatus').textContent = 'Preview failed: ' + e.message;
    console.error('[Preview]', e);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>&#128300;</span> Preview Slide';
  }
}

async function startPipeline() {
  // Backward-compatible button. In the preview-first flow, full tiling starts
  // from the Registration Preview screen by clicking "Looks good".
  if (_previewData) {
    return confirmPreview('approve');
  }
  return generatePreview();
}


// ===========================================================================
// WEB PIPELINE POLLING
// ===========================================================================

let PIPELINE_TIMER = null;
let PIPELINE_LAST_LOG_COUNT = 0;
let PIPELINE_ANCHOR_OPENED = false;

function startPipelinePolling() {
  if (PIPELINE_TIMER) {
    clearInterval(PIPELINE_TIMER);
    PIPELINE_TIMER = null;
  }

  PIPELINE_LAST_LOG_COUNT = 0;
  PIPELINE_ANCHOR_OPENED = false;

  PIPELINE_TIMER = setInterval(async () => {
    try {
      const status = await apiJSON('/api/pipeline/status');

      if (status.total && status.current) {
        window.onPipelineStep({
          step: status.current,
          total: status.total,
          name: status.step || ''
        });
      }

      const logs = status.logs || [];
      for (let i = PIPELINE_LAST_LOG_COUNT; i < logs.length; i++) {
        window.onPipelineLog({ line: logs[i] });
      }
      PIPELINE_LAST_LOG_COUNT = logs.length;

      if (status.need_preview && status.preview_payload && !PIPELINE_ANCHOR_OPENED) {
        PIPELINE_ANCHOR_OPENED = true;
        clearInterval(PIPELINE_TIMER); PIPELINE_TIMER = null;
        initPreviewScreen(status.preview_payload);
        return;
      }

      if (status.need_anchors && status.anchor_payload && !PIPELINE_ANCHOR_OPENED) {
        PIPELINE_ANCHOR_OPENED = true;
        window.onNeedAnchors(status.anchor_payload);
        return;
      }

      if (status.error) {
        clearInterval(PIPELINE_TIMER);
        PIPELINE_TIMER = null;
        window.onPipelineError({
          step: status.step || 'Pipeline',
          error: status.error
        });
        return;
      }

      if (status.done) {
        clearInterval(PIPELINE_TIMER);
        PIPELINE_TIMER = null;
        window.onPipelineDone({
          slide_id: status.slide_id
        });
        return;
      }

    } catch (e) {
      clearInterval(PIPELINE_TIMER);
      PIPELINE_TIMER = null;
      window.onPipelineError({
        step: 'Pipeline polling',
        error: e.message || String(e)
      });
    }
  }, 800);
}


// ===========================================================================
// PIPELINE CALLBACKS
// ===========================================================================

window.onPipelineStart = function(data) {
  const list = document.getElementById('stepsList');
  list.innerHTML = '';
  (data.steps||[]).forEach((name,i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="si" id="si-${i+1}">&#9675;</span><span class="sl pending" id="sl-${i+1}">${name}</span>`;
    list.appendChild(li);
  });
  document.getElementById('procSlideName').textContent = data.slide_id;
  document.getElementById('procPct').textContent = '0 / ' + data.total;
  document.getElementById('procFill').style.width = '0%';
  document.getElementById('procLog').textContent = '';
  document.getElementById('procBackBtn').style.display = 'none';
};
window.onPipelineStep = function(data) {
  for (let i=1;i<=data.total;i++) {
    const si=document.getElementById('si-'+i), sl=document.getElementById('sl-'+i);
    if(!si||!sl) continue;
    if(i<data.step){si.textContent='v';sl.className='sl done';}
    else if(i===data.step){si.textContent='>';sl.className='sl active';}
    else{si.textContent='o';sl.className='sl pending';}
  }
  const pct=Math.round((data.step-1)/data.total*100);
  document.getElementById('procFill').style.width=pct+'%';
  document.getElementById('procPct').textContent=(data.step-1)+' / '+data.total;
};
window.onPipelineLog = function(data) {
  const box=document.getElementById('procLog');
  box.textContent+=(data.line||'')+'\n'; box.scrollTop=box.scrollHeight;
};
window.onPipelineError = function(data) {
  appendLog('[ERROR] '+data.step+': '+data.error);
  document.getElementById('procBackBtn').style.display='block';
  document.querySelectorAll('.sl.active,.sl.pending').forEach(el=>el.className='sl error');
};
window.onPipelineDone = function(data) {
  document.querySelectorAll('.si').forEach(el=>el.textContent='v');
  document.querySelectorAll('.sl').forEach(el=>el.className='sl done');
  document.getElementById('procFill').style.width='100%';
  document.getElementById('procPct').textContent='Complete';
  appendLog('Done: '+data.slide_id);
  // Show fallback button immediately in case auto-navigation fails
  const backBtn = document.getElementById('procBackBtn');
  backBtn.textContent = 'Open Viewer';
  backBtn.onclick = () => goViewer();
  backBtn.style.display = 'block';
  setTimeout(async()=>{
    try {
      const slides = await apiGetSlides();
      S.slides = normalizeSlideUrls(slides); populateSlideSelect(S.slides);
      const s = S.slides.find(sl => sl.id === data.slide_id);
      if(s){ await loadSlide(s); document.getElementById('slideSelect').value=s.id; }
    } catch(e) {
      appendLog('[WARN] Auto-load failed: '+e+' — click Open Viewer');
      return;  // Stay on processing screen so user can click the button
    }
    goViewer();
  },1200);
};
window.onNeedAnchors = function(data) { initAnchorScreen(data); goAnchor(); };
function appendLog(line) { const b=document.getElementById('procLog'); b.textContent+=line+'\n'; b.scrollTop=b.scrollHeight; }

// ===========================================================================
// ANCHOR SCREEN - ZOOM / PAN
// ===========================================================================

function _applyZoom(side) {
  const z  = ZOOM[side];
  const el = document.getElementById(side === 'he' ? 'heZoom' : 'cosmxZoom');
  el.style.transform = `translate(${z.tx}px,${z.ty}px) scale(${z.scale})`;
  document.getElementById(side + 'ZoomLabel').textContent = Math.round(z.scale * 100) + '%';
}
function _zoomAt(side, factor, cx, cy) {
  const z = ZOOM[side];
  const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z.scale * factor));
  const ratio    = newScale / z.scale;
  z.tx    = cx - ratio * (cx - z.tx);
  z.ty    = cy - ratio * (cy - z.ty);
  z.scale = newScale;
  _applyZoom(side);
}
function zoomIn(side) { const w=document.getElementById(side+'ImgWrap'); _zoomAt(side,1.3,w.clientWidth/2,w.clientHeight/2); }
function zoomOut(side){ const w=document.getElementById(side+'ImgWrap'); _zoomAt(side,1/1.3,w.clientWidth/2,w.clientHeight/2); }
function zoomReset(side) { ZOOM[side].scale=1;ZOOM[side].tx=0;ZOOM[side].ty=0; _applyZoom(side); }

function onPanelWheel(e, side) {
  e.preventDefault();
  const wrap=document.getElementById(side+'ImgWrap');
  const rect=wrap.getBoundingClientRect();
  _zoomAt(side, e.deltaY<0?1.12:1/1.12, e.clientX-rect.left, e.clientY-rect.top);
}
function onPanelMouseDown(e, side) {
  if(e.button!==0)return;
  if(e.target.classList.contains('a-marker'))return;
  const z=ZOOM[side];
  z._drag=true; z._sx=e.clientX-z.tx; z._sy=e.clientY-z.ty;
  z._ox=e.clientX; z._oy=e.clientY; z._moved=false;
  document.getElementById(side+'ImgWrap').classList.replace('crosshair','grabbing')||
  document.getElementById(side+'ImgWrap').classList.add('grabbing');
}
function onPanelMouseMove(e, side) {
  const z=ZOOM[side]; if(!z._drag)return;
  z.tx=e.clientX-z._sx; z.ty=e.clientY-z._sy;
  if(Math.abs(e.clientX-z._ox)>4||Math.abs(e.clientY-z._oy)>4) z._moved=true;
  _applyZoom(side);
}
function onPanelMouseUp(e, side) {
  const z=ZOOM[side]; if(!z._drag)return;
  z._drag=false;
  const wrap=document.getElementById(side+'ImgWrap');
  wrap.classList.remove('grabbing'); wrap.classList.add('crosshair');
  if(!z._moved){ if(side==='he') _doHEClick(e); else _doCosMxClick(e); }
}
function onPanelMouseLeave(e, side) {
  ZOOM[side]._drag=false;
  const wrap=document.getElementById(side+'ImgWrap');
  wrap.classList.remove('grabbing'); wrap.classList.add('crosshair');
}

// ===========================================================================
// ANCHOR PLACEMENT
// ===========================================================================

function initAnchorScreen(data) {
  S.anchorPairs=[]; S.pendingHE=null;
  S.anchorSlideId=data.slide_id;
  S.anchorTransformType=data.transform_type||'affine';
  S.anchorMinPairs=S.anchorTransformType==='affine'?4:2;
  S.cosmxOrigW=data.cosmx_orig_w||0; S.cosmxOrigH=data.cosmx_orig_h||0;
  S.anchorCosmxOriginalUrl = data.cosmx_url;
  S.anchorCosmxBaseImg = null;
  S.anchorCosmxRotation = 0;
  S.anchorCosmxFlipX = false;
  S.anchorCosmxFlipY = false;
  S.heImgLoaded=false; S.cosmxImgLoaded=false;
  document.getElementById('anchorTransBadge').textContent=S.anchorTransformType==='affine'?'Affine':'Rigid Body';
  document.getElementById('anchorStepBadge').textContent='Step '+data.step+' / '+data.total;
  document.getElementById('heHint').textContent='Click to place anchor';
  document.getElementById('cosmxHint').textContent='Rotate/flip CosMx if needed, then click H&E first';
  document.getElementById('cosmxImgWrap').classList.remove('waiting');
  ['he','cosmx'].forEach(s=>{zoomReset(s);});
  ['he','cosmx'].forEach(s=>{
    document.getElementById(s+'Loading').style.display='flex';
    document.getElementById(s+'Thumb').style.display='none';
  });
  updateAnchorOrientationButtons();
  document.getElementById('heThumb').src=data.he_url;
  loadAnchorCosMxBaseImage(data.cosmx_url);

  document.getElementById('heFilename').textContent    = data.he_url.split('/').pop();
  document.getElementById('cosmxFilename').textContent = data.cosmx_url.split('/').pop();
  renderMarkers(); updateAnchorUI();
}

function loadAnchorCosMxBaseImage(url) {
  const loading = document.getElementById('cosmxLoading');
  const imgEl = document.getElementById('cosmxThumb');
  if (loading) loading.style.display = 'flex';
  if (imgEl) imgEl.style.display = 'none';
  S.cosmxImgLoaded = false;

  const img = new Image();
  img.onload = () => {
    S.anchorCosmxBaseImg = img;
    applyAnchorCosMxOrientation(false);
  };
  img.onerror = () => onImgError('cosmx');
  img.src = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
}

function updateAnchorOrientationButtons() {
  [0,90,180,270].forEach(r => {
    const b = document.getElementById('anchorRot' + r);
    if (b) b.classList.toggle('active', S.anchorCosmxRotation === r);
  });
  const bx = document.getElementById('anchorFlipX');
  const by = document.getElementById('anchorFlipY');
  if (bx) bx.classList.toggle('active', !!S.anchorCosmxFlipX);
  if (by) by.classList.toggle('active', !!S.anchorCosmxFlipY);
  const note = document.getElementById('anchorOrientNote');
  if (note) note.textContent = `CosMx orientation: R=${S.anchorCosmxRotation}°, FX=${S.anchorCosmxFlipX}, FY=${S.anchorCosmxFlipY}`;
}

function setAnchorCosMxRotation(rot) {
  S.anchorCosmxRotation = Number(rot) || 0;
  applyAnchorCosMxOrientation(true);
}

function toggleAnchorCosMxFlip(axis) {
  if (axis === 'x') S.anchorCosmxFlipX = !S.anchorCosmxFlipX;
  if (axis === 'y') S.anchorCosmxFlipY = !S.anchorCosmxFlipY;
  applyAnchorCosMxOrientation(true);
}

function _clearAnchorsForOrientationChange() {
  if (S.anchorPairs.length || S.pendingHE) {
    S.anchorPairs = [];
    S.pendingHE = null;
    document.getElementById('cosmxImgWrap').classList.remove('waiting');
    document.getElementById('heHint').textContent = 'Click to place anchor';
    document.getElementById('cosmxHint').textContent = 'Orientation changed — anchors cleared. Click H&E first.';
  }
}

function applyAnchorCosMxOrientation(clearExisting=true) {
  updateAnchorOrientationButtons();
  if (!S.anchorCosmxBaseImg) return;
  if (clearExisting) _clearAnchorsForOrientationChange();

  const src = S.anchorCosmxBaseImg;
  const rot = ((S.anchorCosmxRotation % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const outW = swap ? src.naturalHeight : src.naturalWidth;
  const outH = swap ? src.naturalWidth  : src.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');

  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(rot * Math.PI / 180);
  ctx.scale(S.anchorCosmxFlipX ? -1 : 1, S.anchorCosmxFlipY ? -1 : 1);
  ctx.drawImage(src, -src.naturalWidth / 2, -src.naturalHeight / 2);
  ctx.restore();

  const imgEl = document.getElementById('cosmxThumb');
  S.cosmxImgLoaded = false;
  document.getElementById('cosmxLoading').style.display = 'flex';
  imgEl.style.display = 'none';
  imgEl.src = canvas.toDataURL('image/jpeg', 0.92);
  zoomReset('cosmx');
  renderMarkers();
  updateAnchorUI();
}

function onImgLoad(side) {
  document.getElementById(side+'Loading').style.display='none';
  document.getElementById(side+'Thumb').style.display='block';
  if(side==='he') S.heImgLoaded=true;
  if(side==='cosmx') S.cosmxImgLoaded=true;
}
function onImgError(side) {
  document.getElementById(side+'Loading').innerHTML=
    '<span style="color:var(--danger);font-size:0.8rem;">'+side.toUpperCase()+' image failed to load</span>';
}
function getImageCoords(side, e) {
  const wrap=document.getElementById(side+'ImgWrap');
  const img=document.getElementById(side+'Thumb');
  if(!img.naturalWidth)return null;
  const z=ZOOM[side]; const rect=wrap.getBoundingClientRect();
  const natW=img.naturalWidth,natH=img.naturalHeight;
  const conW=wrap.clientWidth,conH=wrap.clientHeight;
  const clickX=e.clientX-rect.left,clickY=e.clientY-rect.top;
  const zoomX=(clickX-z.tx)/z.scale,zoomY=(clickY-z.ty)/z.scale;
  const imgScale=Math.min(conW/natW,conH/natH);
  const imgW=natW*imgScale,imgH=natH*imgScale;
  const offX=(conW-imgW)/2,offY=(conH-imgH)/2;
  if(zoomX<offX||zoomX>offX+imgW||zoomY<offY||zoomY>offY+imgH)return null;
  const x_px=Math.round((zoomX-offX)/imgScale);
  const y_px=Math.round((zoomY-offY)/imgScale);
  const cx=(offX+x_px*imgScale)/conW;
  const cy=(offY+y_px*imgScale)/conH;
  return{x_px,y_px,cx,cy};
}
function _doHEClick(e) {
  if(!S.heImgLoaded)return;
  const coords=getImageCoords('he',e); if(!coords)return;
  S.pendingHE=coords;
  document.getElementById('cosmxImgWrap').classList.add('waiting');
  document.getElementById('heHint').textContent='Anchor placed - click CosMx';
  document.getElementById('cosmxHint').textContent='Click to pair';
  renderMarkers();
}
function _doCosMxClick(e) {
  if(!S.pendingHE||!S.cosmxImgLoaded)return;
  const coords=getImageCoords('cosmx',e); if(!coords)return;
  S.anchorPairs.push({he:S.pendingHE,cosmx:coords});
  S.pendingHE=null;
  document.getElementById('cosmxImgWrap').classList.remove('waiting');
  document.getElementById('heHint').textContent='Click to place anchor';
  document.getElementById('cosmxHint').textContent='Click H&E first';
  renderMarkers(); updateAnchorUI();
}
function renderMarkers() {
  _renderSideMarkers('heZoom','he',true);
  _renderSideMarkers('cosmxZoom','cosmx',false);
}
function _renderSideMarkers(zoomContainerId,side,showPending) {
  const container=document.getElementById(zoomContainerId);
  container.querySelectorAll('.a-marker').forEach(m=>m.remove());
  S.anchorPairs.forEach((pair,i)=>{
    const pt=pair[side];
    const m=document.createElement('div');
    m.className='a-marker '+side+' removable';
    m.textContent=i+1; m.style.left=(pt.cx*100)+'%'; m.style.top=(pt.cy*100)+'%';
    m.title='Click to remove pair '+(i+1);
    m.addEventListener('click',ev=>{ev.stopPropagation();removeAnchorPair(i);});
    container.appendChild(m);
  });
  if(showPending&&S.pendingHE){
    const m=document.createElement('div');
    m.className='a-marker pending'; m.textContent=S.anchorPairs.length+1;
    m.style.left=(S.pendingHE.cx*100)+'%'; m.style.top=(S.pendingHE.cy*100)+'%';
    container.appendChild(m);
  }
}
function removeAnchorPair(idx) {
  S.anchorPairs.splice(idx,1); S.pendingHE=null;
  document.getElementById('cosmxImgWrap').classList.remove('waiting');
  document.getElementById('heHint').textContent='Click to place anchor';
  document.getElementById('cosmxHint').textContent='Click H&E first';
  renderMarkers(); updateAnchorUI();
}
function clearAnchors() {
  S.anchorPairs=[]; S.pendingHE=null;
  document.getElementById('cosmxImgWrap').classList.remove('waiting');
  document.getElementById('heHint').textContent='Click to place anchor';
  document.getElementById('cosmxHint').textContent='Click H&E first';
  renderMarkers(); updateAnchorUI();
}
async function cancelAnchors() {
  if(!confirm('Cancel anchor placement? The pipeline will be aborted.')) return;
  clearAnchors();
  try {
    await apiJSON('/api/registration/cancel', { method: 'POST' });
  } catch(e) {
    console.warn('Cancel API failed:', e);
  }
  goProcessing();
  document.getElementById('procBackBtn').style.display='block';
  appendLog('[CANCELLED] Anchor placement cancelled.');
}

// ===========================================================================
// ADDED: CONFIDENCE THRESHOLD
// ===========================================================================

function bindThresholdControls() {
  const wrap   = document.getElementById('thHistWrap');
  const slider = document.getElementById('threshSlider');
  if (!wrap || wrap.dataset.bound === '1') return;
  wrap.dataset.bound = '1';

  const stop = (e) => {
    // Prevent OpenSeadragon / Annotorious drawing handlers from receiving
    // threshold UI pointer events.
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  };

  let dragging = false;

  const setFromPointer = (e) => {
    if (!TH_BINS.length) return;

    const rect = wrap.getBoundingClientRect();
    let x = e.clientX - rect.left;

    // Prefer Chart.js plot area when available, otherwise use full wrapper.
    let left = 0, right = rect.width;
    if (TH.chart && TH.chart.chartArea) {
      left = TH.chart.chartArea.left;
      right = TH.chart.chartArea.right;
    }

    x = Math.min(Math.max(x, left), right);
    const ratio = (x - left) / Math.max(1, right - left);
    const idx = Math.min(TH_BINS.length - 1, Math.max(0, Math.floor(ratio * TH_BINS.length)));
    const val = TH_BINS[idx]?.mid ?? TH.threshold;

    if (slider) slider.value = Math.round(val * 100);
    thApply(val);
  };

  wrap.addEventListener('pointerdown', (e) => {
    stop(e);
    dragging = true;
    try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
    setFromPointer(e);
  }, true);

  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    stop(e);
    setFromPointer(e);
  }, true);

  const endDrag = (e) => {
    if (!dragging) return;
    stop(e);
    dragging = false;
    try { wrap.releasePointerCapture(e.pointerId); } catch (_) {}
  };

  wrap.addEventListener('pointerup', endDrag, true);
  wrap.addEventListener('pointercancel', endDrag, true);

  // Do not let slider clicks start/continue polygon drawing.
  if (slider && slider.dataset.bound !== '1') {
    slider.dataset.bound = '1';
    ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'click'].forEach(type => {
      slider.addEventListener(type, e => e.stopPropagation(), true);
    });
  }
}

function thImportLymp(gj) {
  TH.features = gj.features || [];
  TH.scores   = TH.features.map(f => {
    const m = f.properties?.measurements;
    if (!Array.isArray(m)) return 1; // polygon-only GeoJSON often has no score; keep visible
    const s = m.find(x => x.name === 'wbf_score');
    return s ? Number(s.value || 0) : 1;
  });
  const names = [...new Set(TH.features.map(f => f.properties?.classification?.name || 'Unknown'))];
  const geomTypes = [...new Set(TH.features.map(f => f.geometry?.type || 'Unknown'))];
  const sel = document.getElementById('thCellType');
  sel.innerHTML = '';
  names.forEach(n => sel.add(new Option(n, n)));
  sel.disabled = false;
  document.getElementById('thNoData').style.display = 'none';
  thBuildHist(TH.scores);
  thApply(TH.threshold);
  statusText(
    'Loaded ' + TH.features.length.toLocaleString() +
    ' features (' + geomTypes.join(', ') + '). ' +
    (geomTypes.every(t => t === 'Point') ? 'Point GeoJSON is displayed as dots.' : 'Polygon GeoJSON is displayed as filled outlines.')
  );
}

function thBuildHist(scores) {
  if (!scores.length) return;
  const mn = Math.min(...scores), mx = Math.max(...scores);
  const N = 20, st = (mx - mn) / N || 0.01;
  TH_BINS = Array.from({length: N}, (_, i) => ({ mid: mn + (i + 0.5) * st, count: 0 }));
  scores.forEach(s => { let i = Math.min(Math.max(Math.floor((s - mn) / st), 0), N - 1); TH_BINS[i].count++; });
  thRenderHist();
}

function thRenderHist() {
  bindThresholdControls();
  const canvas = document.getElementById('thHistCanvas');
  if (!canvas || !TH_BINS.length) return;
  const t  = TH.threshold;
  const bg = TH_BINS.map(b => b.mid >= t ? '#27ae60' : 'rgba(15,52,96,0.65)');
  const plugin = { id:'tl', afterDraw(ch) {
    const {ctx, chartArea, scales} = ch; if (!chartArea) return;
    const {left, right, top, bottom} = chartArea;
    const idx = TH_BINS.findIndex(b => b.mid >= TH.threshold); if (idx < 0) return;
    const ctr = scales.x.getPixelForValue(idx);
    const bw  = Math.abs(scales.x.getPixelForValue(1) - scales.x.getPixelForValue(0));
    const x   = ctr - bw * 0.5;
    ctx.save();
    ctx.fillStyle = 'rgba(39,174,96,0.07)'; ctx.fillRect(x, top, right - x, bottom - top);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom);
    ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 2]); ctx.stroke();
    ctx.fillStyle = '#e74c3c'; ctx.font = 'bold 8px system-ui';
    ctx.textAlign = x > left + 22 ? 'right' : 'left';
    ctx.fillText('\u2265' + TH.threshold.toFixed(2), x > left + 22 ? x - 3 : x + 3, top + 9);
    ctx.restore();
  }};
  if (TH.chart) {
    TH.chart.data.datasets[0].backgroundColor = bg;
    TH.chart.options.scales.y.type = TH.useLog ? 'logarithmic' : 'linear';
    TH.chart.update('none');
    return;
  }
  TH.chart = new Chart(canvas, {
    type: 'bar', plugins: [plugin],
    data: {
      labels: TH_BINS.map(b => b.mid.toFixed(2)),
      datasets: [{ data: TH_BINS.map(b => b.count), backgroundColor: bg, borderRadius:1, barPercentage:0.96, categoryPercentage:0.96 }]
    },
    options: {
      responsive:true, maintainAspectRatio:false, animation:{duration:0},
      plugins: {
        legend:{display:false},
        tooltip:{ callbacks:{
          title: items => 'score \u2248 ' + TH_BINS[items[0].dataIndex]?.mid.toFixed(3),
          label:  item  => item.raw.toLocaleString() + ' cells',
        }, titleFont:{size:10}, bodyFont:{size:10}, padding:5,
           backgroundColor:'#16213e', borderColor:'#0f3460', borderWidth:1 }
      },
      scales: {
        x: { grid:{display:false}, ticks:{color:'#6a8aaa',font:{size:8},maxTicksLimit:6,
              callback:(v,i) => TH_BINS[i] ? TH_BINS[i].mid.toFixed(2) : v} },
        y: { type: TH.useLog ? 'logarithmic':'linear', grid:{color:'rgba(15,52,96,0.5)'},
              ticks:{color:'#6a8aaa',font:{size:8},maxTicksLimit:4,
                     callback:v => v>=1000 ? Math.round(v/1000)+'k' : v} }
      }
    }
  });
  // Threshold interaction is bound once to #thHistWrap by bindThresholdControls().
  // Using the wrapper instead of the canvas keeps the control responsive even
  // when annotation drawing or canvas overlays are active.
}

function thApply(val) {
  TH.threshold = typeof val === 'number' ? val : parseFloat(val);
  document.getElementById('thVal').textContent = TH.threshold.toFixed(2);
  thRenderHist();
  thDrawOverlay();
  const tot = TH.scores.length;
  if (tot) {
    const shown = TH.scores.filter(s => s >= TH.threshold).length;
    document.getElementById('thN').textContent   = shown.toLocaleString();
    document.getElementById('thTot').textContent = tot.toLocaleString();
    document.getElementById('thH').textContent   = (tot - shown).toLocaleString();
  }
}

function thSetPreset(val) {
  TH.threshold = val;
  document.getElementById('threshSlider').value = Math.round(val * 100);
  thApply(val);
}

function thSetScale(type) {
  TH.useLog = type === 'log';
  document.getElementById('thBtnLin').className = TH.useLog ? '' : 'active';
  document.getElementById('thBtnLog').className = TH.useLog ? 'active' : '';
  if (TH.chart) { TH.chart.options.scales.y.type = TH.useLog ? 'logarithmic' : 'linear'; TH.chart.update(); }
}

function thResizeCanvas() {
  const canvas = document.getElementById('lymphOverlay');
  const wrap   = document.getElementById('viewerLeft')?.parentElement;
  if (canvas && wrap) { canvas.width = wrap.clientWidth; canvas.height = wrap.clientHeight; }
  thDrawOverlay();
}

// ===========================================================================
// VIEWER CONTROLS  (Flask web version)
// ===========================================================================

function statusText(msg) {
  const el = document.getElementById('statusText');
  if (el) el.textContent = msg;
}

function populateSlideSelect(slides) {
  const sel = document.getElementById('slideSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select slide...</option>';
  (slides || []).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name || s.id;
    sel.appendChild(opt);
  });
}

// ── Right comparison viewer toggle ─────────────────────────────────────────

function getRightTileSource() {
  if (S.rightBase === 'he') return S.rightHeDzi || getSlideDziUrl(S.current);
  return S.rightCosMxDzi;
}

function updateRightBaseButton() {
  const btn = document.getElementById('btnRightBase');
  const hdr = document.getElementById('rightViewerHdr');
  const isHE = S.rightBase === 'he';

  if (btn) {
    btn.textContent = isHE ? 'Right: H&E' : 'Right: CosMx';
    btn.classList.toggle('on', !isHE);
    btn.title = isHE
      ? 'Click to switch the right comparison viewer back to CosMx'
      : 'Click to compare against original H&E on the right panel';
  }
  if (hdr) {
    hdr.textContent = isHE ? 'H&E Comparison' : 'Spatial Transcriptomics (CosMx)';
  }
}

async function ensureRightCosMxDzi() {
  if (S.rightCosMxDzi) return S.rightCosMxDzi;
  if (!S.current) return null;

  const ci = await apiGetCosmxInfo(S.current.id);
  const info = normalizeCosMxInfo(ci);
  if (info && info.has_cosmx) {
    S.rightCosMxDzi = getCosMxDziUrl(info);
  }
  return S.rightCosMxDzi;
}

function createRightViewer(tileSource) {
  if (!tileSource) return;
  if (S.osdCosMx) {
    S.osdCosMx.destroy();
    S.osdCosMx = null;
  }
  S._syncHE = null; S._syncCosMx = null;
  S.osdCosMx = OpenSeadragon({
    id: 'viewerRight',
    tileSources: tileSource,
    showNavigationControl: false,
    maxZoomPixelRatio: 4,
    gestureSettingsMouse: { clickToZoom: false },
    animationTime: 0.4,
  });
  // CosMx viewport가 실제로 열린 뒤에 transform 적용 + setupSync 등록
  S.osdCosMx.addOnceHandler('open', () => {
    applyCosMxTransform();
    setupSync();
    console.log('[createRightViewer] open complete → transform applied → setupSync registered');
  });
}

async function toggleRightBase() {
  if (!S.current) return;

  const targetBase = S.rightBase === 'cosmx' ? 'he' : 'cosmx';
  let targetTileSource = null;

  if (targetBase === 'cosmx') {
    targetTileSource = await ensureRightCosMxDzi();
    if (!targetTileSource) {
      alert('No CosMx DZI available for this slide. Run tiling first.');
      return;
    }
  } else {
    targetTileSource = S.rightHeDzi || getSlideDziUrl(S.current);
    if (!targetTileSource) {
      alert('Original H&E DZI is not available for this slide.');
      return;
    }
  }

  // If the right panel is hidden, show it before switching.
  if (!S.cosmxVisible) {
    S.cosmxVisible = true;
    const panel = document.getElementById('cosmxPanel');
    if (panel) panel.style.display = 'flex';
    const btnCos = document.getElementById('btnCosMx');
    if (btnCos) {
      btnCos.textContent = 'Window: ON';
      btnCos.classList.add('window-on');
      btnCos.classList.remove('window-off');
    }
  }

  let oldCenter = null, oldZoom = null;
  if (S.osdCosMx) {
    try {
      oldCenter = S.osdCosMx.viewport.getCenter();
      oldZoom = S.osdCosMx.viewport.getZoom();
    } catch(e) {}
  }

  statusText('Switching right viewer to ' + (targetBase === 'cosmx' ? 'CosMx' : 'H&E') + '...');
  S.rightBase = targetBase;
  updateRightBaseButton();

  if (!S.osdCosMx) {
    createRightViewer(targetTileSource);
    setupSync();
    applyCosMxTransform();
    statusText('Right viewer: ' + (S.rightBase === 'cosmx' ? 'CosMx' : 'H&E'));
    return;
  }

  S.osdCosMx.addOnceHandler('open', () => {
    try {
      if (oldCenter && oldZoom) {
        S.osdCosMx.viewport.panTo(oldCenter, true);
        S.osdCosMx.viewport.zoomTo(oldZoom, null, true);
      }
    } catch(e) {
      console.warn('Restore right viewport after switch failed:', e);
    }
    applyCosMxTransform();
    setupSync();
    statusText('Right viewer: ' + (S.rightBase === 'cosmx' ? 'CosMx' : 'H&E'));
  });

  S.osdCosMx.open(targetTileSource);
}

async function onSlideChange(id) {
  const slide = (S.slides || []).find(s => s.id === id);
  if (slide) await loadSlide(slide);
}

async function loadSlide(slide) {
  // Reset slide-specific interaction state before swapping viewers.
  try { if (typeof setMagicWandMode === 'function') setMagicWandMode(false); } catch(e) {}
  try { if (typeof setHEDrawingMode === 'function') setHEDrawingMode(false); } catch(e) {}
  S.magicWandToken++;
  S.magicWandBusy = false;
  S.magicWandHistory = [];
  S.magicWandSeed = null;
  S.magicWandPreviewPolygon = null;
  S.magicWandPreviewMeta = null;
  S.magicWandStrength = 0.0;
  S.magicWandDragging = false;
  S.magicWandDragStartPx = null;
  S.magicWandDragCurrentPx = null;
  S.magicWandActivePointerId = null;
  const undoWandBtn = document.getElementById('btnUndoMagicWand');
  if (undoWandBtn) undoWandBtn.disabled = true;
  const applyWandBtn = document.getElementById('btnApplyMagicWand');
  if (applyWandBtn) applyWandBtn.disabled = true;
  const cancelWandBtn = document.getElementById('btnCancelMagicWand');
  if (cancelWandBtn) cancelWandBtn.disabled = true;

  // New slide must start clean: imported GeoJSON overlays are slide-specific.
  // Otherwise threshold dots/polygons or imported Annotorious SVGs can remain
  // visually on top of the next slide.
  try { if (S.anno && S.anno.destroy) S.anno.destroy(); } catch(e) {}
  S.anno = null;
  S.importedAnnoIds = [];
  if (typeof clearLymphocyteOverlay === 'function') clearLymphocyteOverlay(true);

  S.current = slide;
  await loadHeDziMeta(slide.id);
  S.rightBase = 'cosmx';
  S.rightHeDzi = getSlideDziUrl(slide);
  S.rightCosMxDzi = null;
  S.cosmxTransformPayload = null;
  updateRightBaseButton();
  statusText('Loading ' + (slide.name || slide.id) + '...');

  document.getElementById('emptyState').style.display  = 'none';
  document.getElementById('panelsWrap').style.display  = 'flex';
  document.getElementById('viewerSlideChip').textContent = slide.name || slide.id;

  try { if (typeof detachMagicWandDragTracking === 'function') detachMagicWandDragTracking(); } catch(e) {}
  try { if (typeof detachLassoPointerTracking === 'function') detachLassoPointerTracking(); } catch(e) {}
  if (S.osdHE)    { S.osdHE.destroy();    S.osdHE    = null; }
  if (S.osdCosMx) { S.osdCosMx.destroy(); S.osdCosMx = null; }
  S._syncHE = null; S._syncCosMx = null;

  S.osdHE = OpenSeadragon({
    id: 'viewerLeft',
    tileSources: S.rightHeDzi || slide.dzi_url,
    showNavigator: true, navigatorPosition: 'BOTTOM_RIGHT',
    showNavigationControl: false,
    maxZoomPixelRatio: 4, minZoomImageRatio: 0.8,
    gestureSettingsMouse: { clickToZoom: false },
    animationTime: 0.4,
  });

  // Annotorious with class-color formatter
  try {
    S.anno = OpenSeadragon.Annotorious(S.osdHE, {
      allowEmpty: true,
      drawOnSingleClick: false,
      disableEditor: true,
      formatter: annoFormatter
    });
    S.anno.on('deleteAnnotation', () => updateAnnoCount(-1));
    // Restore saved annotations
    const saved = localStorage.getItem('anno_' + slide.id);
    if (saved) {
      try { JSON.parse(saved).forEach(a => S.anno.addAnnotation(a)); } catch(e) {}
    }
    S.annoCount = S.anno.getAnnotations().length;
    document.getElementById('annoCount').textContent = S.annoCount;

    // ADDED: polygon drawing support
    S.anno.setDrawingTool('polygon');
    S.anno.setDrawingEnabled(false);
    S.drawLabel = S.drawLabel || 'tumor';
    setDrawLabel(S.drawLabel);

    S.anno.on('createAnnotation', (anno) => {
      const cls = normalizeAnnoClassName(S.drawLabel || 'tumor');
      const labeled = {
        ...anno,
        body: [{ type: 'TextualBody', purpose: 'tagging', value: cls }],
        properties: { ...(anno.properties || {}), label: cls }
      };

      // Re-add once with a stable tagging body. Avoid repeated setAnnotations(),
      // because it can confuse Annotorious drawing state after several polygons.
      try { S.anno.removeAnnotation(anno.id); } catch(e) {}
      setTimeout(() => {
        try {
          S.anno.addAnnotation(labeled);
          updateAnnoCount(1);
          console.log('✅ Created:', cls);
        } catch(e) {
          console.warn('add labeled annotation failed:', e);
        }
      }, 0);

      setHEDrawingMode(false);
    });
  } catch(e) { console.warn('Annotorious init:', e); }

  // Lymphocyte overlay handlers
  S.osdHE.addHandler('viewport-change',  thDrawOverlay);
  S.osdHE.addHandler('animation-finish', thDrawOverlay);
  S.osdHE.addHandler('open', thResizeCanvas);

  // Magic Wand uses a normal OpenSeadragon click, converts it to image pixels,
  // and asks the backend to segment only a small local H&E patch.
  attachMagicWandDragTracking();
  S.osdHE.addHandler('viewport-change', renderMagicWandPreview);
  attachLassoPointerTracking();

  // Load right comparison viewer.
  // Backend now returns the original CosMx DZI, while transform_registered.json
  // is applied in OpenSeadragon so sparse registered DZI tile gaps do not cause 404s.
  try {
    const ci = await apiGetCosmxInfo(slide.id);
    const info = normalizeCosMxInfo(ci);
    if (info && info.has_cosmx) {
      S.rightCosMxDzi = getCosMxDziUrl(info);
    }

    S.cosmxTransformPayload = await apiGetCosmxTransform(slide.id);
    _loadCosMxTransformIntoControls(S.cosmxTransformPayload);

    const rightTileSource = getRightTileSource();
    if (rightTileSource && S.cosmxVisible) {
      createRightViewer(rightTileSource);
    }
  } catch(e) { console.warn('Right viewer load:', e); }

  updateRightBaseButton();

  // Restore CosMx alignment and QC
  _restoreCosMxAdjustment(JSON.parse(localStorage.getItem('cosmx_adj_' + slide.id) || '{}'));
  _updateQCBadge(localStorage.getItem('qc_' + slide.id) || '');

  // setupSync는 createRightViewer의 open 콜백에서 호출됨
  statusText('Ready: ' + (slide.name || slide.id));
}


function updateAnnoCount(delta) {
  refreshAnnotationCountAndSave();
}

// ── Panel sync ────────────────────────────────────────────────────────────

function syncCaptureLeftState() {
  if (!S.osdHE || !S.osdHE.viewport) {
    S._syncLast = null;
    return;
  }
  S._syncLast = {
    center: S.osdHE.viewport.getCenter().clone(),
    zoom:   S.osdHE.viewport.getZoom()
  };
}

function setupSync() {
  // One-way delta sync only: H&E -> right panel.
  // Important: this does NOT copy H&E absolute center/zoom to CosMx.
  // The right panel keeps its current location, then follows only the
  // movement/zoom changes made on the left after Sync is turned ON.
  if (S.osdHE && S._syncHE) {
    S.osdHE.removeHandler('viewport-change', S._syncHE);
    S._syncHE = null;
  }

  S._syncCosMx = null;   // legacy right-to-left sync disabled on purpose
  S.syncing = false;

  if (!S.syncEnabled || !S.osdHE || !S.osdCosMx) {
    syncCaptureLeftState();
    return;
  }

  // Capture baseline at the moment sync becomes active.
  // This prevents the right panel from jumping to the left panel's location.
  syncCaptureLeftState();

  S._syncHE = () => {
    if (!S.syncEnabled || S.syncing || !S.osdHE || !S.osdCosMx) return;
    if (!S.osdHE.viewport || !S.osdCosMx.viewport) return;

    const curCenter = S.osdHE.viewport.getCenter();
    const curZoom   = S.osdHE.viewport.getZoom();

    if (!S._syncLast) {
      syncCaptureLeftState();
      return;
    }

    const prevCenter = S._syncLast.center;
    const prevZoom   = S._syncLast.zoom;
    const dx = curCenter.x - prevCenter.x;
    const dy = curCenter.y - prevCenter.y;
    const zoomRatio = prevZoom > 0 ? curZoom / prevZoom : 1;

    // Update baseline before moving the right panel, so repeated OSD events
    // cannot reuse the same delta.
    S._syncLast = { center: curCenter.clone(), zoom: curZoom };

    if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12 && Math.abs(zoomRatio - 1) < 1e-9) return;

    S.syncing = true;
    try {
      const rv = S.osdCosMx.viewport;
      const rc = rv.getCenter();
      const rz = rv.getZoom();
      const nextCenter = new OpenSeadragon.Point(rc.x + dx, rc.y + dy);
      const nextZoom   = rz * zoomRatio;

      rv.zoomTo(nextZoom, null, true);
      rv.panTo(nextCenter, true);
    } finally {
      S.syncing = false;
    }
  };

  S.osdHE.addHandler('viewport-change', S._syncHE);
}

function toggleSync() {
  S.syncEnabled = !S.syncEnabled;

  const btn = document.getElementById('btnSync');
  if (btn) {
    btn.textContent = 'Sync: ' + (S.syncEnabled ? 'ON' : 'OFF');
    btn.classList.toggle('on', S.syncEnabled);
  }

  const st = document.getElementById('syncStatus');
  if (st) {
    st.textContent = S.syncEnabled
      ? 'Following H&E movement only'
      : 'Independent panels';
  }

  setupSync();
}

function resyncPanels() {
  // New behavior: do not force CosMx to H&E coordinates.
  // Just reset the baseline, so the next left-panel movement is followed
  // from the right panel's current position.
  syncCaptureLeftState();
  const st = document.getElementById('syncStatus');
  if (st) st.textContent = S.syncEnabled ? 'Sync baseline reset' : 'Independent panels';
}

function toggleCosMx() {
  S.cosmxVisible = !S.cosmxVisible;
  const btn = document.getElementById('btnCosMx');
  if (btn) {
    btn.textContent = 'Window: ' + (S.cosmxVisible ? 'ON' : 'OFF');
    btn.classList.toggle('window-on', S.cosmxVisible);
    btn.classList.toggle('window-off', !S.cosmxVisible);
  }
  const panel = document.getElementById('cosmxPanel');
  if (panel) panel.style.display = S.cosmxVisible ? 'flex' : 'none';

  if (S.cosmxVisible && !S.osdCosMx) {
    const ts = getRightTileSource();
    if (ts) createRightViewer(ts);
    setupSync();
    applyCosMxTransform();
  }
}


function toggleSidePanel() {
  const p = document.getElementById('sidePanel');
  const e = document.getElementById('expandBtn');
  if (!p) return;
  const collapsed = p.classList.toggle('collapsed');
  if (e) e.style.display = collapsed ? 'block' : 'none';
}

// ── QC ────────────────────────────────────────────────────────────────────

function setQC(status) {
  if (!S.current) return;
  localStorage.setItem('qc_' + S.current.id, status);
  _updateQCBadge(status);
}

function _updateQCBadge(s) {
  const b = document.getElementById('qcBadge');
  if (!b) return;
  b.className = 'qc-badge' + (s ? ' ' + s : '');
  b.textContent = s ? (s === 'approved' ? 'Approved' : 'Rejected') : 'Unreviewed';
}

// ── ADDED: Draw Annotation (polygon) controls ──────────────────────────────

function setDrawLabel(label) {
  S.drawLabel = label;
  ['tumor', 'stroma', 'other', 'lymphocyte'].forEach(l => {
    const b = document.getElementById('btnDrawLabel-' + l);
    if (b) b.classList.toggle('on', l === label);
  });
}

function setHEDrawingMode(enabled) {
  if (!S.anno) return;
  const btn = document.getElementById('btnDrawPolygon');

  // Drawing and OpenSeadragon pan must be mutually exclusive.
  if (S.osdHE?.gestureSettingsMouse) {
    S.osdHE.gestureSettingsMouse.clickToZoom = false;
    S.osdHE.gestureSettingsMouse.dragToPan = !enabled;
  }

  try {
    S.anno.setDrawingTool('polygon');
    S.anno.setDrawingEnabled(!!enabled);
  } catch(e) {
    console.warn('setHEDrawingMode failed:', e);
  }

  if (btn) {
    btn.classList.toggle('on', !!enabled);
    btn.textContent = enabled ? 'Drawing… double-click to finish' : 'Draw Polygon';
  }
}

function toggleDrawPolygon() {
  if (!S.anno) return;
  const btn = document.getElementById('btnDrawPolygon');
  const enabling = !(btn && btn.classList.contains('on'));

  // Polygon drawing and Magic Wand are mutually exclusive.
  if (enabling && S.magicWandEnabled) setMagicWandMode(false);

  setHEDrawingMode(false);
  if (enabling) setTimeout(() => setHEDrawingMode(true), 0);
}


// ── ADDED: Magic Wand annotation tool ──────────────────────────────────────

function _updateMagicWandActionButtons() {
  const hasPreview = Array.isArray(S.magicWandPreviewPolygon) && S.magicWandPreviewPolygon.length >= 3;
  const applyBtn = document.getElementById('btnApplyMagicWand');
  const cancelBtn = document.getElementById('btnCancelMagicWand');
  if (applyBtn) applyBtn.disabled = !hasPreview;
  if (cancelBtn) cancelBtn.disabled = !hasPreview;
  _updateMagicWandUndoButton();
}

function _magicWandOriginalToCanvasPoint(xOriginal, yOriginal) {
  if (!S.osdHE) return null;
  const tiledImage = S.osdHE.world?.getItemAt(0);
  if (!tiledImage) return null;

  const ds = Number(S.heDziDownsample || 1);
  const xDzi = Number(xOriginal) / ds;
  const yDzi = Number(yOriginal) / ds;
  if (!Number.isFinite(xDzi) || !Number.isFinite(yDzi)) return null;

  const vp = tiledImage.imageToViewportCoordinates(xDzi, yDzi);
  const px = S.osdHE.viewport.pixelFromPoint(vp, true);
  return { x: Number(px.x), y: Number(px.y) };
}

function _magicWandStrengthLabel(strength) {
  const s = Math.max(0, Math.min(1, Number(strength) || 0));
  if (s < 0.22) return 'Small';
  if (s < 0.48) return 'Medium';
  if (s < 0.75) return 'Large';
  return 'Very Large';
}

function _setMagicWandStrengthUI(strength, dragging = false) {
  const s = Math.max(0, Math.min(1, Number(strength) || 0));
  const el = document.getElementById('magicWandStrength');
  if (!el) return;
  const pct = Math.round(s * 100);
  el.textContent = dragging
    ? `Selection strength: ${_magicWandStrengthLabel(s)} (${pct}%)`
    : (S.magicWandSeed
        ? `Selection strength: ${_magicWandStrengthLabel(s)} (${pct}%)`
        : 'Selection strength: —');
}

function clearMagicWandSelection(resetSeed = true) {
  S.magicWandToken++;
  S.magicWandPreviewPolygon = null;
  S.magicWandPreviewMeta = null;
  S.magicWandDragging = false;
  S.magicWandDragStartPx = null;
  S.magicWandDragCurrentPx = null;
  if (resetSeed) {
    S.magicWandSeed = null;
    S.magicWandStrength = 0.0;
  }

  const svg = document.getElementById('magicWandOverlay');
  if (svg) svg.replaceChildren();

  _setMagicWandStrengthUI(S.magicWandStrength, false);
  _updateMagicWandActionButtons();
}

function renderMagicWandPreview() {
  const svg = document.getElementById('magicWandOverlay');
  if (!svg) return;

  const rect = svg.getBoundingClientRect();
  const w = Math.max(1, rect.width || svg.clientWidth || 1);
  const h = Math.max(1, rect.height || svg.clientHeight || 1);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.replaceChildren();

  const poly = S.magicWandPreviewPolygon;
  if (Array.isArray(poly) && poly.length >= 3) {
    const pts = [];
    for (const p of poly) {
      const q = _magicWandOriginalToCanvasPoint(p?.[0], p?.[1]);
      if (q && Number.isFinite(q.x) && Number.isFinite(q.y)) {
        pts.push(`${q.x.toFixed(2)},${q.y.toFixed(2)}`);
      }
    }
    if (pts.length >= 3) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      el.setAttribute('points', pts.join(' '));
      svg.appendChild(el);
    }
  }

  if (S.magicWandSeed) {
    const seedPx = _magicWandOriginalToCanvasPoint(S.magicWandSeed.x, S.magicWandSeed.y);
    if (seedPx) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', seedPx.x);
      c.setAttribute('cy', seedPx.y);
      c.setAttribute('r', '4.25');
      svg.appendChild(c);
    }
  }

  if (S.magicWandDragging && S.magicWandDragStartPx && S.magicWandDragCurrentPx) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', S.magicWandDragStartPx.x);
    line.setAttribute('y1', S.magicWandDragStartPx.y);
    line.setAttribute('x2', S.magicWandDragCurrentPx.x);
    line.setAttribute('y2', S.magicWandDragCurrentPx.y);
    svg.appendChild(line);
  }
}

function _magicWandCanvasToOriginal(x, y) {
  if (!S.osdHE) return null;
  const tiledImage = S.osdHE.world?.getItemAt(0);
  if (!tiledImage) return null;

  const vp = S.osdHE.viewport.pointFromPixel(new OpenSeadragon.Point(x, y));
  const imgPt = tiledImage.viewportToImageCoordinates(vp);
  const ds = Number(S.heDziDownsample || 1);
  const ox = Number(imgPt.x) * ds;
  const oy = Number(imgPt.y) * ds;
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) return null;
  return { x: ox, y: oy };
}

function _magicWandStrengthFromDrag(dx, dy) {
  // Screen-space drag distance controls selection breadth.
  // ~180 px reaches maximum strength. Direction does not matter.
  const d = Math.hypot(Number(dx) || 0, Number(dy) || 0);
  return Math.max(0, Math.min(1, d / 180));
}

function detachMagicWandDragTracking() {
  const t = S.magicWandPointerTarget;
  if (t && S.magicWandPointerDownHandler) {
    t.removeEventListener('pointerdown', S.magicWandPointerDownHandler, true);
  }
  if (t && S.magicWandPointerMoveHandler) {
    t.removeEventListener('pointermove', S.magicWandPointerMoveHandler, true);
  }
  if (S.magicWandPointerUpHandler) {
    window.removeEventListener('pointerup', S.magicWandPointerUpHandler, true);
    window.removeEventListener('pointercancel', S.magicWandPointerUpHandler, true);
  }

  S.magicWandPointerTarget = null;
  S.magicWandPointerDownHandler = null;
  S.magicWandPointerMoveHandler = null;
  S.magicWandPointerUpHandler = null;
  S.magicWandActivePointerId = null;
}

function attachMagicWandDragTracking() {
  detachMagicWandDragTracking();
  if (!S.osdHE) return;

  const target = S.osdHE.container || document.getElementById('viewerLeft');
  if (!target) return;

  const down = (ev) => {
    if (!S.magicWandEnabled || !S.current || !S.anno || ev.button !== 0) return;
    if (S.magicWandBusy) return;

    const rect = target.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;

    const seed = _magicWandCanvasToOriginal(x, y);
    if (!seed) return;

    ev.preventDefault();
    ev.stopPropagation();
    S.magicWandActivePointerId = ev.pointerId;
    try { S.osdHE.setMouseNavEnabled(false); } catch(e) {}

    S.magicWandToken++;
    S.magicWandSeed = seed;
    S.magicWandPreviewPolygon = null;
    S.magicWandPreviewMeta = null;
    S.magicWandStrength = 0.0;
    S.magicWandDragging = true;
    S.magicWandDragStartPx = { x, y };
    S.magicWandDragCurrentPx = { x, y };

    _setMagicWandStrengthUI(0, true);
    _updateMagicWandActionButtons();
    renderMagicWandPreview();

    const hint = document.getElementById('magicWandHint');
    if (hint) hint.textContent = 'Drag farther to expand the selection range. Release to calculate the preview.';
    statusText('Magic Wand — drag farther for a broader selection');
  };

  const move = (ev) => {
    if (!S.magicWandEnabled || !S.magicWandDragging || !S.magicWandDragStartPx) return;
    if (S.magicWandActivePointerId !== null && ev.pointerId !== S.magicWandActivePointerId) return;

    const rect = target.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;

    ev.preventDefault();
    ev.stopPropagation();

    S.magicWandDragCurrentPx = { x, y };
    const dx = x - S.magicWandDragStartPx.x;
    const dy = y - S.magicWandDragStartPx.y;
    S.magicWandStrength = _magicWandStrengthFromDrag(dx, dy);

    _setMagicWandStrengthUI(S.magicWandStrength, true);
    renderMagicWandPreview();
  };

  const up = (ev) => {
    if (!S.magicWandEnabled || !S.magicWandDragging) return;
    if (S.magicWandActivePointerId !== null && ev?.pointerId != null && ev.pointerId !== S.magicWandActivePointerId) return;

    ev?.preventDefault?.();
    ev?.stopPropagation?.();

    S.magicWandDragging = false;
    S.magicWandActivePointerId = null;
    try { S.osdHE.setMouseNavEnabled(true); } catch(e) {}

    S.magicWandStrength = Math.max(0.18, Math.min(1, Number(S.magicWandStrength) || 0));
    _setMagicWandStrengthUI(S.magicWandStrength, false);
    renderMagicWandPreview();

    const hint = document.getElementById('magicWandHint');
    if (hint) hint.textContent = 'Calculating selection from drag strength…';

    refreshMagicWandSelectionFromSeed();
  };

  target.addEventListener('pointerdown', down, true);
  target.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);

  S.magicWandPointerTarget = target;
  S.magicWandPointerDownHandler = down;
  S.magicWandPointerMoveHandler = move;
  S.magicWandPointerUpHandler = up;
}

function setMagicWandMode(enabled) {
  S.magicWandEnabled = !!enabled;
  const btn = document.getElementById('btnMagicWand');
  const hint = document.getElementById('magicWandHint');

  if (enabled) {
    setHEDrawingMode(false);
    if (S.lassoEnabled) {
      try { toggleLassoMode(); } catch(e) {}
    }
  } else {
    clearMagicWandSelection(true);
    try { S.osdHE?.setMouseNavEnabled(true); } catch(e) {}
  }

  if (S.osdHE?.gestureSettingsMouse) {
    S.osdHE.gestureSettingsMouse.clickToZoom = false;
    S.osdHE.gestureSettingsMouse.dragToPan = true;
  }

  const viewer = document.getElementById('viewerLeft');
  if (viewer) viewer.style.cursor = enabled ? 'crosshair' : '';

  if (btn) {
    btn.classList.toggle('on', !!enabled);
    btn.textContent = enabled ? 'Magic Wand: ON' : 'Magic Wand';
  }

  if (hint) {
    hint.textContent = enabled
      ? 'Press inside visible tissue and drag. Longer drag = broader contiguous color selection. Release to preview.'
      : 'Select a class, enable Magic Wand, then press-drag inside the H&E region.';
  }

  _setMagicWandStrengthUI(0, false);
  _updateMagicWandActionButtons();
  statusText(enabled ? 'Magic Wand enabled — press and drag inside tissue' : 'Magic Wand disabled');
}

function toggleMagicWand() {
  if (!S.anno || !S.osdHE || !S.current) {
    statusText('Load a slide before using Magic Wand');
    return;
  }
  setMagicWandMode(!S.magicWandEnabled);
}

async function refreshMagicWandSelectionFromSeed() {
  if (!S.magicWandEnabled || !S.osdHE || !S.current || !S.anno || !S.magicWandSeed) return;
  if (S.magicWandBusy) return;

  const token = ++S.magicWandToken;
  const strength = Math.max(0.18, Math.min(1, Number(S.magicWandStrength) || 0));

  try {
    S.magicWandBusy = true;
    statusText('Magic Wand selecting visible H&E region...');
    const hint = document.getElementById('magicWandHint');
    if (hint) hint.textContent = 'Calculating selection from the visible H&E image…';

    // Frontend-only wand: use pixels already rendered by OpenSeadragon.
    // No backend Magic Wand call and no original SVS/TIFF path are required.
    const sourceCanvas =
      S.osdHE?.drawer?.canvas ||
      S.osdHE?.drawer?.context?.canvas ||
      S.osdHE?.container?.querySelector('canvas');

    if (!sourceCanvas || !sourceCanvas.width || !sourceCanvas.height) {
      throw new Error('H&E viewer canvas is not available yet. Wait for the slide to finish loading.');
    }

    const viewerEl = S.osdHE.container || document.getElementById('viewerLeft');
    const viewerRect = viewerEl.getBoundingClientRect();
    if (!viewerRect.width || !viewerRect.height) {
      throw new Error('H&E viewer size is unavailable.');
    }

    const seedCss = _magicWandOriginalToCanvasPoint(S.magicWandSeed.x, S.magicWandSeed.y);
    if (!seedCss) throw new Error('Could not map the Magic Wand seed to the viewer.');

    const maxWorkDim = 650;
    const srcW = sourceCanvas.width;
    const srcH = sourceCanvas.height;
    const workScale = Math.min(1, maxWorkDim / Math.max(srcW, srcH));
    const workW = Math.max(1, Math.round(srcW * workScale));
    const workH = Math.max(1, Math.round(srcH * workScale));

    const work = document.createElement('canvas');
    work.width = workW;
    work.height = workH;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not create Magic Wand work canvas.');

    ctx.drawImage(sourceCanvas, 0, 0, srcW, srcH, 0, 0, workW, workH);
    const imageData = ctx.getImageData(0, 0, workW, workH);
    const pix = imageData.data;

    const cssToSourceX = srcW / viewerRect.width;
    const cssToSourceY = srcH / viewerRect.height;
    const sx = Math.max(0, Math.min(workW - 1, Math.round(seedCss.x * cssToSourceX * workScale)));
    const sy = Math.max(0, Math.min(workH - 1, Math.round(seedCss.y * cssToSourceY * workScale)));

    const seedIdx = (sy * workW + sx) * 4;
    const sr = pix[seedIdx], sg = pix[seedIdx + 1], sb = pix[seedIdx + 2];

    // Longer drag = wider RGB similarity and larger allowed growth radius.
    const colorThreshold = 24 + 86 * strength;
    const colorThreshold2 = colorThreshold * colorThreshold;
    const maxRadiusCss = 45 + 315 * strength;

    const maxRadiusWorkX = maxRadiusCss * cssToSourceX * workScale;
    const maxRadiusWorkY = maxRadiusCss * cssToSourceY * workScale;
    const invRx2 = 1 / Math.max(1, maxRadiusWorkX * maxRadiusWorkX);
    const invRy2 = 1 / Math.max(1, maxRadiusWorkY * maxRadiusWorkY);

    const total = workW * workH;
    const visited = new Uint8Array(total);
    const selected = new Uint8Array(total);
    const qx = new Int32Array(total);
    const qy = new Int32Array(total);
    let head = 0, tail = 0;

    qx[tail] = sx;
    qy[tail] = sy;
    tail++;
    visited[sy * workW + sx] = 1;

    let selectedCount = 0;
    const maxPixels = Math.min(total, 260000);

    while (head < tail && selectedCount < maxPixels) {
      const x = qx[head];
      const y = qy[head];
      head++;

      const ex = x - sx, ey = y - sy;
      if ((ex * ex) * invRx2 + (ey * ey) * invRy2 > 1.0) continue;

      const i = (y * workW + x) * 4;
      const r = pix[i], g = pix[i + 1], b = pix[i + 2];
      const dr = r - sr, dg = g - sg, db = b - sb;
      if (dr * dr + dg * dg + db * db > colorThreshold2) continue;

      const flat = y * workW + x;
      if (selected[flat]) continue;
      selected[flat] = 1;
      selectedCount++;

      if (x > 0) {
        const n = flat - 1;
        if (!visited[n]) { visited[n] = 1; qx[tail] = x - 1; qy[tail] = y; tail++; }
      }
      if (x + 1 < workW) {
        const n = flat + 1;
        if (!visited[n]) { visited[n] = 1; qx[tail] = x + 1; qy[tail] = y; tail++; }
      }
      if (y > 0) {
        const n = flat - workW;
        if (!visited[n]) { visited[n] = 1; qx[tail] = x; qy[tail] = y - 1; tail++; }
      }
      if (y + 1 < workH) {
        const n = flat + workW;
        if (!visited[n]) { visited[n] = 1; qx[tail] = x; qy[tail] = y + 1; tail++; }
      }
    }

    if (token !== S.magicWandToken) return;

    if (selectedCount < 18) {
      clearMagicWandSelection(false);
      if (hint) hint.textContent = 'Selection was too small. Start farther inside tissue or drag farther.';
      statusText('Magic Wand selection was too small');
      return;
    }

    const bins = 96;
    const farthest = new Array(bins).fill(null);
    const farthestD2 = new Float64Array(bins);

    for (let y = 1; y < workH - 1; y++) {
      for (let x = 1; x < workW - 1; x++) {
        const flat = y * workW + x;
        if (!selected[flat]) continue;

        if (selected[flat - 1] && selected[flat + 1] &&
            selected[flat - workW] && selected[flat + workW]) continue;

        const dx = x - sx, dy = y - sy;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1) continue;

        let a = Math.atan2(dy, dx);
        if (a < 0) a += Math.PI * 2;
        let bin = Math.floor(a / (Math.PI * 2) * bins);
        if (bin >= bins) bin = bins - 1;

        if (d2 > farthestD2[bin]) {
          farthestD2[bin] = d2;
          farthest[bin] = { x, y };
        }
      }
    }

    let contour = farthest.filter(Boolean);
    if (contour.length < 8) {
      clearMagicWandSelection(false);
      if (hint) hint.textContent = 'Could not form a stable boundary. Try a slightly longer drag.';
      statusText('Magic Wand could not form a stable boundary');
      return;
    }

    for (let i = 0; i < bins; i++) {
      if (farthest[i]) continue;
      let prev = null, next = null;

      for (let d = 1; d < bins; d++) {
        const pi = (i - d + bins) % bins;
        if (farthest[pi]) { prev = farthest[pi]; break; }
      }
      for (let d = 1; d < bins; d++) {
        const ni = (i + d) % bins;
        if (farthest[ni]) { next = farthest[ni]; break; }
      }

      if (prev && next) {
        farthest[i] = { x: (prev.x + next.x) / 2, y: (prev.y + next.y) / 2 };
      } else {
        farthest[i] = prev || next;
      }
    }

    contour = farthest.filter(Boolean);

    for (let pass = 0; pass < 2; pass++) {
      contour = contour.map((p, i, arr) => {
        const a = arr[(i - 1 + arr.length) % arr.length];
        const b = arr[(i + 1) % arr.length];
        return {
          x: (a.x + 2 * p.x + b.x) / 4,
          y: (a.y + 2 * p.y + b.y) / 4
        };
      });
    }

    const polyOriginal = [];
    for (const p of contour) {
      const sourceX = p.x / workScale;
      const sourceY = p.y / workScale;
      const cssX = sourceX / cssToSourceX;
      const cssY = sourceY / cssToSourceY;
      const q = _magicWandCanvasToOriginal(cssX, cssY);

      if (q && Number.isFinite(q.x) && Number.isFinite(q.y)) {
        polyOriginal.push([q.x, q.y]);
      }
    }

    if (polyOriginal.length < 8) {
      clearMagicWandSelection(false);
      throw new Error('Magic Wand boundary conversion failed.');
    }

    S.magicWandPreviewPolygon = polyOriginal;
    S.magicWandPreviewMeta = {
      tolerance: colorThreshold,
      wand_strength: strength,
      level_downsample: 0,
      analysis_level: -1,
      seed_x_level0: Number(S.magicWandSeed.x),
      seed_y_level0: Number(S.magicWandSeed.y),
      algorithm: 'visible_viewport_rgb_flood_v1',
      parameters: {
        source: 'openseadragon_rendered_canvas',
        color_threshold_rgb: Number(colorThreshold.toFixed(2)),
        max_radius_css: Number(maxRadiusCss.toFixed(1)),
        selected_pixels: selectedCount,
        work_width: workW,
        work_height: workH
      }
    };

    renderMagicWandPreview();
    _updateMagicWandActionButtons();

    if (hint) hint.textContent = 'Selection ready. Apply it, or Cancel and drag shorter/farther to try again.';
    statusText(`Magic Wand preview ready — ${selectedCount.toLocaleString()} sampled pixels`);

  } catch (e) {
    console.error('Magic Wand failed:', e);
    clearMagicWandSelection(false);
    const hint = document.getElementById('magicWandHint');
    if (hint) hint.textContent = 'Magic Wand failed on the visible image. Try again after the slide finishes loading.';
    statusText('Magic Wand: ' + (e?.message || 'selection failed'));
  } finally {
    if (token === S.magicWandToken) S.magicWandBusy = false;
  }
}

async function applyMagicWandSelection() {
  if (!S.anno || !S.magicWandPreviewPolygon || S.magicWandPreviewPolygon.length < 3) {
    statusText('No Magic Wand preview to apply');
    return;
  }

  const cls = normalizeAnnoClassName(_lassoSelectedClass() || S.drawLabel || 'tumor');
  const meta = S.magicWandPreviewMeta || {};
  const ann = _magicWandAnnotationFromPolygon(S.magicWandPreviewPolygon, cls, meta);
  if (!ann) {
    statusText('Magic Wand preview could not be converted to an annotation');
    return;
  }

  try {
    S.anno.addAnnotation(ann);
    S.magicWandHistory.push({ id: ann.id, slideId: S.current?.id || '' });
    updateAnnoCount(1);
    clearMagicWandSelection(true);
    _updateMagicWandUndoButton();

    const hint = document.getElementById('magicWandHint');
    if (hint) hint.textContent = 'Applied. Press-drag another tissue region to start a new Magic Wand selection.';
    statusText('Magic Wand annotation added: ' + cls);
  } catch (e) {
    console.warn('Magic Wand apply failed:', e);
    statusText('Could not apply Magic Wand selection');
  }
}

function cancelMagicWandSelection() {
  clearMagicWandSelection(true);
  const hint = document.getElementById('magicWandHint');
  if (hint && S.magicWandEnabled) {
    hint.textContent = 'Selection cleared. Press-drag inside tissue to start again.';
  }
  statusText('Magic Wand selection cleared');
}



function _lassoSelectedClass() {
  return (typeof currentDrawLabel === 'string' && currentDrawLabel) ||
         S.drawLabel ||
         document.querySelector('[id^="btnDrawLabel-"].on')?.dataset?.label ||
         null;
}

function _lassoCanvasPointToOriginal(x, y) {
  if (!S.osdHE) return null;
  const tiledImage = S.osdHE.world?.getItemAt(0);
  if (!tiledImage) return null;

  const vp = S.osdHE.viewport.pointFromPixel(new OpenSeadragon.Point(x, y));
  const imgPt = tiledImage.viewportToImageCoordinates(vp);
  const ds = Number(S.heDziDownsample || 1);
  const ox = Number(imgPt.x) * ds;
  const oy = Number(imgPt.y) * ds;
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) return null;
  return [ox, oy];
}

function _lassoOriginalToDziPoint(x, y) {
  const ds = Number(S.heDziDownsample || 1);
  return [Number(x) / ds, Number(y) / ds];
}

function _renderLassoPath() {
  const svg = document.getElementById('lassoOverlay');
  if (!svg) return;

  const rect = svg.getBoundingClientRect();
  const w = Math.max(1, rect.width || svg.clientWidth || 1);
  const h = Math.max(1, rect.height || svg.clientHeight || 1);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.replaceChildren();

  if (!S.lassoDrawing || !Array.isArray(S.lassoPoints) || S.lassoPoints.length < 2) return;

  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute(
    'points',
    S.lassoPoints.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
  );
  svg.appendChild(poly);
}

function _clearLassoPath() {
  S.lassoDrawing = false;
  S.lassoPoints = [];
  const svg = document.getElementById('lassoOverlay');
  if (svg) svg.replaceChildren();
}

function toggleLassoMode() {
  const next = !S.lassoEnabled;
  S.lassoEnabled = next;

  // Do not let Polygon draw mode and Lasso fight over pointer input.
  if (next && S.drawMode) {
    try { toggleDrawPolygon(); } catch(e) {}
  }
  if (next && S.magicWandEnabled) {
    try { setMagicWandMode(false); } catch(e) {}
  }

  const btn = document.getElementById('btnLasso');
  if (btn) btn.classList.toggle('on', next);

  const viewer = document.getElementById('viewerLeft');
  if (viewer) viewer.classList.toggle('lasso-active', next);

  const hint = document.getElementById('lassoHint');
  if (hint) {
    hint.textContent = next
      ? 'Drag around the region and release. The outline will close automatically; click the annotation afterward to edit vertices.'
      : 'Select a class, enable Freehand Lasso, then drag around the region and release to create a polygon.';
  }

  if (!next) _clearLassoPath();
  statusText(next ? 'Freehand Lasso enabled — drag around a region' : 'Freehand Lasso disabled');
}

function detachLassoPointerTracking() {
  const t = S.lassoPointerTarget;
  if (!t) return;
  if (S.lassoDownHandler) t.removeEventListener('pointerdown', S.lassoDownHandler, true);
  if (S.lassoMoveHandler) t.removeEventListener('pointermove', S.lassoMoveHandler, true);
  if (S.lassoUpHandler) {
    window.removeEventListener('pointerup', S.lassoUpHandler, true);
    window.removeEventListener('pointercancel', S.lassoUpHandler, true);
  }
  if (S.lassoCancelHandler) window.removeEventListener('blur', S.lassoCancelHandler, true);

  S.lassoPointerTarget = null;
  S.lassoDownHandler = null;
  S.lassoMoveHandler = null;
  S.lassoUpHandler = null;
  S.lassoCancelHandler = null;
}

function attachLassoPointerTracking() {
  detachLassoPointerTracking();
  if (!S.osdHE) return;

  const target = S.osdHE.container || document.getElementById('viewerLeft');
  if (!target) return;

  const down = (ev) => {
    if (!S.lassoEnabled || !S.current || !S.anno) return;
    if (ev.button !== 0) return;

    const cls = _lassoSelectedClass();
    if (!cls) {
      statusText('Choose Tumor / Stroma / Other / Lymphocyte first');
      return;
    }

    const rect = target.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;

    ev.preventDefault();
    ev.stopPropagation();
    try { target.setPointerCapture?.(ev.pointerId); } catch(e) {}

    S.lassoDrawing = true;
    try { S.osdHE.setMouseNavEnabled(false); } catch(e) {}
    S.lassoPoints = [{ x, y }];
    _renderLassoPath();
  };

  const move = (ev) => {
    if (!S.lassoEnabled || !S.lassoDrawing) return;

    const rect = target.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;

    ev.preventDefault();
    ev.stopPropagation();

    const pts = S.lassoPoints;
    const last = pts[pts.length - 1];
    const dx = x - last.x, dy = y - last.y;

    // Sample only after a few screen pixels to keep the polygon manageable.
    if ((dx * dx + dy * dy) >= 9) {
      pts.push({ x, y });
      _renderLassoPath();
    }
  };

  const finish = async (ev) => {
    if (!S.lassoEnabled || !S.lassoDrawing) return;

    ev?.preventDefault?.();
    ev?.stopPropagation?.();

    const screenPts = S.lassoPoints.slice();
    _clearLassoPath();
    try { S.osdHE.setMouseNavEnabled(true); } catch(e) {}

    if (screenPts.length < 6) {
      statusText('Lasso was too short — drag around a larger region');
      return;
    }

    // Convert screen trace -> original H&E level-0 coordinates.
    const original = [];
    for (const p of screenPts) {
      const q = _lassoCanvasPointToOriginal(p.x, p.y);
      if (q) original.push(q);
    }
    if (original.length < 3) return;

    // Simplify by keeping points that are at least ~6 original pixels apart.
    const simplified = [];
    for (const p of original) {
      if (!simplified.length) {
        simplified.push(p);
        continue;
      }
      const prev = simplified[simplified.length - 1];
      const dx = p[0] - prev[0], dy = p[1] - prev[1];
      if (dx * dx + dy * dy >= 36) simplified.push(p);
    }
    if (simplified.length < 3) return;

    // Annotorious SVG polygon selectors use DZI pixel coordinates.
    const dziPts = simplified.map(p => _lassoOriginalToDziPoint(p[0], p[1]));
    const pointsText = dziPts.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');

    const cls = _lassoSelectedClass() || 'other';
    const id = 'lasso-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    const anno = {
      id,
      type: 'Annotation',
      body: [{
        type: 'TextualBody',
        purpose: 'tagging',
        value: cls
      }],
      target: {
        selector: {
          type: 'SvgSelector',
          value: `<svg><polygon points="${pointsText}"></polygon></svg>`
        }
      },
      provenance: {
        source: 'manual',
        tool: 'freehand_lasso'
      }
    };

    try {
      S.anno.addAnnotation(anno);
      await refreshAnnotationCountAndSave();
      statusText(`Freehand Lasso added ${cls}`);
    } catch (e) {
      console.error('Lasso annotation failed:', e);
      statusText('Freehand Lasso failed');
    }
  };

  const cancel = () => {
    if (S.lassoDrawing) _clearLassoPath();
    try { S.osdHE?.setMouseNavEnabled(true); } catch(e) {}
  };

  target.addEventListener('pointerdown', down, true);
  target.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', finish, true);
  window.addEventListener('pointercancel', finish, true);
  window.addEventListener('blur', cancel, true);

  S.lassoPointerTarget = target;
  S.lassoDownHandler = down;
  S.lassoMoveHandler = move;
  S.lassoUpHandler = finish;
  S.lassoCancelHandler = cancel;
}


function _savePersistentAnnotationsOnly() {
  try {
    if (!S.current || !S.anno) return;
    const persistent = (S.anno.getAnnotations() || []).filter(a =>
      !(a?.properties?.imported === true || a?.properties?.source === 'imported_geojson')
    );
    localStorage.setItem('anno_' + S.current.id, JSON.stringify(persistent));
  } catch (e) {
    console.warn('Could not save persistent annotations:', e);
  }
}

function _updateMagicWandUndoButton() {
  const btn = document.getElementById('btnUndoMagicWand');
  if (btn) btn.disabled = !(S.magicWandHistory && S.magicWandHistory.length);
}

function undoLastMagicWand() {
  if (!S.anno || !S.magicWandHistory?.length) {
    statusText('No Magic Wand annotation to undo');
    _updateMagicWandUndoButton();
    return;
  }

  while (S.magicWandHistory.length) {
    const last = S.magicWandHistory.pop();
    let exists = null;

    try {
      if (typeof S.anno.getAnnotationById === 'function') {
        exists = S.anno.getAnnotationById(last.id);
      } else {
        exists = (S.anno.getAnnotations() || []).find(a => a?.id === last.id);
      }
    } catch (e) {
      exists = (S.anno.getAnnotations() || []).find(a => a?.id === last.id);
    }

    if (!exists) continue; // stale history entry: skip silently

    try {
      S.anno.removeAnnotation(last.id);
      updateAnnoCount(-1);
      _savePersistentAnnotationsOnly();
      statusText('Undid last Magic Wand annotation');
    } catch(e) {
      console.warn('Undo Magic Wand failed:', e);
      statusText('Could not undo Magic Wand annotation');
    }

    _updateMagicWandUndoButton();
    return;
  }

  _updateMagicWandUndoButton();
  statusText('No Magic Wand annotation to undo');
}

function _magicWandAnnotationFromPolygon(polyOriginal, cls, meta = {}) {
  if (!Array.isArray(polyOriginal) || polyOriginal.length < 3) return null;

  // Avoid duplicate first/last SVG vertices, which create overlapping edit handles.
  let ptsOriginal = polyOriginal
    .map(p => [Number(p?.[0]), Number(p?.[1])])
    .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));

  if (ptsOriginal.length >= 2) {
    const a = ptsOriginal[0], b = ptsOriginal[ptsOriginal.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) {
      ptsOriginal = ptsOriginal.slice(0, -1);
    }
  }
  if (ptsOriginal.length < 3) return null;

  // Backend returns original level-0 H&E pixels. Annotorious uses DZI pixels.
  const ds = Number(S.heDziDownsample || 1);
  const pts = ptsOriginal.map(p => {
    const x = p[0] / ds;
    const y = p[1] / ds;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');

  const svg = '<svg><polygon points="' + pts + '"/></svg>';
  const id = '#wand_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id,
    type: 'Annotation',
    body: [{ type: 'TextualBody', purpose: 'tagging', value: cls }],
    target: { selector: { type: 'SvgSelector', value: svg } },
    properties: {
      label: cls,
      source: 'magic_wand',
      generated_by: 'pathogene_magic_wand',
      magic_wand: {
        algorithm: meta.algorithm || 'unknown',
        tolerance: Number(meta.tolerance ?? 0),
        level_downsample: Number(meta.level_downsample ?? 0),
        analysis_level: Number(meta.analysis_level ?? -1),
        seed_x_level0: Number(meta.seed_x_level0 ?? 0),
        seed_y_level0: Number(meta.seed_y_level0 ?? 0),
        parameters: meta.parameters || {},
        // Snapshot of the as-generated SVG, so export can tell whether a
        // pathologist has since reshaped this polygon by hand.
        original_svg: svg
      }
    }
  };
}

async function deleteSelectedAnnotation() {
  if (!S.anno) return;
  const sel = S.anno.getSelected ? S.anno.getSelected() : null;
  if (!sel) { alert('Click an annotation to select it first.'); return; }
  if (confirm('Delete selected annotation?')) {
    S.anno.removeAnnotation(sel.id);
    updateAnnoCount(-1);
  }
}

function refreshAnnotationCountAndSave() {
  if (!S.anno) return;

  try {
    const anns = S.anno.getAnnotations() || [];

    // UI count shows all currently visible annotations, including imported GeoJSON.
    S.annoCount = anns.length;
    const el = document.getElementById('annoCount');
    if (el) el.textContent = S.annoCount;

    // Persistence excludes imported overlays to avoid localStorage quota blowups.
    _savePersistentAnnotationsOnly();
  } catch(e) {
    console.warn('Could not refresh/save annotations:', e);
  }
}

function clearImportedAnnotations() {
  if (!S.anno) return;
  const anns = S.anno.getAnnotations ? S.anno.getAnnotations() : [];
  const importedIds = new Set(S.importedAnnoIds || []);
  const targets = anns.filter(a =>
    importedIds.has(a.id) ||
    a?.properties?.imported === true ||
    a?.properties?.source === 'imported_geojson'
  );

  if (!targets.length) {
    alert('No imported GeoJSON annotations to clear.');
    return;
  }

  targets.forEach(a => {
    try { S.anno.removeAnnotation(a.id); } catch(e) { console.warn('remove imported annotation failed:', e); }
  });
  S.importedAnnoIds = [];
  refreshAnnotationCountAndSave();
  statusText('Cleared ' + targets.length + ' imported GeoJSON annotations');
}

function _downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _annotationLabel(ann) {
  const body = Array.isArray(ann?.body) ? ann.body : (ann?.body ? [ann.body] : []);
  const tag = body.find(b => b?.value || b?.label || b?.name);
  return normalizeAnnoClassName(tag?.value || tag?.label || tag?.name || ann?.properties?.label || 'other');
}

function _annotationToGeoJSONFeature(ann) {
  const svg = ann?.target?.selector?.value || ann?.target?.selector?.exact || '';
  let coords = [];

  const pointsMatch = svg.match(/<polygon[^>]*points=["']([^"']+)["']/i);
  if (pointsMatch) {
    coords = pointsMatch[1]
      .trim()
      .split(/\s+/)
      .map(pair => pair.split(',').map(Number))
      .filter(p => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  }

  // Fallback for SVG path generated by some Annotorious versions: M x y L x y ... Z
  if (!coords.length) {
    const pathMatch = svg.match(/<path[^>]*d=["']([^"']+)["']/i);
    if (pathMatch) {
      const nums = pathMatch[1].match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
      for (let i = 0; i + 1 < nums.length; i += 2) coords.push([nums[i], nums[i + 1]]);
    }
  }

  if (coords.length < 3) return null;

  // Convert viewer/DZI coordinates back to original H&E level-0 coordinates
  // so exported annotations stay compatible with pathology GeoJSON files.
  const ds = Number(S.heDziDownsample || 1);
  if (ds !== 1) coords = coords.map(p => [p[0] * ds, p[1] * ds]);

  const first = coords[0], last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push([first[0], first[1]]);

  const label = _annotationLabel(ann);
  const mw = ann?.properties?.magic_wand;
  // A pathologist may have reshaped a wand polygon's vertices after creation.
  // Compare the current SVG against the as-generated snapshot so exported
  // provenance distinguishes "wand-assisted" from "wand-assisted, corrected".
  const mwOut = mw ? { ...mw, edited: mw.original_svg != null ? svg !== mw.original_svg : null } : undefined;
  return {
    type: 'Feature',
    id: ann.id,
    properties: {
      label,
      classification: { name: label },
      source: ann?.properties?.source || 'pathogene_manual_export',
      ...(mwOut ? { magic_wand: mwOut } : {})
    },
    geometry: { type: 'Polygon', coordinates: [coords] }
  };
}

function saveAnnotationsGeoJSON() {
  if (!S.anno) { alert('Viewer not ready.'); return; }
  const anns = S.anno.getAnnotations ? S.anno.getAnnotations() : [];
  const features = anns.map(_annotationToGeoJSONFeature).filter(Boolean);
  if (!features.length) {
    alert('No polygon annotations to save. Draw or import polygon annotations first.');
    return;
  }
  const slideId = S.current?.id || 'slide';
  _downloadJSON({
    type: 'FeatureCollection',
    name: slideId + '_annotations',
    features
  }, slideId + '_annotations.geojson');
  statusText('Saved ' + features.length + ' polygon annotations as GeoJSON');
}

// ── CosMx manual alignment ────────────────────────────────────────────────

function _getCosMxTransformObject(payload) {
  if (!payload || payload.transform === 'identity') return null;
  if (payload.transform && typeof payload.transform === 'object') return payload.transform;
  return payload;
}

function _loadCosMxTransformIntoControls(payload) {
  const t = _getCosMxTransformObject(payload);
  if (!t) return;

  S.cosmxRot = Number(t.rotation || 0);
  S.cosmxFlipX = !!t.flipX;
  S.cosmxFlipY = !!t.flipY;
  S.cosmxScale = Number(t.scale || 1.0);

  const rotSlider = document.getElementById('rotSlider');
  const rotVal = document.getElementById('rotVal');
  const scaleSlider = document.getElementById('scaleSlider');
  const scaleVal = document.getElementById('scaleVal');

  if (rotSlider) rotSlider.value = S.cosmxRot;
  if (rotVal) rotVal.textContent = Math.round(S.cosmxRot);
  if (scaleSlider) scaleSlider.value = S.cosmxScale;
  if (scaleVal) scaleVal.textContent = S.cosmxScale.toFixed(2);

  document.getElementById('btnFlipX')?.classList.toggle('on', S.cosmxFlipX);
  document.getElementById('btnFlipY')?.classList.toggle('on', S.cosmxFlipY);
  document.querySelectorAll('.pr button').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.r) === S.cosmxRot));
}

function _convertFlipRotationForOSD(rotation, flipX, flipY) {
  let vX = { x: 1, y: 0 };
  let vY = { x: 0, y: 1 };
  const k = Math.floor((((rotation % 360) + 360) % 360) / 90) % 4;

  for (let i = 0; i < k; i++) {
    vX = { x: vX.y, y: -vX.x };
    vY = { x: vY.y, y: -vY.x };
  }
  if (flipX) { vX.x = -vX.x; vY.x = -vY.x; }
  if (flipY) { vX.y = -vX.y; vY.y = -vY.y; }

  for (const fl of [false, true]) {
    for (const ro of [0, 90, 180, 270]) {
      let oX = { x: 1, y: 0 };
      let oY = { x: 0, y: 1 };
      if (fl) { oX.x = -oX.x; oY.x = -oY.x; }
      const rk = Math.floor(ro / 90) % 4;
      for (let i = 0; i < rk; i++) {
        oX = { x: -oX.y, y: oX.x };
        oY = { x: -oY.y, y: oY.x };
      }
      if (vX.x === oX.x && vX.y === oX.y && vY.x === oY.x && vY.y === oY.y) {
        return { osdRotation: ro, osdFlip: fl };
      }
    }
  }
  return { osdRotation: rotation || 0, osdFlip: false };
}

function applyCosMxTransform() {
  const el = document.getElementById('viewerRight');
  if (el) {
    // Clear old CSS transform path. Transform is now applied to the OSD TiledImage.
    el.style.transform = '';
    el.style.transformOrigin = '';
  }

  if (!S.osdCosMx || !S.osdCosMx.world) return;
  const item = S.osdCosMx.world.getItemAt(0);
  if (!item) return;

  // When the right panel is switched to H&E, keep it untransformed.
  if (S.rightBase === 'he') {
    try {
      item.setRotation(0, true);
      item.setFlip(false);
    } catch(e) {}
    return;
  }

  const payload = S.cosmxTransformPayload || {};
  const tfObj = _getCosMxTransformObject(payload) || {};
  const sizes = payload.original_sizes || {};
  const heSize = sizes.he || [];
  const cxSize = sizes.cosmx || [];

  const heW = Number(heSize[0] || 0);
  const heH = Number(heSize[1] || 0);
  const cxW = Number(cxSize[0] || item.source?.width || 1);
  const cxH = Number(cxSize[1] || item.source?.height || 1);
  const proc = Number(payload?.detection?.processing_size || 1024);

  // Use current UI/manual values for rotation/flip/scale; they are initialized
  // from transform_registered.json by _loadCosMxTransformIntoControls().
  const rotation = ((Number(S.cosmxRot || tfObj.rotation || 0) % 360) + 360) % 360;
  const flipX = !!S.cosmxFlipX;
  const flipY = !!S.cosmxFlipY;
  const scale = Number(S.cosmxScale || tfObj.scale || 1.0);

  const { osdRotation, osdFlip } = _convertFlipRotationForOSD(rotation, flipX, flipY);

  try {
    item.setRotation(osdRotation, true);
    item.setFlip(osdFlip);
  } catch(e) {
    console.warn('[CosMx] rotation/flip failed:', e);
  }

  // If original image sizes are known, place original CosMx DZI into H&E-space.
  // The transform values are computed on 1024px preview coordinates.
  if (heW > 0 && heH > 0 && cxW > 0 && cxH > 0) {
    const heThumbScale = Math.min(proc / heW, proc / heH);
    const cxThumbScale = Math.min(proc / cxW, proc / cxH);
    const heFull = 1.0 / heThumbScale;
    const fullScale = scale * cxThumbScale * heFull;

    const W = (cxW * fullScale) / heW;
    const H = (cxH * fullScale) / heW; // OSD y-units use the same scale as x-units.

    const txPx = Number(
      tfObj.translateX_pixels ??
      ((tfObj.translateX !== undefined) ? Number(tfObj.translateX) * proc : 0)
    );
    const tyPx = Number(
      tfObj.translateY_pixels ??
      ((tfObj.translateY !== undefined) ? Number(tfObj.translateY) * proc : 0)
    );

    const dx = (txPx * heFull) / heW;
    const dy = (tyPx * heFull) / heW;

    const visibleW = (osdRotation % 180 !== 0) ? H : W;
    const visibleH = (osdRotation % 180 !== 0) ? W : H;

    try {
      item.setWidth(W, true);
      item.setPosition(new OpenSeadragon.Point(
        dx + visibleW / 2 - W / 2,
        dy + visibleH / 2 - H / 2
      ), true);

      // Show the full H&E coordinate frame on the right panel so the transformed
      // CosMx layout matches the left slide overview.
      S.osdCosMx.viewport.fitBounds(new OpenSeadragon.Rect(0, 0, 1, heH / heW), true);
    } catch(e) {
      console.warn('[CosMx] transform placement failed:', e);
    }

    console.log('[CosMx] applied transform_registered.json to original DZI:', {
      rotation, flipX, flipY, scale, osdRotation, osdFlip, W, H, dx, dy,
      source: payload._transform_source_file || payload.transform_source || 'unknown'
    });
    return;
  }

  // Fallback for older transforms without original_sizes: rotate/flip/scale only.
  try {
    item.setWidth(scale, true);
  } catch(e) {}
}


function onRotInput(el) {
  S.cosmxRot = parseFloat(el.value);
  document.getElementById('rotVal').textContent = Math.round(S.cosmxRot);
  document.querySelectorAll('.pr button').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.r) === S.cosmxRot));
  applyCosMxTransform();
}

function setRotPreset(deg) {
  S.cosmxRot = deg;
  const sl = document.getElementById('rotSlider');
  if (sl) sl.value = deg;
  document.getElementById('rotVal').textContent = deg;
  document.querySelectorAll('.pr button').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.r) === deg));
  applyCosMxTransform();
}

function toggleFlipX() {
  S.cosmxFlipX = !S.cosmxFlipX;
  document.getElementById('btnFlipX').classList.toggle('on', S.cosmxFlipX);
  applyCosMxTransform();
}

function toggleFlipY() {
  S.cosmxFlipY = !S.cosmxFlipY;
  document.getElementById('btnFlipY').classList.toggle('on', S.cosmxFlipY);
  applyCosMxTransform();
}

function onScaleInput(el) {
  S.cosmxScale = parseFloat(el.value);
  document.getElementById('scaleVal').textContent = S.cosmxScale.toFixed(2);
  applyCosMxTransform();
}

function saveCosMxPosition() {
  if (!S.current) return;
  localStorage.setItem('cosmx_adj_' + S.current.id,
    JSON.stringify({ rot: S.cosmxRot, flipX: S.cosmxFlipX, flipY: S.cosmxFlipY, scale: S.cosmxScale }));
  statusText('CosMx position saved');
}

function _restoreCosMxAdjustment(adj) {
  if (!adj || !Object.keys(adj).length) return;
  S.cosmxRot   = adj.rot   || 0;
  S.cosmxFlipX = adj.flipX || false;
  S.cosmxFlipY = adj.flipY || false;
  S.cosmxScale = adj.scale || 1.0;
  const sl = document.getElementById('rotSlider');
  if (sl) sl.value = S.cosmxRot;
  const rv = document.getElementById('rotVal');
  if (rv) rv.textContent = S.cosmxRot;
  const ss = document.getElementById('scaleSlider');
  if (ss) ss.value = S.cosmxScale;
  const sv = document.getElementById('scaleVal');
  if (sv) sv.textContent = S.cosmxScale.toFixed(2);
  const bx = document.getElementById('btnFlipX');
  if (bx) bx.classList.toggle('on', S.cosmxFlipX);
  const by = document.getElementById('btnFlipY');
  if (by) by.classList.toggle('on', S.cosmxFlipY);
  applyCosMxTransform();
}

// ── Registration settings ─────────────────────────────────────────────────

function setTransformType(type) {
  S.transformType = type;
  document.querySelectorAll('#segTransform .seg-btn').forEach((b, i) =>
    b.classList.toggle('active', (i === 0) === (type === 'rigid')));
}

function setMode(mode) {
  S.regMode = mode;
  const order = ['auto', 'semi-auto', 'tiling-only'];
  document.querySelectorAll('#segMode .seg-btn').forEach((b, i) =>
    b.classList.toggle('active', order[i] === mode));

  // Transform type is irrelevant when registration is intentionally skipped.
  const transformOptions = document.getElementById('segTransform');
  if (transformOptions) {
    transformOptions.style.opacity = mode === 'tiling-only' ? '0.45' : '1';
    transformOptions.style.pointerEvents = mode === 'tiling-only' ? 'none' : 'auto';
  }
}

// ══ REGISTRATION PREVIEW ═════════════════════════════════════════════════════

let _previewData = null;
const _previewImgs = { he: null, cosmx: null };
const _previewMasks = { heRed: null, cosmxGreen: null, cosmxTransformed: null, key: '' };

function initPreviewScreen(payload) {
  _previewData = payload;
  _previewImgs.he = null;
  _previewImgs.cosmx = null;
  _previewMasks.heRed = null;
  _previewMasks.cosmxGreen = null;
  _previewMasks.cosmxTransformed = null;
  _previewMasks.key = '';

  showScreen('screen-preview');

  const tf = normalizePreviewTransform(payload);
  const info = [
    'QC false-color overlay mode',
    'Rotation: ' + (tf.rotation || 0) + 'deg',
    'FlipX: ' + (!!tf.flipX),
    'FlipY: ' + (!!tf.flipY),
    'Scale: ' + Number(tf.scale || 1).toFixed(3) + 'x',
    'Offset: (' + Math.round(tf.translateX_pixels || 0) + ', ' + Math.round(tf.translateY_pixels || 0) + ') px',
    payload.is_fine_registered_preview ? 'Preview source: register_fine final transform_registered.json' : ('Preview source: ' + (payload.transform_source || 'unknown'))
  ].join('   |   ');
  document.getElementById('previewTransformInfo').textContent = info;

  const needCosMx = !!(payload.has_cosmx && (payload.cosmx_url || payload.cosmx_preview));
  let loaded = 0;
  const targetLoads = needCosMx ? 2 : 1;
  const onLoad = () => { if (++loaded >= targetLoads) renderPreviewCanvas(); };

  const heImg = new Image();
  const cxImg = new Image();
  heImg.crossOrigin = 'anonymous';
  cxImg.crossOrigin = 'anonymous';
  heImg.onload = onLoad;
  heImg.onerror = () => { console.error('[Preview] Failed to load H&E thumbnail:', heImg.src); onLoad(); };
  cxImg.onload = onLoad;
  cxImg.onerror = () => { console.error('[Preview] Failed to load CosMx thumbnail:', cxImg.src); onLoad(); };

  heImg.src = (payload.he_url || payload.he_preview) + '?t=' + Date.now();
  if (needCosMx) cxImg.src = (payload.cosmx_url || payload.cosmx_preview) + '?t=' + Date.now();

  _previewImgs.he = heImg;
  _previewImgs.cosmx = cxImg;
}

function normalizePreviewTransform(payload) {
  const p = payload || {};
  const raw = (typeof p.transform === 'object' && p.transform !== null) ? p.transform : {};

  function pickNumber(keys, fallback) {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') {
        const v = Number(raw[k]);
        if (Number.isFinite(v)) return v;
      }
      if (p[k] !== undefined && p[k] !== null && p[k] !== '') {
        const v = Number(p[k]);
        if (Number.isFinite(v)) return v;
      }
    }
    return fallback;
  }

  const heThumbW = Number(p.he_thumb_w || p.he_preview_w || p.thumb_w || 0);
  const heThumbH = Number(p.he_thumb_h || p.he_preview_h || p.thumb_h || 0);

  let tx = pickNumber(['translateX_pixels', 'tx_pixels', 'dx', 'offsetX'], null);
  let ty = pickNumber(['translateY_pixels', 'ty_pixels', 'dy', 'offsetY'], null);

  // Some older transform files store normalized translateX / translateY.
  if (tx === null) {
    const nx = pickNumber(['translateX'], null);
    tx = (nx !== null && heThumbW) ? nx * heThumbW : 0;
  }
  if (ty === null) {
    const ny = pickNumber(['translateY'], null);
    ty = (ny !== null && heThumbH) ? ny * heThumbH : 0;
  }

  // Do not use warp_matrix in preview. The QC preview must show the
  // final register_fine.py result: rotation / flip / scale / dx / dy.
  const warp = null;

  return {
    rotation: pickNumber(['rotation'], 0),
    rotation_exact: Number.isFinite(Number(p.rotation_exact)) ? Number(p.rotation_exact) : null,
    flipX: !!raw.flipX,
    flipY: !!raw.flipY,
    scale: pickNumber(['scale'], 1),
    translateX_pixels: tx,
    translateY_pixels: ty,
    warp_matrix: null,
    _usesWarp: false
  };
}

function makeFalseColorMask(sourceImg, color, options = {}) {
  const w = sourceImg.naturalWidth || sourceImg.width;
  const h = sourceImg.naturalHeight || sourceImg.height;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d', { willReadFrequently: true });
  octx.drawImage(sourceImg, 0, 0, w, h);

  const imgData = octx.getImageData(0, 0, w, h);
  const data = imgData.data;

  const alpha = options.alpha ?? 190;
  const mode = options.mode || 'cosmx';

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    const brightness = (r + g + b) / 3;
    const saturation = maxc - minc;

    let tissue;
    if (mode === 'he') {
      // H&E: tissue is usually not pure white and/or has pink-purple saturation.
      tissue = !(brightness > 242 && saturation < 18);
    } else {
      // CosMx: remove white background and also remove near-black empty background.
      const whiteBg = brightness > 235 && saturation < 28;
      const blackBg = brightness < 12 && saturation < 18;
      tissue = !whiteBg && !blackBg;
    }

    if (!tissue) {
      data[i + 3] = 0;
      continue;
    }

    // Preserve a little source texture by varying alpha with contrast.
    const contrastBoost = mode === 'he'
      ? Math.max(0.35, Math.min(1.0, (255 - brightness) / 140))
      : Math.max(0.45, Math.min(1.0, (saturation + brightness * 0.35) / 180));

    data[i] = color[0];
    data[i + 1] = color[1];
    data[i + 2] = color[2];
    data[i + 3] = Math.round(alpha * contrastBoost);
  }

  octx.putImageData(imgData, 0, 0);
  return off;
}

function buildRotFlipCanvas(srcCanvas, rotationDeg, flipX, flipY) {
  const r = ((Math.round(rotationDeg / 90) * 90) % 360 + 360) % 360;
  const swap = r === 90 || r === 270;
  const out = document.createElement('canvas');
  out.width = swap ? srcCanvas.height : srcCanvas.width;
  out.height = swap ? srcCanvas.width : srcCanvas.height;
  const ctx = out.getContext('2d');

  ctx.save();
  ctx.translate(out.width / 2, out.height / 2);
  // PIL Image.ROTATE_90 is counter-clockwise. Canvas positive rotation appears clockwise,
  // so use the negative angle to match the backend transform convention better.
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  ctx.rotate(-r * Math.PI / 180);
  ctx.drawImage(srcCanvas, -srcCanvas.width / 2, -srcCanvas.height / 2);
  ctx.restore();
  return out;
}

function ensurePreviewMasks() {
  const heImg = _previewImgs.he;
  const cxImg = _previewImgs.cosmx;
  const tf = normalizePreviewTransform(_previewData);
  const key = JSON.stringify({
    he: heImg ? [heImg.naturalWidth, heImg.naturalHeight, heImg.src] : null,
    cx: cxImg ? [cxImg.naturalWidth, cxImg.naturalHeight, cxImg.src] : null,
    rot: tf.rotation,
    fx: tf.flipX,
    fy: tf.flipY
  });

  if (_previewMasks.key === key) return;
  _previewMasks.key = key;
  _previewMasks.heRed = heImg && heImg.naturalWidth
    ? makeFalseColorMask(heImg, [220, 30, 30], { mode: 'he', alpha: 155 })
    : null;
  _previewMasks.cosmxGreen = cxImg && cxImg.naturalWidth
    ? makeFalseColorMask(cxImg, [0, 255, 40], { mode: 'cosmx', alpha: 230 })
    : null;
  _previewMasks.cosmxTransformed = _previewMasks.cosmxGreen
    ? buildRotFlipCanvas(_previewMasks.cosmxGreen, tf.rotation, tf.flipX, tf.flipY)
    : null;
}

function drawCosMxWithWarp(ctx, cosmxMask, tf, sx, sy, opacity) {
  const m = tf.warp_matrix;
  if (!m) return false;
  ctx.save();
  ctx.globalAlpha = opacity;
  // OpenCV affine:
  //   x' = m00*x + m01*y + m02
  //   y' = m10*x + m11*y + m12
  // Canvas transform(a,b,c,d,e,f):
  //   x' = a*x + c*y + e
  //   y' = b*x + d*y + f
  ctx.transform(
    m[0][0] * sx,
    m[1][0] * sy,
    m[0][1] * sx,
    m[1][1] * sy,
    m[0][2] * sx,
    m[1][2] * sy
  );
  ctx.drawImage(cosmxMask, 0, 0);
  ctx.restore();
  return true;
}

function drawCosMxWithSimpleTransform(ctx, cosmxMask, tf, sx, sy, opacity) {
  const dx = Number(tf.translateX_pixels || 0) * sx;
  const dy = Number(tf.translateY_pixels || 0) * sy;
  const scale = Number(tf.scale || 1);
  const drawW = cosmxMask.width * scale * sx;
  const drawH = cosmxMask.height * scale * sy;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.drawImage(cosmxMask, dx, dy, drawW, drawH);
  ctx.restore();
}

function renderPreviewCanvas() {
  const canvas = document.getElementById('previewCanvas');
  const wrap = document.getElementById('previewCanvasWrap');
  if (!canvas || !_previewData) return;

  const heImg = _previewImgs.he;
  const cxImg = _previewImgs.cosmx;
  if (!heImg || !heImg.naturalWidth) return;

  const dispW = wrap.clientWidth || 840;
  const dispH = Math.round(dispW * heImg.naturalHeight / heImg.naturalWidth);
  canvas.width = dispW;
  canvas.height = dispH;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, dispW, dispH);

  const opEl = document.getElementById('previewOpacity');
  const op = opEl ? parseInt(opEl.value, 10) / 100 : 0.5;
  const opValEl = document.getElementById('previewOpacityVal');
  if (opValEl) opValEl.textContent = Math.round(op * 100) + '%';

  ensurePreviewMasks();

  // QC mode: black background + H&E red mask + CosMx green mask.
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, dispW, dispH);

  if (_previewMasks.heRed) {
    ctx.drawImage(_previewMasks.heRed, 0, 0, dispW, dispH);
  } else {
    // Fallback: draw the original thumbnail if mask creation failed.
    ctx.drawImage(heImg, 0, 0, dispW, dispH);
  }

  const hasCosMx = !!(_previewData.has_cosmx && cxImg && cxImg.naturalWidth && _previewMasks.cosmxGreen);
  const tf = normalizePreviewTransform(_previewData);

  const sx = dispW / heImg.naturalWidth;
  const sy = dispH / heImg.naturalHeight;

  if (hasCosMx) {
    // Always use register_fine.py final rotation/flip/scale/dx/dy for preview.
    // warp_matrix is intentionally ignored because stale warp data can override
    // the fine result and hide the green CosMx overlay.
    drawCosMxWithSimpleTransform(ctx, _previewMasks.cosmxTransformed || _previewMasks.cosmxGreen, tf, sx, sy, op);
  } else {
    console.warn('[Preview] CosMx image is not loaded or has_cosmx=false.', {
      payload: _previewData,
      cosmxImg: cxImg,
    });
  }

  // Diagnostic label.
  ctx.save();
  ctx.globalAlpha = 0.94;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  ctx.fillRect(10, 10, Math.min(760, dispW - 20), 82);
  ctx.fillStyle = '#ffffff';
  ctx.font = '13px Consolas, monospace';
  ctx.fillText('QC Overlay: H&E tissue = red, CosMx tissue = green, background removed', 22, 34);
  ctx.fillText(`Transform: rot=${tf.rotation} fx=${tf.flipX} fy=${tf.flipY} scale=${Number(tf.scale || 1).toFixed(3)} dx=${Math.round(tf.translateX_pixels || 0)} dy=${Math.round(tf.translateY_pixels || 0)}`, 22, 58);
  ctx.fillText(`Source: ${_previewData.transform_source || 'unknown'} | Fine final: ${_previewData.is_fine_registered_preview ? 'YES' : 'NO'}`, 22, 78);
  ctx.restore();

  console.log('[Preview QC]', {
    payload: _previewData,
    transform: tf,
    display: [dispW, dispH],
    heNatural: [heImg.naturalWidth, heImg.naturalHeight],
    cosmxNatural: cxImg && cxImg.naturalWidth ? [cxImg.naturalWidth, cxImg.naturalHeight] : null,
  });
}

async function confirmPreview(action) {
  try {
    const r = await apiJSON('/api/pipeline/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        slide_id: _previewData && _previewData.slide_id ? _previewData.slide_id : undefined
      }),
    });
    if (r.error) throw new Error(r.error);

    PIPELINE_ANCHOR_OPENED = false;
    PIPELINE_LAST_LOG_COUNT = 0;

    if (action === 'anchors') {
      window.onPipelineStart({
        slide_id: (_previewData && _previewData.slide_id) || 'new_slide',
        total: 1,
        steps: ['Anchor Placement']
      });
    } else {
      window.onPipelineStart({
        slide_id: (_previewData && _previewData.slide_id) || 'new_slide',
        total: (r.steps || ['H&E Tiling']).length,
        steps: r.steps || ['H&E Tiling']
      });
    }

    goProcessing();
    startPipelinePolling();
  } catch(e) {
    alert('Failed: ' + e.message);
  }
}

function goPreview() { showScreen('screen-preview'); }

// ── Anchor confirmation (Flask API) ──────────────────────────────────────

function updateAnchorUI() {
  const n   = S.anchorPairs.length;
  const min = S.anchorMinPairs;
  const ok  = n >= min;

  const list  = document.getElementById('anchorList');
  const empty = document.getElementById('anchorEmpty');
  if (n === 0) {
    if (empty) empty.style.display = 'block';
    if (list)  list.querySelectorAll('.anchor-pair-item').forEach(el => el.remove());
  } else {
    if (empty) empty.style.display = 'none';
    if (list) {
      list.querySelectorAll('.anchor-pair-item').forEach(el => el.remove());
      S.anchorPairs.forEach((pair, i) => {
        const item = document.createElement('div');
        item.className = 'anchor-pair-item';
        item.innerHTML =
          `<div class="anchor-pair-num">${i+1}</div>
           <div class="anchor-pair-coords">H&amp;E: (${pair.he.x_px}, ${pair.he.y_px})<br>
           CosMx: (${pair.cosmx.x_px}, ${pair.cosmx.y_px})</div>
           <button class="anchor-pair-del" onclick="removeAnchorPair(${i})">&#10005;</button>`;
        list.appendChild(item);
      });
    }
  }

  const st = document.getElementById('anchorStatus');
  if (st) {
    if (ok) { st.className = 'anchor-status ok';   st.textContent = n + ' pairs — ready!'; }
    else    { st.className = 'anchor-status warn';  st.textContent = n + ' pair' + (n!==1?'s':'') + ' — need at least ' + min; }
  }
  const btn = document.getElementById('anchorConfirmBtn');
  if (btn) btn.disabled = !ok;
}

async function confirmAnchors() {
  if (S.anchorPairs.length < S.anchorMinPairs) return;
  const btn = document.getElementById('anchorConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Registering...'; }

  // Anchor coordinates are already in thumbnail pixel space.
  // Do NOT convert CosMx clicks to full-resolution pixels here.
  // register_anchors.py now expects both src and dst in thumbnail coordinates.
  const anchors = {
    src: S.anchorPairs.map(p => [p.he.x_px,    p.he.y_px]),
    dst: S.anchorPairs.map(p => [p.cosmx.x_px, p.cosmx.y_px]),
  };

  try {
    const r = await apiJSON('/api/pipeline/anchors', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        slide_id:       S.anchorSlideId,
        anchors:        {
          ...anchors,
          orientation: {
            rotation: S.anchorCosmxRotation,
            flipX: !!S.anchorCosmxFlipX,
            flipY: !!S.anchorCosmxFlipY,
            coord_space: 'oriented_cosmx_thumbnail'
          }
        },
        transform_type: S.anchorTransformType,
      }),
    });
    if (r.error) throw new Error(r.error);
    goProcessing();
    appendLog('[Anchors] ' + anchors.src.length + ' pairs submitted');
    startPipelinePolling();
  } catch(e) {
    alert('Failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm & Register'; }
  }
}

// ===========================================================================
// SEGMENTATION EVALUATION (Pathologist GT vs AI segmentation)
// ===========================================================================

let SEG_EVAL_GT = null;
let SEG_EVAL_PRED = null;
let SEG_EVAL_GT_NAME = '';
let SEG_EVAL_PRED_NAME = '';

function _setSegEvalButtonState() {
  const btn = document.getElementById('btnSegEvaluate');
  if (btn) btn.disabled = !(SEG_EVAL_GT && SEG_EVAL_PRED);
}

function loadSegmentationEvalFile(input, kind) {
  const file = input?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const raw = JSON.parse(e.target.result);
      if (!raw || raw.type !== 'FeatureCollection' || !Array.isArray(raw.features)) {
        throw new Error('Expected a GeoJSON FeatureCollection.');
      }
      if (kind === 'gt') {
        SEG_EVAL_GT = raw;
        SEG_EVAL_GT_NAME = file.name;
        const el = document.getElementById('gtSegName');
        if (el) el.textContent = 'GT: ' + file.name;
      } else {
        SEG_EVAL_PRED = raw;
        SEG_EVAL_PRED_NAME = file.name;
        const el = document.getElementById('predSegName');
        if (el) el.textContent = 'AI: ' + file.name;
      }
      const results = document.getElementById('segEvalResults');
      if (results) results.style.display = 'none';
      _setSegEvalButtonState();
    } catch (err) {
      alert('Invalid segmentation GeoJSON: ' + err.message);
      if (kind === 'gt') SEG_EVAL_GT = null;
      else SEG_EVAL_PRED = null;
      _setSegEvalButtonState();
    } finally {
      input.value = '';
    }
  };
  reader.readAsText(file);
}

function _segMetricText(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(4) : 'N/A';
}

function _segEscapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function _renderSegmentationResults(data) {
  const box = document.getElementById('segEvalResults');
  if (!box) return;
  const tumor = data?.results?.tumor || {};
  const stroma = data?.results?.stroma || {};
  const mean = data?.mean || {};
  const warnings = Array.isArray(data?.warnings) ? data.warnings : [];

  const pct = v => {
    const n = Number(v);
    return Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : 'N/A';
  };

  box.innerHTML =
    '<div style="font-weight:700;color:var(--accent);margin-bottom:0.35rem;">Pathologist GT Coverage</div>' +
    '<div style="color:var(--muted);margin-bottom:0.4rem;word-break:break-word;">GT: ' + _segEscapeHtml(SEG_EVAL_GT_NAME) + '<br>AI: ' + _segEscapeHtml(SEG_EVAL_PRED_NAME) + '</div>' +
    '<div><b>Tumor</b> &nbsp; GT covered by AI: <b>' + pct(tumor.gt_coverage) + '</b></div>' +
    '<div style="color:var(--muted);">GT polygons: ' + (tumor.gt_polygons ?? 0) + ' | AI polygons: ' + (tumor.prediction_polygons ?? 0) + '</div>' +
    '<div style="font-size:0.67rem;color:var(--muted);margin-top:0.1rem;">Reference: Dice ' + _segMetricText(tumor.dice) + ' | IoU ' + _segMetricText(tumor.iou) + '</div>' +
    '<div style="margin-top:0.45rem;"><b>Stroma</b> &nbsp; GT covered by AI: <b>' + pct(stroma.gt_coverage) + '</b></div>' +
    '<div style="color:var(--muted);">GT polygons: ' + (stroma.gt_polygons ?? 0) + ' | AI polygons: ' + (stroma.prediction_polygons ?? 0) + '</div>' +
    '<div style="font-size:0.67rem;color:var(--muted);margin-top:0.1rem;">Reference: Dice ' + _segMetricText(stroma.dice) + ' | IoU ' + _segMetricText(stroma.iou) + '</div>' +
    '<div style="margin-top:0.55rem;padding-top:0.45rem;border-top:1px solid var(--border);"><b>Mean GT Coverage:</b> ' + pct(mean.gt_coverage) + '</div>' +
    (warnings.length ? '<div style="margin-top:0.45rem;color:var(--warn);">Warning: ' + warnings.map(_segEscapeHtml).join('<br>') + '</div>' : '') +
    '<div style="margin-top:0.45rem;color:var(--muted);">Primary metric = intersection / GT area. AI regions outside the pathologist GT are not penalized. Tumor and Stroma only; Region* and In-situ are excluded.</div>';
  box.style.display = 'block';
}

async function evaluateSegmentation() {
  if (!SEG_EVAL_GT || !SEG_EVAL_PRED) {
    alert('Load both the pathologist GT and AI segmentation GeoJSON files first.');
    return;
  }
  const btn = document.getElementById('btnSegEvaluate');
  if (btn) { btn.disabled = true; btn.textContent = 'Calculating...'; }
  try {
    const data = await apiJSON('/api/evaluate/segmentation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ground_truth: SEG_EVAL_GT, prediction: SEG_EVAL_PRED })
    });
    _renderSegmentationResults(data);
  } catch (e) {
    console.error('Segmentation evaluation failed:', e);
    alert('Segmentation evaluation failed: ' + e.message);
  } finally {
    if (btn) { btn.textContent = 'Calculate GT Coverage'; _setSegEvalButtonState(); }
  }
}

// ===========================================================================
// ANNOTATION IMPORT  (GeoJSON -> W3C Web Annotation for Annotorious)
// ===========================================================================

/**
 * Convert a GeoJSON Polygon Feature -> W3C Web Annotation (Annotorious format).
 * Annotorious stores annotations as W3C Web Annotations with SvgSelector.
 * Passing raw GeoJSON to addAnnotation() silently fails -- conversion is required.
 */
function _featureClassName(feat) {
  const p = feat?.properties || {};
  return p?.classification?.name ||
         p?.className ||
         p?.label ||
         p?.name ||
         p?.type ||
         p?.objectType ||
         '';
}

function _geojsonToAnnotation(feat) {
  const geo  = feat.geometry || {};
  if (geo.type !== 'Polygon') return null;

  const outer = (geo.coordinates || [[]])[0];
  if (!outer || outer.length < 3) return null;

  // Pathology/QuPath GeoJSON normally uses original H&E level-0 pixels.
  // The viewer may use a reduced-resolution DZI, so map original pixels to
  // current DZI pixels before giving the polygon to Annotorious.
  const ds = Number(S.heDziDownsample || 1);
  const pts = outer.map(p =>
    (p[0] / ds).toFixed(1) + ',' + (p[1] / ds).toFixed(1)
  ).join(' ');
  const svg = '<svg><polygon points="' + pts + '"/></svg>';

  // Classification -> annotation tag.
  // Support QuPath (classification.name), our exported GeoJSON (label),
  // and common alternatives (name/className/type). This prevents everything
  // from falling back to "other" purple.
  const cls = normalizeAnnoClassName(_featureClassName(feat) || 'other');

  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id:   String(feat.id || ('#' + Math.random().toString(36).substr(2, 9))),
    type: 'Annotation',
    body: [{ type: 'TextualBody', purpose: 'tagging', value: cls }],
    target: { selector: { type: 'SvgSelector', value: svg } },
    properties: { label: cls }
  };
}

function _flattenGeoJSON(raw) {
  let feats = [];
  if (raw && raw.type === 'FeatureCollection') feats = raw.features || [];
  else if (Array.isArray(raw))                 feats = raw;
  else if (raw)                                feats = [raw];

  const out = [];
  let skipped = 0;

  feats.forEach(feat => {
    const geo = feat.geometry || {};
    const cls = _featureClassName(feat);

    if (normalizeAnnoClassName(cls) === 'region') { skipped++; return; }

    if (geo.type === 'Polygon') {
      out.push(feat);
    } else if (geo.type === 'MultiPolygon') {
      (geo.coordinates || []).forEach((polyCoords, i) => {
        const outer = polyCoords[0] || [];
        if (outer.length < 4) { skipped++; return; }
        const xs = outer.map(p => p[0]), ys = outer.map(p => p[1]);
        const w = Math.max(...xs) - Math.min(...xs);
        const h = Math.max(...ys) - Math.min(...ys);
        if (w < 5 && h < 5) { skipped++; return; }
        out.push({ ...feat,
          id: (feat.id || ('mp' + Date.now())) + '_part' + i,
          geometry: { type: 'Polygon', coordinates: polyCoords } });
      });
    } else {
      out.push(feat);
    }
  });
  return { features: out, skipped };
}

function onImportFile(input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const raw = JSON.parse(e.target.result);
      const { features, skipped } = _flattenGeoJSON(raw);

      if (!S.anno) {
        alert('Viewer not ready. Load a slide first.');
        return;
      }

      let added = 0;
      features.forEach(f => {
        const ann = _geojsonToAnnotation(f);
        if (!ann) return;
        try {
          ann.properties = { ...(ann.properties || {}), imported: true, source: 'imported_geojson' };
          S.anno.addAnnotation(ann);
          if (!S.importedAnnoIds) S.importedAnnoIds = [];
          S.importedAnnoIds.push(ann.id);
          added++;
        }
        catch(err) { console.warn('addAnnotation failed:', err); }
      });

      const msg = 'Imported ' + added + ' annotations'
                + (skipped ? ' (' + skipped + ' skipped: Region* / degenerate)' : '');
      // Force Annotorious to re-render imported annotations with class colors.
      try { S.anno.setAnnotations(S.anno.getAnnotations()); } catch(e) {}

      statusText(msg);
      updateAnnoCount(0);
    } catch (err) {
      alert('Invalid GeoJSON: ' + err.message);
    }
  };
  reader.readAsText(file);
  input.value = '';
}

// ===========================================================================
// THRESHOLD OVERLAY
// ===========================================================================

function _drawLymphPoint(ctx, ti, coords, shown, canvas) {
  const vpPt = ti.imageToViewportCoordinates(coords[0], coords[1]);
  const sPt  = S.osdHE.viewport.viewportToViewerElementCoordinates(vpPt);
  if (sPt.x < -8 || sPt.x > canvas.width + 8 || sPt.y < -8 || sPt.y > canvas.height + 8) return;
  ctx.beginPath();
  ctx.arc(sPt.x, sPt.y, shown ? 3.8 : 2.5, 0, Math.PI * 2);
  ctx.fillStyle = shown ? '#27ae60' : 'rgba(90,130,160,0.15)';
  ctx.fill();
  if (shown) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }
}

function _drawLymphRing(ctx, ti, ring, shown, canvas) {
  if (!Array.isArray(ring) || ring.length < 3) return;
  let drawn = false;
  ctx.beginPath();
  ring.forEach((pt, idx) => {
    const vpPt = ti.imageToViewportCoordinates(pt[0], pt[1]);
    const sPt  = S.osdHE.viewport.viewportToViewerElementCoordinates(vpPt);
    if (idx === 0) ctx.moveTo(sPt.x, sPt.y);
    else ctx.lineTo(sPt.x, sPt.y);
    if (sPt.x >= -50 && sPt.x <= canvas.width + 50 && sPt.y >= -50 && sPt.y <= canvas.height + 50) drawn = true;
  });
  ctx.closePath();
  if (!drawn) return;
  ctx.fillStyle   = shown ? 'rgba(39,174,96,0.22)' : 'rgba(90,130,160,0.06)';
  ctx.strokeStyle = shown ? '#27ae60' : 'rgba(90,130,160,0.20)';
  ctx.lineWidth   = shown ? 1.3 : 0.7;
  ctx.fill();
  ctx.stroke();
}


function clearLymphocyteOverlay(silent = false) {
  TH.features = [];
  TH.scores = [];
  TH_BINS = [];
  TH.threshold = 0.10;
  const slider = document.getElementById('threshSlider');
  if (slider) slider.value = 10;
  const val = document.getElementById('thVal');
  if (val) val.textContent = '0.10';
  ['thN', 'thTot', 'thH'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  });
  const sel = document.getElementById('thCellType');
  if (sel) {
    sel.innerHTML = '<option>Import to begin...</option>';
    sel.disabled = true;
  }
  const noData = document.getElementById('thNoData');
  if (noData) {
    noData.textContent = 'No data loaded';
    noData.style.display = 'block';
  }
  if (TH.chart) {
    try { TH.chart.destroy(); } catch(e) {}
    TH.chart = null;
  }
  const canvas = document.getElementById('lymphOverlay');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (!silent) statusText('Cleared lymphocyte overlay');
}

function thDrawOverlay() {
  const canvas = document.getElementById('lymphOverlay');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width  = canvas.parentElement?.clientWidth  || canvas.width;
  canvas.height = canvas.parentElement?.clientHeight || canvas.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!TH.features.length || !S.osdHE) return;
  const ti = S.osdHE.world?.getItemAt(0); if (!ti) return;

  TH.features.forEach((f, i) => {
    const score = TH.scores[i] ?? 1;
    const shown = score >= TH.threshold;
    const geo = f.geometry || {};
    const coords = geo.coordinates;
    if (!coords) return;

    if (geo.type === 'Point') {
      _drawLymphPoint(ctx, ti, coords, shown, canvas);
    } else if (geo.type === 'Polygon') {
      _drawLymphRing(ctx, ti, coords[0], shown, canvas);
    } else if (geo.type === 'MultiPolygon') {
      (coords || []).forEach(poly => _drawLymphRing(ctx, ti, poly[0], shown, canvas));
    }
  });
}


