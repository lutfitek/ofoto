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

async function withDelegate(create) {
  try {
    return await create('GPU');
  } catch {
    return create('CPU');
  }
}

export async function loadFaceDetector() {
  const { mod, fileset } = await loadVision();
  const model = await modelSource(ASSETS.faceModel);
  const create = (runningMode) => withDelegate((delegate) => mod.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { ...model, delegate },
    runningMode,
    numFaces: 2,
    outputFaceBlendshapes: true,
  }));
  imageLandmarker = await create('IMAGE');
  landmarker = await create('VIDEO');
}

export const faceDetectorReady = () => landmarker !== null;

// Detect faces in a live video frame (tracked between calls) or, with
// `still`, in a single photo. Points are returned in source pixels:
// { count, face: { eyeA, eyeB, chin, nose, cheekA, cheekB }, blink }.
export function detectFace(source, width, height, { still = false } = {}) {
  if (!landmarker) return null;
  let res;
  if (still) {
    res = imageLandmarker.detect(source);
  } else {
    const ts = Math.max(performance.now(), lastTs + 1);
    lastTs = ts;
    res = landmarker.detectForVideo(source, ts);
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
    },
  };
}

export function loadSegmenter() {
  segmenterLoading ||= (async () => {
    const { mod, fileset } = await loadVision();
    const model = await modelSource(ASSETS.segModel);
    segmenter = await withDelegate((delegate) => mod.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { ...model, delegate },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    }));
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
