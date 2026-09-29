import {
  COUNTRIES, PRINT_DPI, MAX_EYE_BLINK, layout, headGeometry, geometryChecks, lightingChecks,
  regionStats, mergeStats, mapPoint, unmapPoint, panTransform, anchorTransform, autoTransform,
  coverTransform, coversImage, sheetLayout, setJpegDpi,
} from './spec.js';
import { NEUTRAL, isNeutral, autoEnhance, applyEnhance, maskToAlpha } from './enhance.js';
import { loadFaceDetector, faceDetectorReady, detectFace, segmentBackground } from './face.js';

// One screen: the photo frame (live camera or captured photo), a guidance
// bubble that says what to fix next (green ✓ when compliant), and a dock with
// Upload · Capture/Save · Settings.

const $ = (id) => document.getElementById(id);
const video = $('video');
const stage = $('stage');
const photo = $('photo');
const overlay = $('overlay');
const work = $('work');
const workCtx = work.getContext('2d', { willReadFrequently: true });

const TIMERS = [0, 3, 10];
const AUTO_HOLD_MS = 1200;
const ANALYSIS_H = 180;

// Which problem the bubble talks about first.
const PRIORITY = ['face', 'single', 'dark', 'bright', 'size', 'frame', 'center', 'eyes', 'top',
  'level', 'facing', 'pitch', 'open', 'fill', 'res', 'bg-color', 'bg-plain', 'even'];
const ICONS = {
  face: '👤', single: '👥', dark: '💡', bright: '🔆', size: '↔', frame: '⤢', center: '⇆',
  eyes: '⇅', top: '⇅', level: '↻', facing: '👀', pitch: '📱', open: '👁', fill: '⤢', res: '🔍',
  'bg-color': '🧱', 'bg-plain': '🧱', even: '🌗',
};
const WARN_IDS = new Set(['bg-color', 'bg-plain', 'even']);

const state = {
  country: COUNTRIES.us,
  L: layout(COUNTRIES.us),
  mode: 'live',     // 'live' camera | 'photo' captured/uploaded
  facing: 'environment',
  mirrored: false,
  stream: null,
  camActive: false,
  introShown: false,
  detector: 'loading', // loading | ready | failed
  timerIdx: 0,
  counting: false,
  goodSince: 0,
  pixelChecks: [],
  lastDetect: 0,
  lastPixels: 0,
  lastProblem: '',
  guide: { g: null, checks: [] },
  // photo
  src: null,        // canvas holding the captured / uploaded photo
  det: null,        // face detection on src (source pixels)
  t: null,          // current transform
  baseScale: 1,
  enh: { ...NEUTRAL },
  bg: 'original',   // 'original' | '#rrggbb' | 'transparent'
  mask: null,       // canvas, alpha = person
  dragging: false,
  renderQueued: false,
  autoEnhanced: false,
  // export
  digitalBlob: null,
  printBlob: null,
};

const mkCheck = (id, ok, label, hint, cue = null) => ({ id, ok, label, hint: ok ? '' : hint, cue: ok ? null : cue });
const mapFace = (face, fn) => Object.fromEntries(Object.entries(face).map(([k, p]) => [k, fn(p)]));
const prefs = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const sheetOpen = () => $('settings').open || $('save').open || $('rules').open;

// ---------------------------------------------------------------- country

const countrySelect = $('country');
for (const c of Object.values(COUNTRIES)) countrySelect.add(new Option(`${c.flag} ${c.name} · ${c.sizeLabel}`, c.id));
countrySelect.addEventListener('change', () => setCountry(countrySelect.value));

function setCountry(id) {
  const c = COUNTRIES[id] ?? COUNTRIES.us;
  state.country = c;
  state.L = layout(c);
  countrySelect.value = c.id;
  prefs.set('country', c.id);
  document.documentElement.style.setProperty('--aspect', String(state.L.aspect));
  $('country-tag').textContent = `${c.flag} ${c.sizeLabel}`;
  $('rules-title').textContent = `${c.flag} ${c.name} photo rules`;
  $('rules-list').innerHTML = c.rules.map(([k, v]) => `<li><b>${k}:</b> ${v}</li>`).join('');
  $('rules-link').href = c.source;
  $('rules-link').textContent = new URL(c.source).hostname;
  $('intro-steps').innerHTML = introSteps(c).map((s) => `<li>${s}</li>`).join('');
  const sheet = sheetLayout(c.widthMm, c.heightMm);
  $('print-label').textContent = `${sheet.cols * sheet.rows} × ${c.sizeLabel} at ${PRINT_DPI} dpi`;
  state.pixelChecks = [];
  if (state.src) autoFit();
}

function introSteps(c) {
  return [
    `Stand about 1–1.5 m (4 ft) in front of a <b>${c.bgLabel}</b> wall, with space behind you so there’s no shadow.`,
    'Face a window or soft light. Avoid overhead or side light that casts shadows.',
    'Take off glasses and hats. Keep hair away from your eyes and face.',
    'Neutral expression, <b>mouth closed</b>, both eyes open, look straight into the lens.',
    'Have someone else hold the phone at your eye level (the back camera gives the best quality).',
    'Follow the <b>pulsing arrows</b> and the bubble under the frame. When it turns into a <b style="color:#2fbf71">green ✓</b> the photo is taken automatically.',
  ];
}

