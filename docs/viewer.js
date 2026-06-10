/**
 * viewer.js — Pathogene Demo
 * pywebview 제거 → Flask REST API (/api/...) 직접 호출
 */

// ── API 헬퍼 ────────────────────────────────────────────────────────────────
const BASE_URL = window.location.origin;

async function apiJSON(path, opts = {}) {
    const res = await fetch(BASE_URL + path, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${path}`);
    return res.json();
}

// ── 상태 ──────────────────────────────────────────────────────────────────
let currentSlideId = null;
let slideDziMap    = {};
let viewerLeft     = null, viewerRight = null, annotorious = null;
let syncEnabled    = false, isSyncing  = false;
let syncLastLeft   = null;

let cosmxVisible  = true,  cosmxData  = null;
let cosmxState    = { rotation:0, flipX:false, flipY:false, scale:1.0 };
let sidePanelOpen = true;
let pointOverlayState = null;

const LABEL_COLORS = {
    tumor:      { stroke:'#e74c3c', fill:'rgba(231,76,60,0.2)'   },
    stroma:     { stroke:'#2ecc71', fill:'rgba(46,204,113,0.2)'  },
    lymphocyte: { stroke:'#00ffff', fill:'rgba(0,255,255,0.2)'   },
    'in-situ':  { stroke:'#f1c40f', fill:'rgba(241,196,15,0.2)'  },
    other:      { stroke:'#9b59b6', fill:'rgba(155,89,182,0.2)'  },
};

const el = id => document.getElementById(id);

// ── INIT ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    showScreen('viewer');
    await loadRecentSlides();
});

// ── SCREEN ────────────────────────────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el('screen-' + id).classList.add('active');
    if (id === 'viewer' && !viewerLeft) initViewers();
}
function goRegister() { showScreen('register'); }
function goViewer()   { showScreen('viewer'); }
function goSetup()    { goRegister(); }

// ── RECENT SLIDES ─────────────────────────────────────────────────────────
async function loadRecentSlides() {
    try {
        const slides = await apiJSON('/api/slides');
        slideDziMap  = {};
        slides.forEach(s => { slideDziMap[s.id] = s.dzi_url; });

        const sel = el('slideSelect');
        if (sel) {
            sel.innerHTML = '<option value="">Select slide...</option>';
            slides.forEach(s => {
                const o       = document.createElement('option');
                o.value       = s.id;
                o.textContent = s.id;
                sel.appendChild(o);
            });
        }

        const sec  = el('recentSection');
        const list = el('recentList');
        setViewerEmpty(slides.length === 0);
        if (slides.length && sec && list) {
            sec.style.display = 'block';
            list.innerHTML = slides.map(s =>
                `<button class="recent-chip" onclick="openSlideById('${s.id}')">${s.id}</button>`
            ).join('');
        }
    } catch(e) { console.error('[loadRecentSlides]', e); }
}

async function openSlideById(slideId) {
    if (!slideDziMap[slideId]) await loadRecentSlides();
    if (!slideDziMap[slideId]) return;
    showScreen('viewer');
    setViewerEmpty(false);
    await new Promise(r => setTimeout(r, 100));
    el('viewerSlideChip').textContent = slideId;
    const sel = el('slideSelect'); if (sel) sel.value = slideId;
    loadSlide(slideId);
}

// ── VIEWERS ───────────────────────────────────────────────────────────────
function initViewers() {
    const opts = {
        prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
        showNavigator: true,
        navigatorPosition: 'TOP_RIGHT',
        gestureSettingsMouse: {
            scrollToZoom: true,
            clickToZoom: false,
            dragToPan: false
        },
    };

    viewerLeft  = OpenSeadragon({ id:'viewerLeft',  ...opts });
    viewerRight = OpenSeadragon({ id:'viewerRight', ...opts });

    annotorious = OpenSeadragon.Annotorious(viewerLeft, {
        readOnly: true,
        allowEmpty: true,
        drawOnSingleClick: false,
        disableEditor: true,
        formatter: a => {
            const lbl = a.body?.find(b => b.purpose === 'tagging')?.value || 'other';
            const s   = LABEL_COLORS[lbl] || LABEL_COLORS.other;
            return { style: `stroke:${s.stroke};stroke-width:2;fill:${s.fill};` };
        },
    });

    setupSync();

    window.addEventListener('keydown', e => {
        if (e.code === 'Space') {
            viewerLeft.gestureSettingsMouse.dragToPan  = true;
            viewerRight.gestureSettingsMouse.dragToPan = true;
            e.preventDefault();
        }
    });

    window.addEventListener('keyup', e => {
        if (e.code === 'Space') {
            viewerLeft.gestureSettingsMouse.dragToPan  = false;
            viewerRight.gestureSettingsMouse.dragToPan = false;
        }
    });
}

async function loadSlide(slideId) {
    if (!viewerLeft) return;

    currentSlideId = slideId;
    annotorious?.clearAnnotations();
    clearPointOverlay();
    clearCosMxOverlay(true);

    syncLastLeft = null;

    cosmxState = { rotation:0, flipX:false, flipY:false, scale:1.0 };
    updateAlignUI();
    loadQC();

    const dziUrl = slideDziMap[slideId];
    if (!dziUrl) return;

    viewerLeft.open(dziUrl);
    viewerRight.close();

    await new Promise(r => viewerLeft.addOnceHandler('open', r));

    captureLeftSyncState();
    await loadCosMx();
    updateAnnoCount();
}

function onSlideChange(id) {
    if (id) openSlideById(id);
}

// ── QC ────────────────────────────────────────────────────────────────────
async function loadQC() {
    try {
        const data = await apiJSON(`/api/qc/${currentSlideId}`);
        renderQCBadge(data.status || 'unreviewed');
    } catch(e) {
        renderQCBadge('unreviewed');
    }
}

async function setQC(status) {
    if (!currentSlideId) return;
    try {
        await apiJSON(`/api/qc/${currentSlideId}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ status }),
        });
        renderQCBadge(status);
    } catch(e) {
        console.error('[setQC]', e);
    }
}

