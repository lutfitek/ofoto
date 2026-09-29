// Thin wrapper around MediaPipe Face Landmarker (loaded lazily from a CDN).
// If loading fails the app keeps working with manual alignment only.

const VERSION = '0.10.14';
const BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/vision_bundle.mjs`;
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Landmark indices in the 478-point face mesh.
const IRIS_A = 468;
const IRIS_B = 473;
const CHIN = 152;
const NOSE_TIP = 1;
const CHEEK_A = 234;
const CHEEK_B = 454;

let landmarker = null;
let lastTs = 0;

export async function loadFaceDetector() {
  const { FaceLandmarker, FilesetResolver } = await import(BUNDLE);
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numFaces: 2,
    outputFaceBlendshapes: true,
  });
  try {
    landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

export const faceDetectorReady = () => landmarker !== null;

// Detect faces in a video, image or canvas. Points are returned in source
// pixels: { count, face: { eyeA, eyeB, chin, nose, cheekA, cheekB }, blink }.
export function detectFace(source, width, height) {
  if (!landmarker) return null;
  const ts = Math.max(performance.now(), lastTs + 1);
  lastTs = ts;
  const res = landmarker.detectForVideo(source, ts);
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