$('btn-rules').addEventListener('click', () => $('rules').showModal());

// ---------------------------------------------------------------- modes

function setMode(mode) {
  state.mode = mode;
  const live = mode === 'live';
  video.hidden = !live;
  photo.hidden = live;
  $('btn-retake').hidden = live;
  overlay.classList.toggle('mirror', live && state.mirrored);
  $('icon-capture').hidden = !live;
  $('icon-save').hidden = live;
  $('main-label').textContent = live ? 'Capture' : 'Save';
  for (const s of document.querySelectorAll('[data-mode]')) s.hidden = s.dataset.mode !== mode;
  state.guide = { g: null, checks: [] };
  state.lastProblem = '';
  if (live) startCamera();
  else stopCamera();
  if (!live) queueRender();
}

// ---------------------------------------------------------------- guidance

function photoHint(c) {
  switch (c.id) {
    case 'size': return c.cue === 'grow' ? 'Head too small – pinch out to zoom in' : 'Head too big – pinch in to zoom out';
    case 'frame': return 'Pinch in so the whole head fits';
    case 'center': return 'Drag the photo to center the face';
    case 'eyes': return c.cue === 'up' ? 'Drag the photo up' : 'Drag the photo down';
    case 'top': return 'Drag the photo down – more space above the head';
    case 'level': return 'Rotate with two fingers, or Auto-crop in Settings';
    case 'fill': return state.guide.checks.some((x) => x.id === 'size' && !x.ok)
      ? 'Zoom in – there are empty edges'
      : 'Taken too close – no room around the head. Retake from further back';
    case 'pitch': return 'Camera was below/above eye level – retake with the phone at eye level';
    case 'res': return 'Too far – not enough detail. Retake closer';
    case 'open':
    case 'facing':
    case 'single': return `Retake: ${c.hint}`;
    case 'dark':
    case 'bright': return 'Lighting is off – try ✨ Auto enhance in Settings, or retake';
    case 'bg-color':
    case 'bg-plain': return 'Background – replace it in Settings, or retake by a plain wall';
    case 'even': return 'Shadow on face – retake facing the light';
    default: return `Retake: ${c.hint}`;
  }
}

// Update the bubble, frame glow and main button from the current checks.
function guide(g, checks, ready) {
  state.guide = { g, checks };
  const bubble = $('bubble');
  const failed = checks.filter((c) => !c.ok);
  const top = PRIORITY.map((id) => failed.find((c) => c.id === id)).find(Boolean) ?? failed[0];
  const live = state.mode === 'live';
  let cls = '';
  let iconText = '…';
  let title;
  let sub = '';
  if (!ready) {
    title = live
      ? (state.detector === 'failed' ? 'Line up your head with the oval' : 'Loading face guide…')
      : 'Line up the head with the oval';
    sub = state.detector === 'failed' ? 'Automatic checks unavailable (offline?)' : '';
  } else if (top) {
    cls = WARN_IDS.has(top.id) ? 'warn' : 'bad';
    iconText = ICONS[top.id] ?? '!';
    title = live ? top.hint : photoHint(top);
    sub = failed.length > 1 ? `${failed.length - 1} more to fix · tap for details` : 'Almost there · tap for details';
  } else {
    cls = 'ok';
    iconText = '✓';
    title = `Meets ${state.country.flag} ${state.country.name} requirements`;
    sub = live ? ($('auto').checked ? 'Hold still – taking the photo…' : 'Tap Capture') : 'Tap Save to export';
  }
  bubble.className = `bubble ${cls}`;
  $('bubble-icon').textContent = iconText;
  $('bubble-title').textContent = title;
  $('bubble-sub').textContent = sub;
  renderChecks($('checks'), checks);
  const allGood = ready && checks.length > 0 && !failed.length;
  stage.classList.toggle('ready', allGood);
  stage.classList.toggle('alerting', cls === 'bad');
  $('btn-main').classList.toggle('ready', allGood);
  const key = top?.id ?? (allGood ? 'ok' : '');
  if (key !== state.lastProblem) {
    if (key === 'ok') navigator.vibrate?.([30, 40, 30]);
    else if (key && cls === 'bad') navigator.vibrate?.(40);
    state.lastProblem = key;
  }
  return allGood;
}

$('bubble').addEventListener('click', () => { $('checks').hidden = !$('checks').hidden; });

// ---------------------------------------------------------------- camera

