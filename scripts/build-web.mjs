// Builds www/ for the Android app: the web app plus the MediaPipe runtime and
// models served locally, so the app works offline and loads fast.
//   node scripts/build-web.mjs

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const cache = join(root, '.models');
const mp = join(root, 'node_modules/@mediapipe/tasks-vision');

const MODELS = {
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  // Multiclass model (16 MB): separates hair from background, so edges
  // around hair are much cleaner than with the 0.25 MB selfie model.
  'selfie_multiclass_256x256.tflite':
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};

// Asset locations the app reads (see js/face.js).
const ASSETS = `<script>
  window.PPH_ASSETS = {
    bundle: new URL('mediapipe/vision_bundle.mjs', document.baseURI).href,
    wasm: new URL('mediapipe/wasm', document.baseURI).href,
    faceModel: new URL('models/face_landmarker.task', document.baseURI).href,
    segModel: new URL('models/selfie_multiclass_256x256.tflite', document.baseURI).href,
    segModelSize: '16 MB',
    segMaskIndex: 0,          // class 0 = background
    segMaskIsBackground: true,
  };
</script>
`;

const exists = (p) => stat(p).then(() => true, () => false);

async function model(name) {
  const file = join(cache, name);
  if (!(await exists(file))) {
    console.log(`Downloading ${name}…`);
    const res = await fetch(MODELS[name]);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    await mkdir(cache, { recursive: true });
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'mediapipe/wasm'), { recursive: true });
await mkdir(join(out, 'models'), { recursive: true });

for (const f of ['css', 'js', 'icons', 'icon.svg', 'manifest.webmanifest']) {
  await cp(join(root, f), join(out, f), { recursive: true });
}
const html = await readFile(join(root, 'index.html'), 'utf8');
const app = '<script type="module" src="js/app.js"></script>';
if (!html.includes(app)) throw new Error('index.html: app script tag not found');
await writeFile(join(out, 'index.html'), html.replace(app, ASSETS + app));

// Only the SIMD build: every current Android WebView supports WASM SIMD.
await cp(join(mp, 'vision_bundle.mjs'), join(out, 'mediapipe/vision_bundle.mjs'));
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  await cp(join(mp, 'wasm', f), join(out, 'mediapipe/wasm', f));
}
for (const name of Object.keys(MODELS)) {
  await cp(await model(name), join(out, 'models', name));
}

console.log('Built www/');