function renderQCBadge(status) {
    const e = el('qcBadge');
    if (!e) return;

    e.className = 'qc-badge';

    if (status === 'approved') {
        e.classList.add('approved');
        e.textContent = '✅ Approved';
    } else if (status === 'rejected') {
        e.classList.add('rejected');
        e.textContent = '❌ Rejected';
    } else {
        e.textContent = 'Unreviewed';
    }
}

// ── ANNOTATION IMPORT ─────────────────────────────────────────────────────
function onImportFile(input) {
    if (!input.files[0]) return;

    const reader = new FileReader();

    reader.onload = e => {
        try {
            const gj = JSON.parse(e.target.result);
            if (!gj.features) return alert('Invalid GeoJSON');

            const pts  = gj.features.filter(f => f.geometry.type === 'Point');
            const poly = gj.features.filter(f =>
                f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'
            );

            let total = 0;

            if (poly.length) {
                const annos = poly.map(f => {
                    const coords = f.geometry.type === 'Polygon'
                        ? f.geometry.coordinates[0]
                        : f.geometry.coordinates[0][0];

                    const raw = f.properties?.classification?.name
                              || f.properties?.name
                              || f.properties?.label
                              || 'other';

                    return {
                        '@context': 'http://www.w3.org/ns/anno.jsonld',
                        type: 'Annotation',
                        body: [{
                            type: 'TextualBody',
                            purpose: 'tagging',
                            value: String(raw).toLowerCase()
                        }],
                        target: {
                            selector: {
                                type: 'SvgSelector',
                                value: `<svg><polygon points="${coords.map(([x,y])=>`${x},${y}`).join(' ')}"/></svg>`
                            }
                        },
                    };
                });

                annotorious.clearAnnotations();
                annos.forEach(a => annotorious.addAnnotation(a));
                setTimeout(() => annotorious.setAnnotations(annotorious.getAnnotations()), 100);
                total += annos.length;
            }

            if (pts.length) {
                renderPointOverlay(pts);
                total += pts.length;
            }

            updateAnnoCount(total);
        } catch(err) {
            alert('Import failed: ' + err.message);
        }
    };

    reader.readAsText(input.files[0]);
    input.value = '';
}

