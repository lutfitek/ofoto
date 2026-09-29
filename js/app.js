import {
  COUNTRIES, PRINT_DPI, MAX_EYE_BLINK, layout, headGeometry, geometryChecks, lightingChecks,
  regionStats, mergeStats, skinPatch, shadowScore, mapPoint, unmapPoint, panTransform, anchorTransform, autoTransform,
  coverTransform, coversImage, sheetLayout, setJpegDpi,
} from './spec.js';
import { NEUTRAL, isNeutral, autoEnhance, applyEnhance, maskToAlpha } from './enhance.js';
import { loadFaceDetector, faceDetectorReady, detectFace, segmentBackground, segModelSize, SKIN_PAIRS } from './face.js';
import { saveFile, isNative } from './platform.js';

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
const ANALYSIS_H = 320; // px; tall enough for the skin-spot shadow check

// Which problem the bubble talks about first.
const PRIORITY = ['face', 'single', 'dark', 'bright', 'size', 'frame', 'body', 'center', 'eyes', 'top',
  'level', 'facing', 'pitch', 'open', 'fill', 'res', 'bg-color', 'bg-plain', 'even'];

// Line icons (SVG renders the same on every phone, unlike emoji).
const GLYPHS = {
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4.5-6.5 8-6.5s7 2 8 6.5"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.8"/><path d="M2.5 20c.8-4 3.6-5.8 6.5-5.8s5.7 1.8 6.5 5.8M15.5 14.4c2.7-.3 5 1.3 6 5"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  horizontal: '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  vertical: '<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4.5h-4.5"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M12 15V7M9.5 9.5 12 7l2.5 2.5"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21M10.5 7.5v6M7.5 10.5h6"/>',
  wall: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 10h18M3 15h18M9 4v6M15 10v5M9 15v5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 6.5v7.5M12 17.5v.5"/>',
  camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  dots: '<circle class="fill" cx="6" cy="12" r="1.6"/><circle class="fill" cx="12" cy="12" r="1.6"/><circle class="fill" cx="18" cy="12" r="1.6"/>',
};
const ICONS = {
  face: 'person', single: 'people', dark: 'light', bright: 'light', even: 'light',
  size: 'expand', frame: 'expand', fill: 'expand', body: 'expand', center: 'horizontal',
  eyes: 'vertical', top: 'vertical', level: 'rotate', facing: 'eye', open: 'eye',
  pitch: 'phone', res: 'zoom', 'bg-color': 'wall', 'bg-plain': 'wall',
};
const setIcon = (name) => {
  $('bubble-icon').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS[name] ?? GLYPHS.alert}</svg>`;
};

// Sections of the details panel under the bubble.
const GROUPS = [
  ['Framing', ['face', 'single', 'size', 'frame', 'body', 'center', 'eyes', 'top', 'fill', 'res']],
  ['Pose', ['level', 'facing', 'pitch', 'open']],
  ['Light', ['dark', 'bright', 'even']],
  ['Background', ['bg-color', 'bg-plain']],
];
const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
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
  wakeLock: null,
  capturing: false,
  // Full-resolution stills via ImageCapture, when the phone supports them.
  still: { ic: null, size: '', failures: 0, note: 'Checking…' },
  detectEvery: 80, // ms between live detections; grows on slow phones
};

const mkCheck = (id, ok, label, hint, cue = null) => ({ id, ok, label, hint: ok ? '' : hint, cue: ok ? null : cue });
const mapFace = (face, fn) => Object.fromEntries(Object.entries(face).map(([k, p]) => [k, fn(p)]));
const prefs = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const sheetOpen = () => $('settings').open || $('save').open || $('rules').open;

// Back button / gesture: each sheet and the photo view is a history entry,
// so Android's back closes the top one instead of leaving the app.
const layers = [];
let ignorePops = 0;
function openLayer(name, close) {
  layers.push({ name, close });
  history.pushState({ layer: layers.length }, '');
}
function closeLayer(name) {
  const i = layers.map((l) => l.name).lastIndexOf(name);
  if (i < 0) return;
  layers.splice(i, 1);
  ignorePops++;
  history.back();
}
window.addEventListener('popstate', () => {
  if (ignorePops) { ignorePops--; return; }
  layers.pop()?.close();
});
function openSheet(d) {
  if (d.open) return;
  d.showModal();
  openLayer(d.id, () => d.close());
}
function closeSheet(d) {
  if (d.open) d.close();
}
for (const d of document.querySelectorAll('dialog')) {
  // Closed by its own button or the backdrop: drop its history entry.
  d.addEventListener('close', () => closeLayer(d.id));
}
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------- country

const countrySelect = $('country');
for (const c of Object.values(COUNTRIES)) countrySelect.add(new Option(`${c.flag} ${c.name} · ${c.sizeLabel}`, c.id));
countrySelect.addEventListener('change', () => setCountry(countrySelect.value));
const introCountry = $('intro-country');
for (const c of Object.values(COUNTRIES)) introCountry.add(new Option(`${c.flag} ${c.name} · ${c.sizeLabel}`, c.id));
introCountry.addEventListener('change', () => setCountry(introCountry.value));

function setCountry(id) {
  const c = COUNTRIES[id] ?? COUNTRIES.us;
  state.country = c;
  state.L = layout(c);
  countrySelect.value = c.id;
  $('intro-country').value = c.id;
  prefs.set('country', c.id);
  // Extra background colours only where the rules allow them (Malaysia: blue).
  for (const b of document.querySelectorAll('#bg-options .swatch[data-extra]')) {
    b.hidden = !(c.extraBackgrounds ?? []).includes(b.dataset.bg);
    if (b.hidden && state.bg === b.dataset.bg) selectBackground('original');
  }
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
    ...(c.digital.uncropped ? ['Keep your <b>head, shoulders and upper body</b> in the picture – the passport office crops the digital photo itself.'] : []),
    'Face a window or soft light. Avoid overhead or side light that casts shadows.',
    'Take off glasses and hats. Keep hair away from your eyes and face.',
    'Neutral expression, <b>mouth closed</b>, both eyes open, look straight into the lens.',
    'Have someone else hold the phone at your eye level (the back camera gives the best quality).',
    'Follow the <b>pulsing arrows</b> and the bubble under the frame. When it turns into a <b style="color:#2fbf71">green ✓</b> the photo is taken automatically.',
  ];
}

$('btn-rules').addEventListener('click', () => openSheet($('rules')));

// ---------------------------------------------------------------- modes

function setMode(mode) {
  if (mode === 'photo' && state.mode !== 'photo') openLayer('photo', () => setMode('live'));
  if (mode === 'live') closeLayer('photo');
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
    case 'face':
    case 'body': return c.hint;
    case 'open':
    case 'facing':
    case 'single': return `Retake: ${c.hint}`;
    case 'dark':
    case 'bright': return 'Lighting is off – try ✨ Auto enhance in Settings, or retake';
    case 'bg-color':
    case 'bg-plain': return state.country.id === 'us'
      ? 'Background – retake against a plain white wall (US rejects edited backgrounds)'
      : 'Background – replace it in Settings, or retake by a plain wall';
    case 'even': return `Retake: ${c.hint}`;
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
  let iconName = 'dots';
  let title;
  let sub = '';
  if (!ready) {
    title = live
      ? (state.detector === 'failed' ? 'Line up your head with the oval' : 'Loading face guide…')
      : 'Line up the head with the oval';
    sub = state.detector === 'failed' ? 'Automatic checks unavailable (offline?)' : '';
  } else if (top) {
    cls = WARN_IDS.has(top.id) ? 'warn' : 'bad';
    iconName = ICONS[top.id] ?? 'alert';
    title = live ? top.hint : photoHint(top);
    sub = failed.length > 1 ? `${failed.length - 1} more to fix · tap for details` : 'Almost there · tap for details';
  } else {
    cls = 'ok';
    iconName = 'check';
    title = `Meets ${state.country.flag} ${state.country.name} requirements`;
    sub = live ? ($('auto').checked ? 'Hold still – taking the photo…' : 'Tap Capture') : 'Tap Save to export';
  }
  bubble.className = `bubble ${cls}`;
  if ($('bubble-icon').dataset.name !== iconName) {
    setIcon(iconName);
    $('bubble-icon').dataset.name = iconName;
  }
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

$('bubble').addEventListener('click', () => {
  $('checks').hidden = !$('checks').hidden;
  $('bubble').setAttribute('aria-expanded', String(!$('checks').hidden));
});

// ---------------------------------------------------------------- camera

async function startCamera() {
  if (state.camActive) return;
  state.camActive = true;
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
  state.nativeCamera = false;
  state.mirrored = (settings.facingMode ?? state.facing) === 'user';
  video.classList.toggle('mirror', state.mirrored);
  overlay.classList.toggle('mirror', state.mirrored);
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  keepAwake(true);
  detectStillSupport(state.stream.getVideoTracks()[0]);
  requestAnimationFrame(camLoop);
}

// Keep the screen on while framing the shot (released when the camera stops).
async function keepAwake(on) {
  try {
    if (on && !state.wakeLock && navigator.wakeLock) state.wakeLock = await navigator.wakeLock.request('screen');
    if (!on && state.wakeLock) { await state.wakeLock.release(); state.wakeLock = null; }
  } catch { state.wakeLock = null; }
}

// Pause the camera in the background (saves battery), resume when back.
document.addEventListener('visibilitychange', () => {
  if (state.mode !== 'live') return;
  if (document.hidden) stopCamera();
  else startCamera();
});

// No live camera (blocked, no HTTPS, or permission denied): Capture opens
// the phone's own camera app instead, and the photo is checked afterwards.
function showCameraError(msg) {
  state.nativeCamera = true;
  $('bubble').className = 'bubble warn';
  setIcon('camera');
  $('bubble-icon').dataset.name = 'camera';
  $('bubble-title').textContent = 'Tap Capture to take the photo with your camera app';
  $('bubble-sub').textContent = `${msg} – the photo is checked after you take it`;
}

function showError(title, sub = '') {
  $('bubble').className = 'bubble bad';
  setIcon('alert');
  $('bubble-icon').dataset.name = 'alert';
  $('bubble-title').textContent = title;
  $('bubble-sub').textContent = sub;
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
  closeSheet($('settings'));
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
  keepAwake(false);
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
  if (now - state.lastDetect < state.detectEvery || video.readyState < 2 || !video.videoWidth) return;
  state.lastDetect = now;

  const { L, country } = state;
  const reg = videoRegion();
  const toUnit = (p) => ({ x: (p.x - reg.ox) / reg.rh, y: (p.y - reg.oy) / reg.rh });
  const checks = [];
  let faceU = null;
  let g = null;

  if (faceDetectorReady()) {
    const t0 = performance.now();
    const det = detectFace(video, reg.vw, reg.vh);
    // Leave the phone at least as much idle time as detection takes.
    state.detectEvery = Math.min(250, Math.max(80, state.detectEvery * 0.8 + (performance.now() - t0) * 2 * 0.2));
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

  if (state.counting || state.capturing) return;
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
  if (state.nativeCamera) { $('snap').click(); return; }
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
$('hires').checked = prefs.get('hires') !== '0';
$('hires').addEventListener('change', () => prefs.set('hires', $('hires').checked ? '1' : '0'));
$('auto').addEventListener('change', () => prefs.set('auto', $('auto').checked ? '1' : '0'));

$('btn-flip').addEventListener('click', () => {
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  stopCamera();
  startCamera();
});

function grabFrame() {
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0); // stored un-mirrored, as others see you
  return c;
}

// Check whether this camera can take stills sharper than the preview.
async function detectStillSupport(track) {
  const st = state.still;
  st.ic = null;
  st.size = '';
  if (st.failures >= 2) st.note = 'Turned off after failed attempts on this phone';
  else if (!('ImageCapture' in window)) st.note = 'Not supported on this phone – using the preview frame';
  else {
    try {
      const ic = new ImageCapture(track);
      const caps = await ic.getPhotoCapabilities();
      const w = caps.imageWidth?.max ?? 0;
      const h = caps.imageHeight?.max ?? 0;
      const preview = Math.max(video.videoWidth, video.videoHeight);
      if (Math.max(w, h) > preview * 1.2) {
        st.ic = ic;
        st.size = `${w} × ${h}`;
        st.note = `Supported – ${st.size} instead of ${video.videoWidth} × ${video.videoHeight}`;
      } else {
        st.note = 'Stills are no sharper than the preview on this phone';
      }
    } catch {
      st.note = 'Not supported on this camera – using the preview frame';
    }
  }
  $('hires-status').textContent = st.note;
}

const useStill = () => state.still.ic && $('hires').checked && state.still.failures < 2;

// Take a full-resolution still; resolves to a canvas (≤ 3000 px) or null.
async function takeStill() {
  const blob = await Promise.race([
    state.still.ic.takePhoto(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
  ]);
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const k = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

// Capture: grab the preview frame at once (never lost), then try a sharper
// still and keep it only if it matches the frame's orientation and a face is
// found in it. Any failure falls back to the frame.
async function capture() {
  if (!video.videoWidth || state.capturing) return;
  state.capturing = true;
  const frame = grabFrame();
  let src = frame;
  let det = null;
  if (useStill()) {
    $('bubble-title').textContent = 'Taking a full-resolution photo – hold still…';
    try {
      const still = await takeStill();
      const sameShape = (still.width > still.height) === (frame.width > frame.height);
      det = sameShape && faceDetectorReady() ? detectFace(still, still.width, still.height, { still: true }) : null;
      if (sameShape && (!faceDetectorReady() || det?.face)) {
        src = still;
        state.still.failures = 0;
      } else {
        det = null;
        state.still.failures++;
      }
    } catch {
      state.still.failures++;
    }
    if (state.still.failures >= 2) {
      state.still.note = 'Turned off after failed attempts on this phone';
      $('hires-status').textContent = state.still.note;
    }
  }
  state.capturing = false;
  if (state.mode === 'live') openPhoto(src, det);
}

async function loadFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    img.src = url;
    await img.decode();
  } catch {
    showError('Could not open that image', 'Try a JPEG or PNG photo');
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
}
$('file').addEventListener('change', loadFile);
$('snap').addEventListener('change', loadFile);

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

  // Shadow check: compare mirror-image skin spots across the face.
  let shadow = null;
  const spotR = g ? g.eyeDist * 0.11 : 0;
  if (faceU?.skin_nose_a && spotR * h >= 3) {
    const pairs = Object.keys(SKIN_PAIRS).map((name) => {
      const pa = faceU[`skin_${name}_a`];
      const pb = faceU[`skin_${name}_b`];
      return {
        name,
        a: skinPatch(data, w, pa.x * h, pa.y * h, spotR * h),
        b: skinPatch(data, w, pb.x * h, pb.y * h, spotR * h),
      };
    });
    shadow = shadowScore(pairs);
    if (shadow) {
      shadow.spot = faceU[`skin_${shadow.name}_${shadow.darker}`];
      shadow.r = spotR;
    }
  }
  return lightingChecks({ bg, faceLeft, faceRight, scene, shadow }, background);
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
  const pulse = reducedMotion.matches ? 0.6 : 0.5 + 0.5 * Math.sin((now / 1000) * Math.PI * 2 * 1.3);
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

  if (cue === 'shadow') {
    const sh = checks.find((c) => c.shadow && !c.ok)?.shadow;
    if (sh?.spot) {
      ctx.strokeStyle = AMBER;
      ctx.lineWidth = lw * (1.5 + 2 * pulse);
      ctx.beginPath();
      ctx.arc(X(sh.spot.x), X(sh.spot.y), X(sh.r) * (1.6 + 0.4 * pulse), 0, Math.PI * 2);
      ctx.stroke();
    }
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
function compose(ctx, W, H, { fast = false, bg = state.bg, fill = '#fff', t = state.t } = {}) {
  const { src, enh, mask } = state;
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


// Details panel: checks grouped by topic, with the fix for each failing one.
function renderChecks(el, checks) {
  const hint = (c) => (state.mode === 'live' ? c.hint : photoHint(c));
  const html = GROUPS.map(([name, ids]) => {
    const items = checks.filter((c) => ids.includes(c.id));
    if (!items.length) return '';
    const rows = items.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}"><span>${esc(c.label)}</span>${
      c.ok ? '' : `<small>${esc(hint(c))}</small>`}</li>`).join('');
    return `<section><h4>${name}</h4><ul>${rows}</ul></section>`;
  }).join('');
  if (el.innerHTML !== html) el.innerHTML = html;
}

