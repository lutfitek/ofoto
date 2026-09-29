// Brightness / contrast / sharpen on RGBA pixel arrays. DOM-free.

export const NEUTRAL = { brightness: 0, contrast: 1, sharpen: 0 };

const TARGET_FACE_LUMA = 150;
const TARGET_SCENE_LUMA = 140;

export const isNeutral = (e) =>
  e.brightness === 0 && e.contrast === 1 && e.sharpen === 0;

const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

// Pick brightness/contrast from the luminance histogram: stretch the 2nd–98th
// percentile range (capped, so it never looks harsh), then lift the face
// (or the whole picture) toward a comfortable exposure.
export function autoEnhance(data, faceMean = null) {
  const hist = new Uint32Array(256);
  let n = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l = luma(data, i);
    hist[l | 0]++;
    sum += l;
    n++;
  }
  if (!n) return { ...NEUTRAL };
  const pct = (p) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= n * p) return v;
    }
    return 255;
  };
  const lo = pct(0.02);
  const hi = pct(0.98);
  const contrast = clamp(200 / Math.max(1, hi - lo), 1, 1.4);
  const mean = faceMean ?? sum / n;
  const target = faceMean == null ? TARGET_SCENE_LUMA : TARGET_FACE_LUMA;
  const brightness = clamp(target - ((mean - 128) * contrast + 128), -40, 60);
  return {
    brightness: Math.round(brightness),
    contrast: Math.round(contrast * 100) / 100,
    sharpen: 0.3,
  };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function toneLut({ brightness, contrast }) {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = (v - 128) * contrast + 128 + brightness;
  return lut;
}

// Apply tone curve then a 3×3 unsharp (Laplacian) sharpen, in place.
// Alpha is left untouched.
export function applyEnhance(data, width, height, e) {
  if (isNeutral(e)) return;
  const lut = toneLut(e);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
  const s = e.sharpen;
  if (s <= 0 || width < 3 || height < 3) return;
  const src = new Uint8ClampedArray(data);
  const row = width * 4;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * row + x * 4;
      for (let c = 0; c < 3; c++) {
        const v = src[i + c];
        const lap = 4 * v - src[i + c - 4] - src[i + c + 4] - src[i + c - row] - src[i + c + row];
        data[i + c] = v + s * lap;
      }
    }
  }
}

// Background-probability → alpha, with a soft edge so hair blends.
export function maskToAlpha(bgConfidence, lo = 0.25, hi = 0.75) {
  const out = new Uint8ClampedArray(bgConfidence.length);
  for (let i = 0; i < bgConfidence.length; i++) {
    const t = clamp((1 - bgConfidence[i] - lo) / (hi - lo), 0, 1);
    out[i] = 255 * t * t * (3 - 2 * t);
  }
  return out;
}