async function startCamera() {
  if (state.camActive) return;
  state.camActive = true;
  state.introShown = false;
  guide(null, [], false);
  $('bubble-title').textContent = 'Starting camera…';
  if (!navigator.mediaDevices?.getUserMedia) {
    state.camActive = false;
    showCameraError('Camera not available (needs HTTPS)');
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1920 } },
    });
  } catch (err) {
    state.camActive = false;
    showCameraError(`Camera unavailable (${err.name})`);
    return;
  }
  if (!state.camActive) { // left live mode while waiting for permission
    stopTracks();
    return;
  }
  const settings = state.stream.getVideoTracks()[0]?.getSettings?.() ?? {};
  state.mirrored = (settings.facingMode ?? state.facing) === 'user';
  video.classList.toggle('mirror', state.mirrored);
  overlay.classList.toggle('mirror', state.mirrored);
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  requestAnimationFrame(camLoop);
}

function showCameraError(msg) {
  $('bubble').className = 'bubble warn';
  $('bubble-icon').textContent = '📷';
  $('bubble-title').textContent = msg;
  $('bubble-sub').textContent = 'Use the Upload button to pick a photo instead';
}

// Camera just became active: show how-to instructions (once per activation).
video.addEventListener('playing', () => {
  if (state.introShown || prefs.get('hideIntro') === '1') return;
  state.introShown = true;
  $('intro').hidden = false;
});
$('intro-ok').addEventListener('click', () => {
  $('intro').hidden = true;
  if ($('intro-hide').checked) prefs.set('hideIntro', '1');
});
$('btn-help').addEventListener('click', () => {
  $('settings').close();
  $('intro-hide').checked = false;
  prefs.set('hideIntro', '0');
  $('intro').hidden = false;
});

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

// The part of the video frame that becomes the photo (centered, country aspect).
function videoRegion() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const A = state.L.aspect;
  const [rw, rh] = vw / vh > A ? [vh * A, vh] : [vw, vw / A];
  return { vw, vh, rw, rh, ox: (vw - rw) / 2, oy: (vh - rh) / 2 };
}

function camLoop(now) {
  if (!state.camActive) return;
  requestAnimationFrame(camLoop);
  if (now - state.lastDetect < 80 || video.readyState < 2 || !video.videoWidth) return;
  state.lastDetect = now;

  const { L, country } = state;
  const reg = videoRegion();
  const toUnit = (p) => ({ x: (p.x - reg.ox) / reg.rh, y: (p.y - reg.oy) / reg.rh });
  const checks = [];
  let faceU = null;
  let g = null;

  if (faceDetectorReady()) {
    const det = detectFace(video, reg.vw, reg.vh);
    if (!det.count) {
      checks.push(mkCheck('face', false, 'Face found', 'No face found – step into the frame or move closer', 'grow'));
    } else {
      checks.push(mkCheck('single', det.count === 1, 'Only one person', 'Only one person may be in the photo'));
      faceU = mapFace(det.face, toUnit);
      g = headGeometry(faceU);
      checks.push(...geometryChecks(g, L, { mirrored: state.mirrored }));
      checks.push(mkCheck('open', det.blink < MAX_EYE_BLINK, 'Eyes open', 'Keep both eyes open'));
    }
  }

  if (now - state.lastPixels > 400) {
    state.lastPixels = now;
    const h = ANALYSIS_H;
    const w = Math.round(h * L.aspect);
    work.width = w;
    work.height = h;
    workCtx.drawImage(video, reg.ox, reg.oy, reg.rw, reg.rh, 0, 0, w, h);
    state.pixelChecks = measurePixels(workCtx, w, h, faceU, g, country.background);
  }
  checks.push(...state.pixelChecks);

  if (state.counting) return;
  const allGood = guide(g, checks, faceDetectorReady());
  if ($('auto').checked && allGood && $('intro').hidden && !sheetOpen()) {
    state.goodSince ||= now;
    if (now - state.goodSince > AUTO_HOLD_MS) capture();
  } else {
    state.goodSince = 0;
  }
}

function startCountdownThen(fn) {
  const secs = TIMERS[state.timerIdx];
  if (!secs) { fn(); return; }
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
    if (state.camActive) fn();
  }, 1000);
}

$('btn-main').addEventListener('click', () => {
  if (state.mode === 'photo') { openSave(); return; }
  if (state.counting || !state.stream) return;
  $('intro').hidden = true;
  startCountdownThen(capture);
});

$('btn-timer').addEventListener('click', () => {
  state.timerIdx = (state.timerIdx + 1) % TIMERS.length;
  const s = TIMERS[state.timerIdx];
  $('timer-label').textContent = s ? `${s}s` : 'Off';
});
$('auto').checked = prefs.get('auto') !== '0';
$('auto').addEventListener('change', () => prefs.set('auto', $('auto').checked ? '1' : '0'));

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
  openPhoto(c);
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
  openPhoto(c);
});

// ---------------------------------------------------------------- analysis

