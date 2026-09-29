import {
  EYES_MIN, EYES_MAX, TARGET_HEAD, TARGET_EYE_FROM_TOP, MAX_EYE_BLINK, DIGITAL_PX, PRINT_DPI, PHOTO_IN,
  HEAD_PER_EYE_CHIN,
  headGeometry, geometryChecks, lightingChecks, regionStats, mergeStats,
  mapPoint, unmapPoint, panTransform, anchorTransform, autoTransform, coverTransform, coversImage,
  setJpegDpi,
} from './spec.js';
import { loadFaceDetector, faceDetectorReady, detectFace } from './face.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const camOverlay = $('cam-overlay');
const camMessage = $('cam-message');
const editCanvas = $('edit-canvas');
const editOverlay = $('edit-overlay');
const work = $('work');
const workCtx = work.getContext('2d', { willReadFrequently: true });

const TIMERS = [0, 3, 10];
const AUTO_HOLD_MS = 1200;
const ANALYSIS_PX = 160;

const state = {
  facing: 'environment',
  mirrored: false,
  stream: null,
  camActive: false,
  detector: 'loading', // loading | ready | failed
  timerIdx: 0,
  auto: false,
  counting: false,
  goodSince: 0,
  pixelChecks: [],
  lastDetect: 0,
  lastPixels: 0,
  // edit
  src: null,        // canvas holding the captured / uploaded photo
  det: null,        // face detection on src (source pixels)
  t: null,          // current transform
  baseScale: 1,
  renderQueued: false,
  editChecks: [],
  // result
  digitalBlob: null,
  printBlob: null,
};

const mkCheck = (id, ok, label, hint) => ({ id, ok, label, hint: ok ? '' : hint });
const mapFace = (face, fn) => Object.fromEntries(Object.entries(face).map(([k, p]) => [k, fn(p)]));

// ---------------------------------------------------------------- views

function show(view) {
  for (const el of document.querySelectorAll('.view')) el.classList.toggle('active', el.id === `view-${view}`);
  if (view === 'camera') startCamera();
  else stopCamera();
}

$('btn-rules').addEventListener('click', () => $('rules').showModal());

// ---------------------------------------------------------------- camera

async function startCamera() {
  if (state.camActive) return;
  state.camActive = true;
  camMessage.textContent = 'Starting camera…';
  camMessage.className = 'message';
  if (!navigator.mediaDevices?.getUserMedia) {
    camMessage.textContent = 'Camera not available (needs HTTPS). Use Upload instead.';
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1920 } },
    });
  } catch (err) {
    state.camActive = false;
    camMessage.textContent = `Camera unavailable (${err.name}). Use Upload instead.`;
    return;
  }
  if (!state.camActive) { // left the view while waiting for permission
    stopTracks();
    return;
  }
  const settings = state.stream.getVideoTracks()[0]?.getSettings?.() ?? {};
  state.mirrored = (settings.facingMode ?? state.facing) === 'user';
  video.classList.toggle('mirror', state.mirrored);
  camOverlay.classList.toggle('mirror', state.mirrored);
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  requestAnimationFrame(camLoop);
}

function stopTracks() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

function stopCamera() {
  state.camActive = false;
  state.goodSince = 0;
  stopTracks();
  video.srcObject = null;
}

function videoSquare() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const side = Math.min(vw, vh);
  return { vw, vh, side, ox: (vw - side) / 2, oy: (vh - side) / 2 };
}

function camLoop(now) {
  if (!state.camActive) return;
  requestAnimationFrame(camLoop);
  if (now - state.lastDetect < 80 || video.readyState < 2 || !video.videoWidth) return;
  state.lastDetect = now;

  const sq = videoSquare();
  const toUnit = (p) => ({ x: (p.x - sq.ox) / sq.side, y: (p.y - sq.oy) / sq.side });
  const checks = [];
  let faceU = null;
  let g = null;

  if (faceDetectorReady()) {
    const det = detectFace(video, sq.vw, sq.vh);
    if (!det.count) {
      checks.push(mkCheck('face', false, 'Face found', 'No face found – step into the frame or move closer'));
    } else {
      checks.push(mkCheck('single', det.count === 1, 'Only one person', 'Only one person may be in the photo'));
      faceU = mapFace(det.face, toUnit);
      g = headGeometry(faceU);
      checks.push(...geometryChecks(g, { mirrored: state.mirrored }));
      checks.push(mkCheck('open', det.blink < MAX_EYE_BLINK, 'Eyes open', 'Keep both eyes open'));
    }
  }

  if (now - state.lastPixels > 400) {
    state.lastPixels = now;
    work.width = work.height = ANALYSIS_PX;
    workCtx.drawImage(video, sq.ox, sq.oy, sq.side, sq.side, 0, 0, ANALYSIS_PX, ANALYSIS_PX);
    state.pixelChecks = measurePixels(workCtx, ANALYSIS_PX, faceU, g);
  }
  checks.push(...state.pixelChecks);

  drawGuides(camOverlay, g, checks);
  renderChecks($('cam-checks'), checks);

  const failed = checks.find((c) => !c.ok);
  const allGood = faceDetectorReady() && checks.length > 0 && !failed;
  if (state.counting) return;
  if (state.detector === 'loading') camMessage.textContent = 'Loading face guide… line up with the oval';
  else if (state.detector === 'failed') camMessage.textContent = 'Face guide unavailable – line up with the oval';
  else camMessage.textContent = failed ? failed.hint : (state.auto ? 'Perfect – hold still…' : 'Looks good – take the photo');
  camMessage.className = `message${allGood ? ' ok' : ''}`;

  if (state.auto && allGood) {
    state.goodSince ||= now;
    if (now - state.goodSince > AUTO_HOLD_MS) capture();
  } else {
    state.goodSince = 0;
  }
}

