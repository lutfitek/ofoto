// Thin wrapper around MediaPipe Tasks Vision (loaded lazily from a CDN):
// Face Landmarker for live guidance and auto-crop, Image Segmenter for
// background replacement. If loading fails the app keeps working manually.

const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODELS = 'https://storage.googleapis.com/mediapipe-models';

// Where the runtime and models load from. A host page can override any of
// these via `window.PPH_ASSETS` (e.g. to serve them next to the page).
const ASSETS = {
  bundle: `${CDN}/vision_bundle.mjs`,
  wasm: `${CDN}/wasm`,
  faceModel: `${MODELS}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
  segModel: `${MODELS}/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite`,
  segModelSize: '16 MB',
  // Confidence mask index and whether it holds background (true) or person (false).
  segMaskIndex: 0,
  segMaskIsBackground: true,
  ...(globalThis.PPH_ASSETS ?? {}),
};
export const segModelSize = ASSETS.segModelSize;

// Landmark indices in the 478-point face mesh.
const IRIS_A = 468;
const IRIS_B = 473;
const CHIN = 152;
const NOSE_TIP = 1;
const CHEEK_A = 234;
const CHEEK_B = 454;
// Mirror-image skin spots (image-left / image-right) used to check that the
// face is evenly lit. Kept near the middle of the face: spots near the edge
// darken with the face's curvature, and lower cheeks run into beards.
export const SKIN_PAIRS = {
  forehead: [108, 337],
  uppercheek: [101, 330],
  nose: [50, 280],
  cheek: [205, 425],
};
let vision = null;
let landmarker = null;      // VIDEO mode: tracks faces across camera frames
let imageLandmarker = null; // IMAGE mode: independent detection for still photos
let segmenter = null;
let segmenterLoading = null;
let lastTs = 0;

function loadVision() {
  vision ||= (async () => {
    const mod = await import(ASSETS.bundle);
    const fileset = await mod.FilesetResolver.forVisionTasks(ASSETS.wasm);
    return { mod, fileset };
  })();
  return vision;
}

// A model URL ending in `.b64.txt` holds the model base64-encoded (for hosts
// that only serve text); it is decoded and passed to MediaPipe as bytes.
async function modelSource(url) {
  if (!url.endsWith('.b64.txt')) return { modelAssetPath: url };
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed (${res.status})`);
  const bin = atob((await res.text()).trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { modelAssetBuffer: bytes };
}

let createLandmarker = null;
let videoDelegate = 'GPU';
let emptyStreak = 0;
let switchingToCpu = false;

export async function loadFaceDetector() {
  const { mod, fileset } = await loadVision();
  const model = await modelSource(ASSETS.faceModel);
  createLandmarker = (runningMode, delegate) => mod.FaceLandmarker.createFromOptions(fileset, {
    // Copy the bytes: each task keeps its own model buffer.
    baseOptions: { ...(model.modelAssetBuffer ? { modelAssetBuffer: model.modelAssetBuffer.slice() } : model), delegate },
    runningMode,
    numFaces: 2,
    outputFaceBlendshapes: true,
  });
  // Stills always run on the CPU: one frame is fast enough, and some Android
  // GPUs silently return no faces with the GPU delegate.
  imageLandmarker = await createLandmarker('IMAGE', 'CPU');
  try {
    landmarker = await createLandmarker('VIDEO', 'GPU');
  } catch {
    videoDelegate = 'CPU';
    landmarker = await createLandmarker('VIDEO', 'CPU');
  }
}

export const faceDetectorReady = () => landmarker !== null;

// If the GPU tracker keeps finding nothing (a known failure on some phones),
// swap in a CPU tracker once. Harmless when the frame really is empty.
function noteLiveResult(found) {
  emptyStreak = found ? 0 : emptyStreak + 1;
  if (emptyStreak < 30 || videoDelegate !== 'GPU' || switchingToCpu) return;
  switchingToCpu = true;
  createLandmarker('VIDEO', 'CPU')
    .then((cpu) => { landmarker = cpu; videoDelegate = 'CPU'; })
    .catch(() => {})
    .finally(() => { switchingToCpu = false; });
}

// Photos are detected on a copy no larger than this (faster, less memory).
const STILL_MAX = 1280;

function downscaled(source, width, height) {
  const k = Math.min(1, STILL_MAX / Math.max(width, height));
  if (k === 1) return source;
  const c = document.createElement('canvas');
  c.width = Math.round(width * k);
  c.height = Math.round(height * k);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c;
}

// Detect faces in a live video frame (tracked between calls) or, with
// `still`, in a single photo. Points are returned in source pixels:
// { count, face: { eyeA, eyeB, chin, nose, cheekA, cheekB }, blink }.
// Landmarks are normalised, so a downscaled copy maps straight back.
export function detectFace(source, width, height, { still = false } = {}) {
  if (!landmarker) return null;
  let res;
  if (still) {
    res = imageLandmarker.detect(downscaled(source, width, height));
  } else {
    const ts = Math.max(performance.now(), lastTs + 1);
    lastTs = ts;
    res = landmarker.detectForVideo(source, ts);
    noteLiveResult(res.faceLandmarks.length > 0);
  }
  const count = res.faceLandmarks.length;
  if (!count) return { count: 0, face: null, blink: 0 };
  const lm = res.faceLandmarks[0];
  const px = (i) => ({ x: lm[i].x * width, y: lm[i].y * height });
  let blink = 0;
  const shapes = res.faceBlendshapes?.[0]?.categories ?? [];
  for (const c of shapes) {
    if (c.categoryName === 'eyeBlinkLeft' || c.categoryName === 'eyeBlinkRight') {
      blink = Math.max(blink, c.score);
    }
  }
  return {
    count,
    blink,
    face: {
      eyeA: px(IRIS_A),
      eyeB: px(IRIS_B),
      chin: px(CHIN),
      nose: px(NOSE_TIP),
      cheekA: px(CHEEK_A),
      cheekB: px(CHEEK_B),
      ...Object.fromEntries(Object.entries(SKIN_PAIRS).flatMap(([name, [a, b]]) => [
        [`skin_${name}_a`, px(a)],
        [`skin_${name}_b`, px(b)],
      ])),
    },
  };
}

export function loadSegmenter() {
  segmenterLoading ||= (async () => {
    const { mod, fileset } = await loadVision();
    const model = await modelSource(ASSETS.segModel);
    // CPU for the same reason as face stills: reliable on every phone.
    segmenter = await mod.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { ...model, delegate: 'CPU' },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  })();
  segmenterLoading.catch(() => { segmenterLoading = null; });
  return segmenterLoading;
}

// Probability that each pixel is background: { width, height, data: Float32Array }.
export async function segmentBackground(source) {
  await loadSegmenter();
  const res = segmenter.segment(source);
  try {
    const mask = res.confidenceMasks[ASSETS.segMaskIndex];
    const data = mask.getAsFloat32Array().slice();
    if (!ASSETS.segMaskIsBackground) for (let i = 0; i < data.length; i++) data[i] = 1 - data[i];
    return { width: mask.width, height: mask.height, data };
  } finally {
    res.close();
  }
}