// Face-half rectangles (output units) used for exposure / shadow checks.
function faceHalves(faceU, g) {
  if (!faceU || !g) return null;
  const x0 = Math.min(faceU.cheekA.x, faceU.cheekB.x);
  const x1 = Math.max(faceU.cheekA.x, faceU.cheekB.x);
  const y0 = g.eye.y + (g.chin.y - g.eye.y) * 0.15;
  const y1 = g.eye.y + (g.chin.y - g.eye.y) * 0.45;
  const ex = g.eye.x;
  const lw = (ex - x0) * 0.55;
  const rw = (x1 - ex) * 0.55;
  if (lw <= 0.005 || rw <= 0.005 || y1 <= y0) return null;
  return [
    { x: x0 + (ex - x0) * 0.25, y: y0, w: lw, h: y1 - y0 },
    { x: ex + (x1 - ex) * 0.2, y: y0, w: rw, h: y1 - y0 },
  ];
}

function measurePixels(ctx, w, h, faceU, g, background) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const A = w / h;
  const R = (r) => ({ x: r.x * h, y: r.y * h, w: r.w * h, h: r.h * h });
  const bg = mergeStats([
    regionStats(data, w, R({ x: 0.02 * A, y: 0.03, w: 0.14 * A, h: 0.25 })),
    regionStats(data, w, R({ x: 0.84 * A, y: 0.03, w: 0.14 * A, h: 0.25 })),
  ]);
  const scene = regionStats(data, w, { x: 0, y: 0, w, h });
  const halves = faceHalves(faceU, g);
  const faceLeft = halves && regionStats(data, w, R(halves[0]));
  const faceRight = halves && regionStats(data, w, R(halves[1]));
  return lightingChecks({ bg, faceLeft, faceRight, scene }, background);
}

// ---------------------------------------------------------------- drawing

function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { W: w, H: h };
}

function line(ctx, x0, y0, x1, y1) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function arrow(ctx, x0, y0, x1, y1, size) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  line(ctx, x0, y0, x1, y1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - size * Math.cos(a - 0.5), y1 - size * Math.sin(a - 0.5));
  ctx.lineTo(x1 - size * Math.cos(a + 0.5), y1 - size * Math.sin(a + 0.5));
  ctx.closePath();
  ctx.fill();
}

const GREEN = '#2fbf71';
const RED = '#ff5b4a';
const AMBER = '#ffb020';