$('btn-shutter').addEventListener('click', () => {
  if (state.counting || !state.stream) return;
  const secs = TIMERS[state.timerIdx];
  if (!secs) { capture(); return; }
  state.counting = true;
  const el = $('countdown');
  let n = secs;
  el.hidden = false;
  el.textContent = n;
  const iv = setInterval(() => {
    n -= 1;
    if (n > 0) { el.textContent = n; return; }
    clearInterval(iv);
    el.hidden = true;
    state.counting = false;
    if (state.camActive) capture();
  }, 1000);
});

$('btn-timer').addEventListener('click', () => {
  state.timerIdx = (state.timerIdx + 1) % TIMERS.length;
  const s = TIMERS[state.timerIdx];
  $('timer-label').textContent = s ? `${s}s` : 'Off';
});

$('btn-auto').addEventListener('click', (e) => {
  state.auto = !state.auto;
  e.currentTarget.setAttribute('aria-pressed', String(state.auto));
});

$('btn-flip').addEventListener('click', () => {
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  stopCamera();
  startCamera();
});

function capture() {
  if (!video.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0); // stored un-mirrored, as others see you
  openEditor(c);
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    img.src = url;
    await img.decode();
  } catch {
    alert('Could not open that image.');
    return;
  } finally {
    URL.revokeObjectURL(url);
  }
  const max = 3000;
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  openEditor(c);
});

// ---------------------------------------------------------------- analysis & drawing

// Background / lighting checks on a square canvas holding the photo area.
function measurePixels(ctx, size, faceU, g) {
  const { data } = ctx.getImageData(0, 0, size, size);
  const R = (x, y, w, h) => ({ x: x * size, y: y * size, w: w * size, h: h * size });
  const bg = mergeStats([
    regionStats(data, size, R(0.02, 0.03, 0.14, 0.27)),
    regionStats(data, size, R(0.84, 0.03, 0.14, 0.27)),
  ]);
  let faceLeft = null;
  let faceRight = null;
  if (faceU && g) {
    const x0 = Math.min(faceU.cheekA.x, faceU.cheekB.x);
    const x1 = Math.max(faceU.cheekA.x, faceU.cheekB.x);
    const y0 = g.eye.y + (g.chin.y - g.eye.y) * 0.15;
    const y1 = g.eye.y + (g.chin.y - g.eye.y) * 0.55;
    const ex = g.eye.x;
    const lw = (ex - x0) * 0.55;
    const rw = (x1 - ex) * 0.55;
    if (lw > 0.01 && rw > 0.01 && y1 > y0) {
      faceLeft = regionStats(data, size, R(x0 + (ex - x0) * 0.25, y0, lw, y1 - y0));
      faceRight = regionStats(data, size, R(ex + (x1 - ex) * 0.2, y0, rw, y1 - y0));
    }
  }
  return lightingChecks({ bg, faceLeft, faceRight });
}

function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const size = Math.round(canvas.clientWidth * dpr);
  if (canvas.width !== size || canvas.height !== size) canvas.width = canvas.height = size;
  return size;
}