// Animate the overlay cues (pulsing lines and arrows) in both modes.
function overlayLoop(now) {
  requestAnimationFrame(overlayLoop);
  drawGuides(overlay, state.guide.g, state.guide.checks, now);
}
requestAnimationFrame(overlayLoop);

// ---------------------------------------------------------------- photo mode

function openPhoto(src, knownDet = null) {
  state.src = src;
  state.det = null;
  state.mask = null;
  state.enh = { ...NEUTRAL };
  state.autoEnhanced = false;
  $('bg-status').textContent = '';
  setMode('photo');
  if (knownDet) {
    state.det = knownDet;
    state.detError = '';
  } else if (faceDetectorReady()) {
    try {
      state.det = detectFace(src, src.width, src.height, { still: true });
      state.detError = '';
    } catch (err) {
      state.det = null;
      state.detError = err?.message || String(err);
      console.warn('Face detection failed:', err);
    }
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
    checks.push(mkCheck('face', false, 'Face found', state.detError
      ? `Face detector error: ${state.detError}`
      : 'No face found – use a clear, front-facing photo'));
  }
  const headOk = !checks.some((c) => c.id === 'size' && !c.ok);
  checks.push(mkCheck('fill', coversImage(t, src.width, src.height), 'Photo fills the frame',
    headOk ? 'Taken too close – retake from further back' : 'Zoom in – there are empty edges', headOk ? null : 'grow'));
  if (country.digital.uncropped && state.det?.face) {
    // The digital photo is sent uncropped, so it must show the upper body.
    const gs = headGeometry(state.det.face);
    checks.push(mkCheck('body', src.height - gs.chin.y >= gs.headH * 0.6, 'Shoulders and upper body visible',
      'Include your shoulders and upper body – step back or hold the phone further away', 'shrink'));
  }
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

$('btn-settings').addEventListener('click', () => openSheet($('settings')));
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

function selectBackground(bg) {
  for (const b of document.querySelectorAll('#bg-options .swatch')) b.classList.toggle('active', b.dataset.bg === bg);
  state.bg = bg;
  if (bg !== 'original') ensureMask();
  queueRender();
}
for (const btn of document.querySelectorAll('#bg-options .swatch')) {
  btn.addEventListener('click', () => selectBackground(btn.dataset.bg));
}

async function ensureMask() {
  if (state.mask || !state.src) return;
  const src = state.src;
  const status = $('bg-status');
  status.textContent = `Finding you in the photo… (first time loads a ${segModelSize} model)`;
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
    // Downsample so the smooth upscale when compositing feathers the edge
    // (masks come back at full photo size with stair-stepped borders).
    const k = Math.min(1, 384 / Math.max(c.width, c.height));
    const soft = document.createElement('canvas');
    soft.width = Math.max(1, Math.round(c.width * k));
    soft.height = Math.max(1, Math.round(c.height * k));
    const sctx = soft.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(c, 0, 0, soft.width, soft.height);
    state.mask = soft;
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

// The whole photo (levelled, enhanced/background only if chosen), for
// services that crop it themselves.
async function renderUncropped() {
  const { digital } = state.country;
  const { width: w, height: h } = state.src;
  const k = Math.min(1, digital.maxLong / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const whole = { cx: w / 2, cy: h / 2, scale: 1 / h, rotation: 0, aspect: w / h };
  compose(c.getContext('2d'), c.width, c.height, { bg: jpegBg(), t: whole });
  let blob = await toJpeg(c, 0.92, PRINT_DPI);
  if (blob.size < digital.minBytes) blob = await toJpeg(c, 0.98, PRINT_DPI);
  return blob;
}

async function renderDigital() {
  const { digital, heightMm } = state.country;
  if (digital.uncropped) return renderUncropped();
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
    $('save-hint').hidden = false;
    $('save-hint').textContent = 'Press and hold the photo to save it to your phone, or use the buttons below.';
    openSheet($('save'));
  } finally {
    btn.disabled = false;
  }
}

$('max-kb').addEventListener('change', async () => {
  if (!state.src || !state.digitalBlob) return;
  state.digitalBlob = await renderDigital();
  $('digital-label').textContent = digitalLabel();
});

// Show the file in the save sheet (long-press → Save image works everywhere,
// even where downloads and the share sheet are blocked), then try to share
// or download it directly.
// Show the file in the save sheet (long-press → Save image works in any
// browser), then hand it to the platform: native save + share sheet in the
// Android app, share sheet or download on the web.
async function save(blob, name) {
  const img = $('result-img');
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
  const hint = $('save-hint');
  hint.hidden = false;
  hint.textContent = `Saving ${name}…`;
  try {
    const where = await saveFile(blob, name);
    hint.textContent = where
      ? `Saved to ${where}.`
      : `Showing ${name}. If it didn’t download, press and hold the image and choose Save image.`;
  } catch (err) {
    hint.textContent = `Couldn’t save (${err?.message || err}). Press and hold the image and choose Save image.`;
  }
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