// Guides (target oval, eye band, top margin) plus animated cues for the most
// important problem: pulsing arrows, pulsing oval, rotating arrow, etc.
function drawGuides(canvas, g, checks, now) {
  const { W, H } = fitCanvas(canvas);
  if (!W || !H) return;
  const ctx = canvas.getContext('2d');
  const { L } = state;
  const X = (u) => u * H;
  ctx.clearRect(0, 0, W, H);
  const pulse = 0.5 + 0.5 * Math.sin((now / 1000) * Math.PI * 2 * 1.3);
  const lw = Math.max(1.5, H / 300);
  const failed = checks.filter((c) => !c.ok);
  const cue = failed.find((c) => c.cue)?.cue ?? null;
  const allGood = checks.length > 0 && failed.length === 0 && g;
  const dash = [H / 60, H / 80];

  // Eye band (US) and minimum top margin.
  if (L.eyes) {
    const y0 = X(1 - L.eyes[1]);
    const y1 = X(1 - L.eyes[0]);
    const eyeBad = cue === 'up' || cue === 'down';
    ctx.fillStyle = eyeBad ? `rgba(255,91,74,${0.12 + 0.18 * pulse})` : 'rgba(47,191,113,0.16)';
    ctx.fillRect(0, y0, W, y1 - y0);
    ctx.strokeStyle = eyeBad ? RED : 'rgba(47,191,113,0.8)';
    ctx.lineWidth = lw;
    ctx.setLineDash(dash);
    line(ctx, 0, y0, W, y0);
    line(ctx, 0, y1, W, y1);
  }
  ctx.setLineDash(dash);
  if (L.topMin > 0) {
    const topBad = cue === 'down';
    ctx.strokeStyle = topBad ? RED : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = topBad ? lw * (1 + 2 * pulse) : lw;
    line(ctx, 0, X(L.topMin), W, X(L.topMin));
  }

  // Target head outline.
  const cx = X(L.aspect / 2);
  const headH = X(L.targetHead);
  const cy = X(L.targetTop) + headH / 2;
  const sizeCue = cue === 'grow' || cue === 'shrink';
  let breathe = 1;
  if (cue === 'grow') breathe = 1 + 0.06 * pulse;
  if (cue === 'shrink') breathe = 1 - 0.06 * pulse;
  ctx.lineWidth = allGood ? lw * 3 : sizeCue ? lw * (1.5 + 2 * pulse) : lw * 1.5;
  ctx.strokeStyle = allGood ? GREEN : sizeCue ? RED : 'rgba(255,255,255,0.9)';
  if (allGood) ctx.setLineDash([]);
  ctx.beginPath();
  ctx.ellipse(cx, cy, headH * 0.37 * breathe, (headH / 2) * breathe, 0, 0, Math.PI * 2);
  ctx.stroke();
  if (allGood) {
    ctx.fillStyle = `rgba(47,191,113,${0.08 + 0.08 * pulse})`;
    ctx.fill();
  }
  ctx.setLineDash(dash);
  ctx.strokeStyle = cue === 'left' || cue === 'right' ? RED : 'rgba(255,255,255,0.35)';
  ctx.lineWidth = lw;
  line(ctx, cx, 0, cx, H);
  ctx.setLineDash([]);

  // Size cue: four arrows pointing out (move closer) or in (move back).
  if (sizeCue) {
    const out = cue === 'grow';
    const d = H * (0.05 + 0.03 * pulse);
    const s = H * 0.035;
    ctx.strokeStyle = ctx.fillStyle = RED;
    ctx.lineWidth = lw * 2;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ex = cx + dx * (headH * 0.37 + H * 0.02);
      const ey = cy + dy * (headH / 2 + H * 0.02);
      if (out) arrow(ctx, ex, ey, ex + dx * d, ey + dy * d, s);
      else arrow(ctx, ex + dx * d, ey + dy * d, ex, ey, s);
    }
  }

  // Background / light cues.
  if (cue === 'bg') {
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = lw * (1 + 2 * pulse);
    ctx.strokeRect(X(0.02 * L.aspect), X(0.03), X(0.14 * L.aspect), X(0.25));
    ctx.strokeRect(X(0.84 * L.aspect), X(0.03), X(0.14 * L.aspect), X(0.25));
  }
  if (cue === 'dark') {
    const grad = ctx.createRadialGradient(cx, cy, headH * 0.3, cx, cy, H);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(255,176,32,${0.15 + 0.25 * pulse})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  if (cue === 'raise' || cue === 'lower') {
    const dir = cue === 'raise' ? -1 : 1;
    const x = W - H * 0.07;
    const bobY = H * 0.04 * pulse * dir;
    ctx.strokeStyle = ctx.fillStyle = RED;
    ctx.lineWidth = lw * 3;
    arrow(ctx, x, H / 2 - dir * H * 0.1 + bobY, x, H / 2 + dir * H * 0.1 + bobY, H * 0.045);
    arrow(ctx, H * 0.07, H / 2 - dir * H * 0.1 + bobY, H * 0.07, H / 2 + dir * H * 0.1 + bobY, H * 0.045);
  }

  if (!g) return;
  const fx = X(g.eye.x);
  const w = H * 0.16;

  // Measured head: crown and chin markers + eye line.
  const ok = (id) => checks.find((c) => c.id === id)?.ok !== false;
  ctx.strokeStyle = ok('size') && ok('top') ? GREEN : RED;
  ctx.lineWidth = Math.max(3, H / 150);
  line(ctx, fx - w, X(g.top.y), fx + w, X(g.top.y));
  line(ctx, fx - w, X(g.chin.y), fx + w, X(g.chin.y));
  ctx.strokeStyle = ok('eyes') && ok('level') ? GREEN : RED;
  const ddx = Math.cos(g.roll) * w * 1.3;
  const ddy = Math.sin(g.roll) * w * 1.3;
  line(ctx, fx - ddx, X(g.eye.y) - ddy, fx + ddx, X(g.eye.y) + ddy);

  ctx.strokeStyle = ctx.fillStyle = RED;
  ctx.lineWidth = lw * 2.5;
  const s = H * 0.04;
  const bob = H * 0.025 * pulse;
  if (cue === 'left' || cue === 'right') {
    // Arrow from the face toward the centre line (drawn in camera space, so
    // it stays correct when the preview is mirrored).
    const dir = Math.sign(cx - fx) || 1;
    arrow(ctx, fx + dir * bob, X(g.eye.y), fx + dir * (H * 0.12 + bob), X(g.eye.y), s);
  }
  if (cue === 'up' || cue === 'down') {
    // Arrows show where the face must move in the frame.
    const dir = cue === 'up' ? -1 : 1;
    const y = X(g.eye.y);
    arrow(ctx, fx + w * 1.5, y + dir * bob, fx + w * 1.5, y + dir * (H * 0.1 + bob), s);
    arrow(ctx, fx - w * 1.5, y + dir * bob, fx - w * 1.5, y + dir * (H * 0.1 + bob), s);
  }
  if (cue === 'tilt') {
    // Curved arrow around the head, turning the way that levels the eyes.
    const r = X(g.headH) * 0.62;
    const dir = g.roll > 0 ? -1 : 1;
    const start = -Math.PI / 2 - dir * 0.5;
    const end = start + dir * (0.6 + 0.4 * pulse);
    const ccy = X((g.top.y + g.chin.y) / 2);
    ctx.beginPath();
    ctx.arc(fx, ccy, r, start, end, dir < 0);
    ctx.stroke();
    const ax = fx + r * Math.cos(end);
    const ay = ccy + r * Math.sin(end);
    const tang = end + (dir * Math.PI) / 2;
    arrow(ctx, ax - Math.cos(tang), ay - Math.sin(tang), ax, ay, s);
  }
  if (cue === 'facing') {
    ctx.lineWidth = lw * (1 + 2 * pulse);
    ctx.beginPath();
    ctx.arc(fx, X(g.eye.y), X(g.eyeDist) * 0.9, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Draw `img` (whose pixel space is iw × ih) through transform t into a W × H canvas.
function drawTransformed(ctx, W, H, img, t, { fill = '#fff', iw = img.width, ih = img.height } = {}) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.clearRect(0, 0, W, H);
  }
  ctx.translate((t.aspect / 2) * H, H / 2);
  ctx.rotate(t.rotation);
  ctx.scale(t.scale * H, t.scale * H);
  ctx.translate(-t.cx, -t.cy);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, iw, ih);
  ctx.restore();
}