function drawGuides(canvas, g, checks) {
  const S = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.lineWidth = Math.max(1.5, S / 300);

  // Allowed eye band (1 1/8 – 1 3/8 in from the bottom).
  const eyeTop = (1 - EYES_MAX) * S;
  const eyeBot = (1 - EYES_MIN) * S;
  ctx.fillStyle = 'rgba(47,191,113,0.16)';
  ctx.fillRect(0, eyeTop, S, eyeBot - eyeTop);
  ctx.strokeStyle = 'rgba(47,191,113,0.8)';
  ctx.setLineDash([S / 60, S / 80]);
  for (const y of [eyeTop, eyeBot]) line(ctx, 0, y, S, y);

  // Target head outline (top of hair to chin = TARGET_HEAD of the height).
  const top = (TARGET_EYE_FROM_TOP - (TARGET_HEAD * (HEAD_PER_EYE_CHIN - 1)) / HEAD_PER_EYE_CHIN) * S;
  const headH = TARGET_HEAD * S;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.ellipse(S / 2, top + headH / 2, headH * 0.37, headH / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  line(ctx, S / 2, 0, S / 2, S);
  ctx.setLineDash([]);

  // Measured head: crown and chin markers + eye line.
  if (g) {
    const ok = (id) => checks.find((c) => c.id === id)?.ok !== false;
    const w = S * 0.18;
    const cx = g.eye.x * S;
    ctx.strokeStyle = ok('size') ? '#2fbf71' : '#ff6b5b';
    ctx.lineWidth = Math.max(3, S / 150);
    line(ctx, cx - w, g.top.y * S, cx + w, g.top.y * S);
    line(ctx, cx - w, g.chin.y * S, cx + w, g.chin.y * S);
    line(ctx, cx, g.top.y * S, cx, g.chin.y * S);
    ctx.strokeStyle = ok('eyes') && ok('level') ? '#2fbf71' : '#ff6b5b';
    const dx = Math.cos(g.roll) * w * 1.3;
    const dy = Math.sin(g.roll) * w * 1.3;
    line(ctx, cx - dx, g.eye.y * S - dy, cx + dx, g.eye.y * S + dy);
  }
}

function line(ctx, x0, y0, x1, y1) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function renderChecks(ul, checks) {
  const html = checks.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}">${c.label}</li>`).join('');
  if (ul.innerHTML !== html) ul.innerHTML = html;
}

function drawTransformed(ctx, S, src, t) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, S, S);
  ctx.translate(S / 2, S / 2);
  ctx.rotate(t.rotation);
  ctx.scale(t.scale * S, t.scale * S);
  ctx.translate(-t.cx, -t.cy);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0);
  ctx.restore();
}

// ---------------------------------------------------------------- editor

function openEditor(src) {
  state.src = src;
  state.det = null;
  show('edit');
  if (faceDetectorReady()) {
    try { state.det = detectFace(src, src.width, src.height); } catch { state.det = null; }
  }
  autoFit();
}

function autoFit() {
  const face = state.det?.face;
  state.t = face ? autoTransform(face) : coverTransform(state.src.width, state.src.height);
  state.baseScale = state.t.scale;
  syncSliders();
  queueRender();
}

function syncSliders() {
  $('zoom').value = Math.log2(state.t.scale / state.baseScale).toFixed(3);
  $('rotate').value = ((state.t.rotation * 180) / Math.PI).toFixed(1);
}

function queueRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderEdit();
  });
}

function renderEdit() {
  const { src, t } = state;
  const S = fitCanvas(editCanvas);
  drawTransformed(editCanvas.getContext('2d'), S, src, t);

  const checks = [];
  let faceU = null;
  let g = null;
  if (state.det?.face) {
    checks.push(mkCheck('single', state.det.count === 1, 'Only one person', 'Only one person may be in the photo'));
    faceU = mapFace(state.det.face, (p) => mapPoint(t, p));
    g = headGeometry(faceU);
    checks.push(...geometryChecks(g));
    checks.push(mkCheck('open', state.det.blink < MAX_EYE_BLINK, 'Eyes open', 'Retake with both eyes open'));
  } else if (faceDetectorReady()) {
    checks.push(mkCheck('face', false, 'Face found', 'No face found – align manually'));
  }
  checks.push(mkCheck('fill', coversImage(t, src.width, src.height), 'Photo fills the frame',
    'Zoom in – there are empty edges'));

  work.width = work.height = ANALYSIS_PX;
  drawTransformed(workCtx, ANALYSIS_PX, src, t);
  checks.push(...measurePixels(workCtx, ANALYSIS_PX, faceU, g));

  state.editChecks = checks;
  drawGuides(editOverlay, g, checks);
  renderChecks($('edit-checks'), checks);
}

// Gestures: one finger pans, two fingers pinch-zoom and rotate.
const pointers = new Map();
const stage = $('edit-stage');