// ── POINT OVERLAY ─────────────────────────────────────────────────────────
function renderPointOverlay(features) {
    clearPointOverlay();

    const ti = viewerLeft.world.getItemAt(0);
    if (!ti) return;

    const sz = ti.getContentSize();
    const tl = ti.imageToViewportCoordinates(0, 0);
    const br = ti.imageToViewportCoordinates(sz.x, sz.y);

    const NS  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');

    svg.setAttribute('viewBox', `0 0 ${sz.x} ${sz.y}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;';

    const c = LABEL_COLORS.lymphocyte;
    const r = 20;

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', features.map(f => {
        const [cx, cy] = f.geometry.coordinates;
        return `M${cx-r},${cy}A${r},${r},0,1,0,${cx+r},${cy}A${r},${r},0,1,0,${cx-r},${cy}Z`;
    }).join(' '));
    path.setAttribute('fill', c.fill);
    path.setAttribute('stroke', c.stroke);
    path.setAttribute('stroke-width', r * 0.5);

    svg.appendChild(path);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'pointer-events:none;position:absolute;width:100%;height:100%;';
    wrap.appendChild(svg);

    viewerLeft.addOverlay({
        element:  wrap,
        location: new OpenSeadragon.Rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y),
    });

    pointOverlayState = { el: wrap, count: features.length };
}

function clearPointOverlay() {
    if (!pointOverlayState) return;

    try {
        viewerLeft.removeOverlay(pointOverlayState.el);
    } catch(_) {}

    pointOverlayState = null;
}

// ── COSMX ─────────────────────────────────────────────────────────────────
async function loadCosMx() {
    try {
        clearCosMxOverlay(true);

        const info = await apiJSON(`/api/cosmx/${currentSlideId}/info`);
        if (!info.has_cosmx) return;

        const tf = await apiJSON(`/api/cosmx/${currentSlideId}/transform`);

        cosmxData = {
            dziUrl:       info.dzi_url,
            tiledImage:   null,
            transform:    info.registered ? { transform: 'identity' } : tf,
            isRegistered: !!info.registered,
        };

        if (cosmxVisible) await renderCosMxOverlay();
    } catch(e) {
        console.error('[CosMx]', e);
    }
}

async function renderCosMxOverlay() {
    if (!cosmxVisible || !cosmxData?.dziUrl || !viewerRight || cosmxData.tiledImage) return;

    viewerRight.addTiledImage({
        tileSource: cosmxData.dziUrl,
        opacity: 1.0,
        index: 0,
        success: ev => {
            cosmxData.tiledImage = ev.item;
            if (!cosmxData.isRegistered) {
                applyCosMxTransform(ev.item, cosmxData.transform);
            }
        },
    });
}

function applyCosMxTransform(item, td) {
    if (td.transform === 'identity' || !td.transform) return;

    const t  = td.transform;
    const he = viewerLeft.world.getItemAt(0);
    if (!he) return;

    const hb = he.getBounds();

    let r  = t.rotation || 0;
    let fx = t.flipX || false;
    let fy = t.flipY || false;

    let vX = {x:1,y:0};
    let vY = {x:0,y:1};

    const k = Math.floor(r / 90) % 4;
    for (let i = 0; i < k; i++) {
        vX = {x:vX.y, y:-vX.x};
        vY = {x:vY.y, y:-vY.x};
    }

    if (fx) {
        vX.x = -vX.x;
        vY.x = -vY.x;
    }

    if (fy) {
        vX.y = -vX.y;
        vY.y = -vY.y;
    }

    let osdFlip = false;
    let osdRot  = 0;

    outer:
    for (const fl of [false, true]) {
        for (const ro of [0, 90, 180, 270]) {
            let oX = {x:1,y:0};
            let oY = {x:0,y:1};

            if (fl) {
                oX.x = -oX.x;
                oY.x = -oY.x;
            }

            const rk = Math.floor(ro / 90) % 4;
            for (let i = 0; i < rk; i++) {
                oX = {x:-oX.y, y:oX.x};
                oY = {x:-oY.y, y:oY.x};
            }

            if (
                vX.x === oX.x && vX.y === oX.y &&
                vY.x === oY.x && vY.y === oY.y
            ) {
                osdFlip = fl;
                osdRot  = ro;
                break outer;
            }
        }
    }

    item.setRotation(osdRot, true);
    item.setFlip(osdFlip);

    const cxW = item.source.width;
    const cxH = item.source.height;
    const sc  = t.scale || 1;
    const W   = hb.width * sc;

    item.setWidth(W, true);

    let dx = 0;
    let dy = 0;

    if (t.translateX !== undefined) {
        dx = t.translateX * hb.width  + hb.x;
        dy = t.translateY * hb.height + hb.y;
    } else if (t.x !== undefined) {
        dx = t.x;
        dy = t.y;
    }

    const H  = W * (cxH / cxW);
    const tW = (osdRot % 180 !== 0) ? H : W;
    const tH = (osdRot % 180 !== 0) ? W : H;

    item.setPosition(
        new OpenSeadragon.Point(dx + tW / 2 - W / 2, dy + tH / 2 - H / 2),
        true
    );

    cosmxState = {
        rotation: r,
        flipX: fx,
        flipY: fy,
        scale: t.scale || 1
    };

    updateAlignUI();
}

function clearCosMxOverlay(reset = false) {
    if (viewerRight && cosmxData?.tiledImage) {
        viewerRight.world.removeItem(cosmxData.tiledImage);
    }

    if (reset) {
        cosmxData = null;
    } else if (cosmxData) {
        cosmxData.tiledImage = null;
    }
}

function toggleCosMx() {
    cosmxVisible = !cosmxVisible;

    const btn = el('btnCosMx');
    btn.textContent = cosmxVisible ? 'CosMx: ON' : 'CosMx: OFF';
    btn.classList.toggle('on', cosmxVisible);

    if (cosmxVisible) {
        if (cosmxData?.dziUrl) renderCosMxOverlay();
    } else {
        if (viewerRight && cosmxData?.tiledImage) {
            viewerRight.world.removeItem(cosmxData.tiledImage);
            cosmxData.tiledImage = null;
        }
    }
}

// ── ALIGNMENT ─────────────────────────────────────────────────────────────
function onRotInput(e) {
    el('rotVal').textContent = e.value;
    setRot(parseInt(e.value));
}

function onScaleInput(e) {
    el('scaleVal').textContent = parseFloat(e.value).toFixed(2);
    setScale(parseFloat(e.value));
}

function setRotPreset(deg) {
    el('rotSlider').value = deg;
    el('rotVal').textContent = deg;
    setRot(deg);

    document.querySelectorAll('.pr button').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.r) === deg)
    );
}

function setRot(d) {
    if (!cosmxData?.tiledImage) return;

    cosmxState.rotation = d;

    let r = d;
    let f = cosmxState.flipX;

    if (cosmxState.flipY) {
        r = (d + 180) % 360;
        f = !f;
    }

    cosmxData.tiledImage.setRotation(r, true);
    cosmxData.tiledImage.setFlip(f);
}

function toggleFlipX() {
    if (!cosmxData?.tiledImage) return;

    cosmxState.flipX = !cosmxState.flipX;
    el('btnFlipX').classList.toggle('on', cosmxState.flipX);

    let r = cosmxState.rotation;
    let f = cosmxState.flipX;

    if (cosmxState.flipY) {
        r = (r + 180) % 360;
        f = !f;
    }

    cosmxData.tiledImage.setRotation(r, true);
    cosmxData.tiledImage.setFlip(f);
}

function toggleFlipY() {
    if (!cosmxData?.tiledImage) return;

    cosmxState.flipY = !cosmxState.flipY;
    el('btnFlipY').classList.toggle('on', cosmxState.flipY);

    let r = cosmxState.rotation;
    let f = cosmxState.flipX;

    if (cosmxState.flipY) {
        r = (r + 180) % 360;
        f = !f;
    }

    cosmxData.tiledImage.setRotation(r, true);
    cosmxData.tiledImage.setFlip(f);
}

function setScale(sc) {
    if (!cosmxData?.tiledImage || !viewerLeft.world.getItemAt(0)) return;

    cosmxState.scale = sc;

    cosmxData.tiledImage.setWidth(
        viewerLeft.world.getItemAt(0).getBounds().width * sc,
        true
    );
}

function updateAlignUI() {
    const rs = el('rotSlider');
    if (rs) rs.value = cosmxState.rotation;

    const rv = el('rotVal');
    if (rv) rv.textContent = cosmxState.rotation;

    const ss = el('scaleSlider');
    if (ss) ss.value = cosmxState.scale;

    const sv = el('scaleVal');
    if (sv) sv.textContent = cosmxState.scale.toFixed(2);

    el('btnFlipX')?.classList.toggle('on', cosmxState.flipX);
    el('btnFlipY')?.classList.toggle('on', cosmxState.flipY);

    document.querySelectorAll('.pr button').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.r) === cosmxState.rotation)
    );
}

function saveCosMxPosition() {
    savePosition();
}

function savePosition() {
    if (!cosmxData?.tiledImage) return;

    const b  = cosmxData.tiledImage.getBounds();
    const hb = viewerLeft.world.getItemAt(0)?.getBounds() || {width:1, height:1};

    const out = {
        version: '4.0',
        slide_id: currentSlideId,
        transform: {
            rotation:   cosmxState.rotation,
            flipX:      cosmxState.flipX,
            flipY:      cosmxState.flipY,
            translateX: b.x / hb.width,
            translateY: b.y / hb.height,
            scale:      cosmxState.scale,
        },
    };

    console.log(JSON.stringify(out, null, 2));
    alert('Saved to console.');
}

// ── SYNC ──────────────────────────────────────────────────────────────────
// 핵심 변경:
// Sync ON 시 오른쪽 CosMx를 왼쪽 H&E 좌표로 강제로 맞추지 않음.
// 오른쪽은 현재 위치 그대로 두고, 이후 왼쪽 H&E의 pan/zoom 변화량만 따라감.

function captureLeftSyncState() {
    if (!viewerLeft?.viewport) {
        syncLastLeft = null;
        return;
    }

    syncLastLeft = {
        center: viewerLeft.viewport.getCenter().clone(),
        zoom:   viewerLeft.viewport.getZoom(),
    };
}

function setupSync() {
    if (!viewerLeft || !viewerRight || viewerLeft._deltaSyncInstalled) return;

    viewerLeft._deltaSyncInstalled = true;

    viewerLeft.addHandler('viewport-change', () => {
        if (!viewerLeft?.viewport) return;

        const curCenter = viewerLeft.viewport.getCenter();
        const curZoom   = viewerLeft.viewport.getZoom();

        if (!syncEnabled || isSyncing || !viewerRight?.viewport) {
            syncLastLeft = {
                center: curCenter.clone(),
                zoom: curZoom
            };
            return;
        }

        if (!syncLastLeft) {
            syncLastLeft = {
                center: curCenter.clone(),
                zoom: curZoom
            };
            return;
        }

        const dx = curCenter.x - syncLastLeft.center.x;
        const dy = curCenter.y - syncLastLeft.center.y;
        const zoomRatio = syncLastLeft.zoom > 0
            ? curZoom / syncLastLeft.zoom
            : 1;

        // 먼저 baseline 업데이트해서 중복 적용 방지
        syncLastLeft = {
            center: curCenter.clone(),
            zoom: curZoom
        };

        if (
            Math.abs(dx) < 1e-12 &&
            Math.abs(dy) < 1e-12 &&
            Math.abs(zoomRatio - 1) < 1e-9
        ) {
            return;
        }

        isSyncing = true;

        try {
            const rv = viewerRight.viewport;
            const rc = rv.getCenter();
            const rz = rv.getZoom();

            // 오른쪽 현재 zoom 기준으로 왼쪽 zoom 변화율만 적용
            rv.zoomTo(rz * zoomRatio, null, true);

            // 오른쪽 현재 center 기준으로 왼쪽 pan 변화량만 적용
            rv.panTo(
                new OpenSeadragon.Point(rc.x + dx, rc.y + dy),
                true
            );
        } finally {
            isSyncing = false;
        }
    });
}

function toggleSync() {
    syncEnabled = !syncEnabled;

    // 중요:
    // Sync ON 순간에는 오른쪽을 움직이지 않고,
    // 왼쪽의 현재 상태만 baseline으로 저장함.
    captureLeftSyncState();

    const btn = el('btnSync');
    if (btn) {
        btn.textContent = syncEnabled ? 'Sync: ON' : 'Sync: OFF';
        btn.classList.toggle('on', syncEnabled);
    }

    const st = el('syncStatus');
    if (st) {
        st.textContent = syncEnabled
            ? 'Following H&E movement only'
            : 'Independent panels';
    }
}

function resyncPanels() {
    // 기존처럼 H&E 좌표로 CosMx를 강제 이동하지 않음.
    // 현재 위치를 유지하고 baseline만 다시 잡음.
    captureLeftSyncState();

    const st = el('syncStatus');
    if (st) {
        st.textContent = syncEnabled
            ? 'Sync baseline reset'
            : 'Independent panels';
    }
}

// ── SIDE PANEL ────────────────────────────────────────────────────────────
function toggleSidePanel() {
    sidePanelOpen = !sidePanelOpen;

    el('sidePanel').classList.toggle('collapsed', !sidePanelOpen);
    el('expandBtn').style.display = sidePanelOpen ? 'none' : 'block';
}

// ── UTILS ─────────────────────────────────────────────────────────────────
function updateAnnoCount(v) {
    const e = el('annoCount');
    if (!e) return;

    e.textContent = (typeof v === 'number')
        ? v
        : ((annotorious?.getAnnotations().length || 0) + (pointOverlayState?.count || 0));
}

function setViewerEmpty(isEmpty) {
    const empty  = el('emptyState');
    const panels = el('panelsWrap');

    if (empty)  empty.style.display  = isEmpty ? 'flex' : 'none';
    if (panels) panels.style.display = isEmpty ? 'none' : 'flex';
}

function statusText(msg) {
    const e = el('statusText');
    if (e) e.textContent = msg;
}