// Full photo pipeline: crop → enhance → background replace/remove.
function compose(ctx, W, H, { fast = false, bg = state.bg, fill = '#fff' } = {}) {
  const { src, t, enh, mask } = state;
  drawTransformed(ctx, W, H, src, t, { fill });
  if (!isNeutral(enh)) {
    const img = ctx.getImageData(0, 0, W, H);
    applyEnhance(img.data, W, H, fast ? { ...enh, sharpen: 0 } : enh);
    ctx.putImageData(img, 0, 0);
  }
  if (bg !== 'original' && mask) {
    const m = document.createElement('canvas');
    m.width = W;
    m.height = H;
    drawTransformed(m.getContext('2d'), W, H, mask, t, { fill: null, iw: src.width, ih: src.height });
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(m, 0, 0);
    if (bg !== 'transparent') {
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }
}


function renderChecks(ul, checks) {
  const html = checks.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}">${c.label}</li>`).join('');
  if (ul.innerHTML !== html) ul.innerHTML = html;
}

// Animate the overlay cues (pulsing lines and arrows) in both modes.
function overlayLoop(now) {
  requestAnimationFrame(overlayLoop);
  drawGuides(overlay, state.guide.g, state.guide.checks, now);
}
requestAnimationFrame(overlayLoop);

// ---------------------------------------------------------------- photo mode

function openPhoto(src) {
  state.src = src;
  state.det = null;
  state.mask = null;
  state.enh = { ...NEUTRAL };
  state.autoEnhanced = false;
  $('bg-status').textContent = '';
  setMode('photo');
  if (faceDetectorReady()) {
    try { state.det = detectFace(src, src.width, src.height, { still: true }); } catch { state.det = null; }
  }
  autoFit();
  maybeAutoEnhance();
  if (state.bg !== 'original') ensureMask();
}

$('btn-retake').addEventListener('click', () => setMode('live'));

function autoFit() {
  const face = state.det?.face;
  const { L } = state;
  state.t = face ? autoTransform(face, L) : coverTransform(state.src.width, state.src.height, L.aspect);
  state.baseScale = state.t.scale;
  syncSliders();
  queueRender();
}

// Face in output units + its geometry for the current transform.
function faceInOutput() {
  if (!state.det?.face) return { faceU: null, g: null };
  const faceU = mapFace(state.det.face, (p) => mapPoint(state.t, p));
  return { faceU, g: headGeometry(faceU) };
}

function analysisCanvas(opts) {
  const h = ANALYSIS_H;
  const w = Math.round(h * state.L.aspect);
  work.width = w;
  work.height = h;
  compose(workCtx, w, h, opts);
  return { w, h };
}

// Built-in auto enhancement (light / contrast / sharpen).
function computeAutoEnhance() {
  const saved = state.enh;
  state.enh = { ...NEUTRAL };
  const { w, h } = analysisCanvas({ bg: 'original', fill: null });
  state.enh = saved;
  const { data } = workCtx.getImageData(0, 0, w, h);
  const { faceU, g } = faceInOutput();
  const halves = faceHalves(faceU, g);
  const faceMean = halves
    ? mergeStats(halves.map((r) => regionStats(data, w, { x: r.x * h, y: r.y * h, w: r.w * h, h: r.h * h }))).mean
    : null;
  return autoEnhance(data, faceMean);
}

// Applied automatically only when the photo is noticeably dark or flat.
function maybeAutoEnhance() {
  const e = computeAutoEnhance();
  if (e.brightness > 10 || e.contrast > 1.1) {
    state.enh = e;
    state.autoEnhanced = true;
  }
  syncEnhanceSliders();
  queueRender();
}

function syncSliders() {
  $('zoom').value = Math.log2(state.t.scale / state.baseScale).toFixed(3);
  $('rotate').value = ((state.t.rotation * 180) / Math.PI).toFixed(1);
}

function syncEnhanceSliders() {
  $('brightness').value = state.enh.brightness;
  $('contrast').value = state.enh.contrast;
  $('sharpen').value = state.enh.sharpen;
}

function queueRender() {
  if (state.renderQueued || !state.src) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    if (state.mode === 'photo') renderPhotoView();
  });
}

