// Builds www/ for the Android app: the web app plus the MediaPipe runtime and
// models served locally, so the app works offline and loads fast.
//   node scripts/build-web.mjs

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const cache = join(root, '.models');
const mp = join(root, 'node_modules/@mediapipe/tasks-vision');

// Models are pinned by SHA-256: a changed or tampered download fails the build.
const MODELS = {
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  // Multiclass model (16 MB): separates hair from background, so edges
  // around hair are much cleaner than with the 0.25 MB selfie model.
  'selfie_multiclass_256x256.tflite':
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};
const SHA256 = {
  'face_landmarker.task': '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  'selfie_multiclass_256x256.tflite': 'c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0',
};

// Asset locations the app reads (see js/face.js). Written to a file, not an
// inline script, so the Content Security Policy can forbid inline scripts.
const assetsJs = (sizes) => `window.PPH_ASSETS = {
  bundle: new URL('mediapipe/vision_bundle.mjs', document.baseURI).href,
  wasm: new URL('mediapipe/wasm', document.baseURI).href,
  faceModel: new URL('models/face_landmarker.task', document.baseURI).href,
  segModel: new URL('models/selfie_multiclass_256x256.tflite', document.baseURI).href,
  segModelSize: '16 MB',
  segMaskIndex: 0,          // class 0 = background
  segMaskIsBackground: true,
  // Download sizes, for the progress shown while the face guide loads.
  engineBytes: ${sizes.engine},
  faceModelBytes: ${sizes.face},
};
`;

// Only the app's own files: no inline or remote scripts, and no network
// connections except to the app itself – photos cannot be sent anywhere.
// 'wasm-unsafe-eval' lets the bundled MediaPipe WebAssembly compile.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const exists = (p) => stat(p).then(() => true, () => false);
const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

async function model(name) {
  const file = join(cache, name);
  if (!(await exists(file))) {
    console.log(`Downloading ${name}…`);
    const res = await fetch(MODELS[name]);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    await mkdir(cache, { recursive: true });
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  const got = await sha256(file);
  if (got !== SHA256[name]) {
    await rm(file, { force: true });
    throw new Error(`${name}: checksum mismatch (got ${got})`);
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
const head = '<meta charset="utf-8">';
if (!html.includes(head)) throw new Error('index.html: charset meta not found');
await writeFile(join(out, 'index.html'), html
  .replace(head, `${head}\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`)
  .replace(app, '<script src="js/assets-local.js"></script>\n  ' + app));

// Only the SIMD build: every current Android WebView supports WASM SIMD.
await cp(join(mp, 'vision_bundle.mjs'), join(out, 'mediapipe/vision_bundle.mjs'));
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  await cp(join(mp, 'wasm', f), join(out, 'mediapipe/wasm', f));
}
for (const name of Object.keys(MODELS)) {
  await cp(await model(name), join(out, 'models', name));
}

const size = async (f) => (await stat(join(out, f))).size;
await writeFile(join(out, 'js/assets-local.js'), assetsJs({
  engine: await size('mediapipe/wasm/vision_wasm_internal.wasm'),
  face: await size('models/face_landmarker.task'),
}));

console.log('Built www/');