function gesture() {
  const pts = [...pointers.values()];
  const rect = stage.getBoundingClientRect();
  const toUnit = (p) => ({ x: (p.x - rect.left) / rect.width, y: (p.y - rect.top) / rect.height });
  if (pts.length === 1) return { mid: toUnit(pts[0]), dist: 0, ang: 0 };
  const [a, b] = pts;
  return {
    mid: toUnit({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
    dist: Math.hypot(b.x - a.x, b.y - a.y),
    ang: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

let lastGesture = null;
stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  lastGesture = gesture();
});
stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !state.t) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const cur = gesture();
  const prev = lastGesture;
  lastGesture = cur;
  if (!prev) return;
  let t = panTransform(state.t, cur.mid.x - prev.mid.x, cur.mid.y - prev.mid.y);
  if (pointers.size >= 2 && prev.dist > 0) {
    const p = unmapPoint(t, cur.mid);
    t = anchorTransform({
      ...t,
      scale: t.scale * (cur.dist / prev.dist),
      rotation: t.rotation + (cur.ang - prev.ang),
    }, p, cur.mid);
  }
  state.t = t;
  syncSliders();
  queueRender();
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  lastGesture = pointers.size ? gesture() : null;
};
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAboutCenter(state.t.scale * Math.exp(-e.deltaY * 0.001), state.t.rotation);
}, { passive: false });

function zoomAboutCenter(scale, rotation) {
  const c = { x: 0.5, y: 0.5 };
  const p = unmapPoint(state.t, c);
  state.t = anchorTransform({ ...state.t, scale, rotation }, p, c);
  syncSliders();
  queueRender();
}

$('zoom').addEventListener('input', (e) => {
  zoomAboutCenter(state.baseScale * 2 ** Number(e.target.value), state.t.rotation);
});
$('rotate').addEventListener('input', (e) => {
  zoomAboutCenter(state.t.scale, (Number(e.target.value) * Math.PI) / 180);
});
$('btn-autofit').addEventListener('click', autoFit);
$('btn-retake').addEventListener('click', () => show('camera'));
window.addEventListener('resize', () => { if (state.src) queueRender(); });

// ---------------------------------------------------------------- export

async function toJpeg(canvas, quality, dpi) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  const bytes = setJpegDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
  return new Blob([bytes], { type: 'image/jpeg' });
}

function renderPhoto(px) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  drawTransformed(c.getContext('2d'), px, state.src, state.t);
  return c;
}

function renderPrintSheet() {
  const dpi = PRINT_DPI;
  const photo = renderPhoto(PHOTO_IN * dpi);
  const c = document.createElement('canvas');
  c.width = 6 * dpi;   // 4 x 6 in, landscape
  c.height = 4 * dpi;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const size = photo.width;
  const gap = dpi * 2 / 3;
  const x0 = (c.width - size * 2 - gap) / 2;
  const y0 = (c.height - size) / 2;
  ctx.strokeStyle = '#aaa';
  ctx.lineWidth = 2;
  for (const x of [x0, x0 + size + gap]) {
    ctx.drawImage(photo, x, y0);
    ctx.strokeRect(x - 1, y0 - 1, size + 2, size + 2);
  }
  ctx.fillStyle = '#888';
  ctx.font = `${Math.round(dpi / 12)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('Each photo is 2 × 2 in. Print this 4 × 6 in sheet at actual size, then cut on the gray lines.',
    c.width / 2, c.height - dpi / 5);
  return c;
}

$('btn-done').addEventListener('click', async () => {
  const btn = $('btn-done');
  btn.disabled = true;
  try {
    state.digitalBlob = await toJpeg(renderPhoto(DIGITAL_PX), 0.92, DIGITAL_PX / PHOTO_IN);
    state.printBlob = await toJpeg(renderPrintSheet(), 0.95, PRINT_DPI);
    const img = $('result-img');
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(state.digitalBlob);
    renderChecks($('result-checks'), state.editChecks);
    show('result');
  } finally {
    btn.disabled = false;
  }
});

async function save(blob, name) {
  const file = new File([blob], name, { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

$('btn-save-digital').addEventListener('click', () => save(state.digitalBlob, 'passport-photo-2x2.jpg'));
$('btn-save-print').addEventListener('click', () => save(state.printBlob, 'passport-photos-4x6.jpg'));
$('btn-back').addEventListener('click', () => { show('edit'); queueRender(); });
$('btn-new').addEventListener('click', () => show('camera'));

// ---------------------------------------------------------------- boot

startCamera();
loadFaceDetector()
  .then(() => {
    state.detector = 'ready';
    // A photo may have been uploaded before the model finished loading.
    if (state.src && !state.det && $('view-edit').classList.contains('active')) {
      state.det = detectFace(state.src, state.src.width, state.src.height);
      if (state.det?.face) autoFit();
    }
  })
  .catch((err) => {
    console.warn('Face detection unavailable:', err);
    state.detector = 'failed';
  });
