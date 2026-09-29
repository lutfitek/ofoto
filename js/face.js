// Thin wrapper around MediaPipe Tasks Vision (loaded lazily from a CDN):
// Face Landmarker for live guidance and auto-crop, Image Segmenter for
// background replacement. If loading fails the app keeps working manually.

const VERSION = '0.10.14';
const BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/vision_bundle.mjs`;
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`;
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const SEG_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

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
    const mod = await import(BUNDLE);
    const fileset = await mod.FilesetResolver.forVisionTasks(WASM);
    return { mod, fileset };
  })();
  return vision;
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
  const create = (runningMode) => withDelegate((delegate) => mod.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: FACE_MODEL, delegate },
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
    segmenter = await withDelegate((delegate) => mod.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SEG_MODEL, delegate },
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
    const mask = res.confidenceMasks[0]; // class 0 = background
    return { width: mask.width, height: mask.height, data: mask.getAsFloat32Array().slice() };
  } finally {
    res.close();
  }
}