function renderPhotoView() {
  const { src, t, country, L } = state;
  const { W, H } = fitCanvas(photo);
  compose(photo.getContext('2d'), W, H, { fast: state.dragging });

  const checks = [];
  const { faceU, g } = faceInOutput();
  if (state.det?.face) {
    checks.push(mkCheck('single', state.det.count === 1, 'Only one person', 'Only one person may be in the photo'));
    checks.push(...geometryChecks(g, L));
    checks.push(mkCheck('open', state.det.blink < MAX_EYE_BLINK, 'Eyes open', 'Keep both eyes open'));
  } else if (faceDetectorReady()) {
    checks.push(mkCheck('face', false, 'Face found', 'No face found – line it up manually'));
  }
  const headOk = !checks.some((c) => c.id === 'size' && !c.ok);
  checks.push(mkCheck('fill', coversImage(t, src.width, src.height), 'Photo fills the frame',
    headOk ? 'Taken too close – retake from further back' : 'Zoom in – there are empty edges', headOk ? null : 'grow'));
  const srcPx = Math.round(1 / t.scale);
  checks.push(mkCheck('res', srcPx >= country.digital.minH, `Resolution ${srcPx} px`,
    'Too far – not enough detail. Retake closer', 'grow'));

  // Leave empty edges transparent so they don't count as background.
  const { w, h } = analysisCanvas({ fast: true, fill: null });
  checks.push(...measurePixels(workCtx, w, h, faceU, g, country.background));
  guide(g, checks, true);
  if (state.autoEnhanced && !checks.some((c) => !c.ok)) {
    $('bubble-sub').textContent = '✨ Auto-enhanced (light/contrast) · Tap Save to export';
  }

  const altered = !isNeutral(state.enh) || state.bg !== 'original';
  $('alter-note').hidden = !altered;
  $('alter-note').textContent = `⚠️ ${country.noAlteration} Enhancement and background changes may cause rejection – retaking with better light and a plain wall is safest.`;
}

// Gestures on the photo: one finger pans, two fingers pinch-zoom and rotate.
const pointers = new Map();

function gesture() {
  const pts = [...pointers.values()];
  const rect = stage.getBoundingClientRect();
  const toUnit = (p) => ({ x: (p.x - rect.left) / rect.height, y: (p.y - rect.top) / rect.height });
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
  if (state.mode !== 'photo' || e.target.closest('button')) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  state.dragging = true;
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
  if (!pointers.delete(e.pointerId)) return;
  lastGesture = pointers.size ? gesture() : null;
  if (!pointers.size) {
    state.dragging = false;
    queueRender();
  }
};
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('wheel', (e) => {
  if (state.mode !== 'photo') return;
  e.preventDefault();
  zoomAboutCenter(state.t.scale * Math.exp(-e.deltaY * 0.001), state.t.rotation);
}, { passive: false });

function zoomAboutCenter(scale, rotation) {
  const c = { x: state.L.aspect / 2, y: 0.5 };
  const p = unmapPoint(state.t, c);
  state.t = anchorTransform({ ...state.t, scale, rotation }, p, c);
  syncSliders();
  queueRender();
}

// ---------------------------------------------------------------- settings

$('btn-settings').addEventListener('click', () => $('settings').showModal());
for (const d of document.querySelectorAll('dialog')) {
  // Tap on the backdrop closes a sheet.
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
}

$('zoom').addEventListener('input', (e) => {
  zoomAboutCenter(state.baseScale * 2 ** Number(e.target.value), state.t.rotation);
});
$('rotate').addEventListener('input', (e) => {
  zoomAboutCenter(state.t.scale, (Number(e.target.value) * Math.PI) / 180);
});
$('btn-autofit').addEventListener('click', autoFit);
window.addEventListener('resize', () => queueRender());

for (const id of ['brightness', 'contrast', 'sharpen']) {
  $(id).addEventListener('input', (e) => {
    state.enh = { ...state.enh, [id]: Number(e.target.value) };
    state.autoEnhanced = false;
    queueRender();
  });
}
$('btn-enhance-auto').addEventListener('click', () => {
  state.enh = computeAutoEnhance();
  state.autoEnhanced = true;
  syncEnhanceSliders();
  queueRender();
});
$('btn-enhance-reset').addEventListener('click', () => {
  state.enh = { ...NEUTRAL };
  state.autoEnhanced = false;
  syncEnhanceSliders();
  queueRender();
});

for (const btn of document.querySelectorAll('#bg-options .swatch')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('#bg-options .swatch')) b.classList.toggle('active', b === btn);
    state.bg = btn.dataset.bg;
    if (state.bg !== 'original') ensureMask();
    queueRender();
  });
}

async function ensureMask() {
  if (state.mask || !state.src) return;
  const src = state.src;
  const status = $('bg-status');
  status.textContent = 'Finding you in the photo… (first time downloads a ~16 MB model)';
  try {
    const m = await segmentBackground(src);
    if (state.src !== src) return; // a new photo was taken meanwhile
    const c = document.createElement('canvas');
    c.width = m.width;
    c.height = m.height;
    const alpha = maskToAlpha(m.data);
    const img = new ImageData(m.width, m.height);
    for (let i = 0; i < alpha.length; i++) {
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = alpha[i];
    }
    c.getContext('2d').putImageData(img, 0, 0);
    state.mask = c;
    status.textContent = 'Background replaced. Check the edges around hair and shoulders.';
    queueRender();
  } catch (err) {
    console.warn('Segmentation failed:', err);
    status.textContent = 'Background removal is unavailable right now (needs an internet connection).';
  }
}

