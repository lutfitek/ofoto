import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEUTRAL, autoEnhance, applyEnhance, toneLut, maskToAlpha, isNeutral } from '../js/enhance.js';

function flat(w, h, v) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  return d;
}

test('autoEnhance brightens a dark photo', () => {
  const e = autoEnhance(flat(10, 10, 60));
  assert.ok(e.brightness > 30);
  assert.ok(e.contrast >= 1);
});

test('autoEnhance leaves a well-exposed face roughly alone', () => {
  const d = flat(10, 10, 0);
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = (i / 4) % 2 ? 30 : 230;
  const e = autoEnhance(d, 150);
  assert.ok(Math.abs(e.brightness) <= 5, `brightness ${e.brightness}`);
});

test('toneLut applies contrast around mid-grey then brightness', () => {
  const lut = toneLut({ brightness: 10, contrast: 2 });
  assert.equal(lut[128], 138);
  assert.equal(lut[138], 158);
  assert.equal(lut[0], 0);
});

test('applyEnhance sharpens edges and keeps alpha', () => {
  const w = 5, h = 3;
  const d = flat(w, h, 100);
  for (let y = 0; y < h; y++) for (let x = 3; x < w; x++) { const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = 200; }
  applyEnhance(d, w, h, { ...NEUTRAL, sharpen: 0.5 });
  const px = (x, y) => d[(y * w + x) * 4];
  assert.ok(px(2, 1) < 100, 'dark side of edge darker');
  assert.ok(px(3, 1) > 200, 'bright side of edge brighter');
  assert.equal(d[3], 255);
});

test('maskToAlpha is opaque on the person, clear on background', () => {
  const a = maskToAlpha(new Float32Array([0, 1, 0.5]));
  assert.equal(a[0], 255);
  assert.equal(a[1], 0);
  assert.equal(a[2], 128);
  assert.ok(isNeutral(NEUTRAL));
});