// ---------------------------------------------------------------- export

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function toJpeg(canvas, quality, dpi) {
  const blob = await canvasBlob(canvas, 'image/jpeg', quality);
  const bytes = setJpegDpi(new Uint8Array(await blob.arrayBuffer()), Math.round(dpi));
  return new Blob([bytes], { type: 'image/jpeg' });
}

// JPEG backgrounds can't be transparent: fall back to the country's colour.
const jpegBg = () => (state.bg === 'transparent' ? state.country.replaceColor : state.bg);

function renderPhoto(h, bg = jpegBg()) {
  const c = document.createElement('canvas');
  c.height = h;
  c.width = Math.round(h * state.L.aspect);
  compose(c.getContext('2d'), c.width, c.height, { bg });
  return c;
}

async function renderDigital() {
  const { digital, heightMm } = state.country;
  const maxBytes = Number($('max-kb').value) * 1024;
  let h = digital.h;
  for (;;) {
    const canvas = renderPhoto(h);
    const dpi = h / (heightMm / 25.4);
    let blob = await toJpeg(canvas, 0.92, dpi);
    if (!maxBytes) return blob;
    for (let q = 0.85; blob.size > maxBytes && q >= 0.35; q -= 0.1) blob = await toJpeg(canvas, q, dpi);
    if (blob.size <= maxBytes || h <= 300) return blob;
    h = Math.round(h * 0.8);
  }
}

function renderPrintSheet() {
  const { widthMm, heightMm } = state.country;
  const px = (mm) => Math.round((mm / 25.4) * PRINT_DPI);
  const sheet = sheetLayout(widthMm, heightMm);
  const one = renderPhoto(px(heightMm));
  const c = document.createElement('canvas');
  c.width = px(sheet.sw);
  c.height = px(sheet.sh);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const pw = one.width;
  const ph = one.height;
  const gap = px(3);
  const x0 = Math.round((c.width - sheet.cols * pw - (sheet.cols - 1) * gap) / 2);
  const y0 = Math.round((c.height - sheet.rows * ph - (sheet.rows - 1) * gap) / 2);
  ctx.strokeStyle = '#aaa';
  ctx.lineWidth = 2;
  for (let r = 0; r < sheet.rows; r++) {
    for (let col = 0; col < sheet.cols; col++) {
      const x = x0 + col * (pw + gap);
      const y = y0 + r * (ph + gap);
      ctx.drawImage(one, x, y);
      ctx.strokeRect(x - 1, y - 1, pw + 2, ph + 2);
    }
  }
  return c;
}

const digitalLabel = () =>
  `${state.country.digital.label} · ${Math.round(state.digitalBlob.size / 1024)} KB`;

async function openSave() {
  const btn = $('btn-main');
  btn.disabled = true;
  try {
    state.digitalBlob = await renderDigital();
    state.printBlob = await toJpeg(renderPrintSheet(), 0.95, PRINT_DPI);
    const img = $('result-img');
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(state.digitalBlob);
    $('btn-save-png').hidden = !(state.bg === 'transparent' && state.mask);
    $('digital-label').textContent = digitalLabel();
    const failed = state.guide.checks.filter((c) => !c.ok);
    $('save-warning').hidden = !failed.length;
    $('save-warning').textContent = `⚠️ Not all checks pass yet: ${failed.map((c) => c.label).join(', ')}.`;
    $('save').showModal();
  } finally {
    btn.disabled = false;
  }
}

$('max-kb').addEventListener('change', async () => {
  if (!state.src || !state.digitalBlob) return;
  state.digitalBlob = await renderDigital();
  $('digital-label').textContent = digitalLabel();
});

async function save(blob, name) {
  const file = new File([blob], name, { type: blob.type });
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

const fileBase = () => `${state.country.id}-photo-${state.country.widthMm.toFixed(0)}x${state.country.heightMm.toFixed(0)}mm`;
$('btn-save-digital').addEventListener('click', () => save(state.digitalBlob, `${fileBase()}.jpg`));
$('btn-save-print').addEventListener('click', () => save(state.printBlob, `${fileBase()}-4x6-sheet.jpg`));
$('btn-save-png').addEventListener('click', async () => {
  const c = renderPhoto(state.country.digital.h, 'transparent');
  save(await canvasBlob(c, 'image/png'), `${fileBase()}-cutout.png`);
});

// ---------------------------------------------------------------- boot

setCountry(prefs.get('country') ?? 'us');
setMode('live');
loadFaceDetector()
  .then(() => {
    state.detector = 'ready';
    // A photo may have been uploaded before the model finished loading.
    if (state.src && !state.det && state.mode === 'photo') {
      state.det = detectFace(state.src, state.src.width, state.src.height, { still: true });
      if (state.det?.face) autoFit();
    }
  })
  .catch((err) => {
    console.warn('Face detection unavailable:', err);
    state.detector = 'failed';
    if (state.mode === 'photo') queueRender();
  });
