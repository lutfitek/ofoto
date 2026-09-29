import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  headGeometry, autoTransform, mapPoint, unmapPoint, panTransform, coverTransform,
  coversImage, regionStats, anchorTransform, mergeStats, geometryChecks, lightingChecks, setJpegDpi,
  TARGET_HEAD, TARGET_EYE_FROM_TOP, HEAD_MIN, HEAD_MAX, EYES_MIN, EYES_MAX,
} from '../js/spec.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

function rotateAbout(p, c, ang) {
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

const upright = { eyeA: { x: 400, y: 500 }, eyeB: { x: 520, y: 500 }, chin: { x: 460, y: 640 }, nose: { x: 460, y: 570 } };

test('target placement is inside the official ranges', () => {
  assert.ok(TARGET_HEAD >= HEAD_MIN && TARGET_HEAD <= HEAD_MAX);
  const eyes = 1 - TARGET_EYE_FROM_TOP;
  assert.ok(eyes >= EYES_MIN && eyes <= EYES_MAX);
  near(HEAD_MIN, 0.5); near(HEAD_MAX, 0.6875);
});

test('headGeometry on an upright face', () => {
  const g = headGeometry(upright);
  near(g.roll, 0);
  near(g.eyeChin, 140);
  near(g.eye.x, 460); near(g.eye.y, 500);
  assert.ok(g.top.y < g.eye.y);
  near(g.yaw, 0);
});

test('autoTransform levels, sizes and positions a tilted face', () => {
  const c = { x: 460, y: 560 };
  const ang = 0.2;
  const face = Object.fromEntries(Object.entries(upright).map(([k, p]) => [k, rotateAbout(p, c, ang)]));
  const t = autoTransform(face);
  const mapped = Object.fromEntries(Object.entries(face).map(([k, p]) => [k, mapPoint(t, p)]));
  const g = headGeometry(mapped);
  near(g.roll, 0);
  near(g.headH, TARGET_HEAD);
  near(g.eye.x, 0.5);
  near(g.eye.y, TARGET_EYE_FROM_TOP);
  assert.ok(geometryChecks(g).every((c) => c.ok));
});

test('mapPoint/unmapPoint round-trip and pan', () => {
  const t = { cx: 300, cy: 200, scale: 0.002, rotation: 0.3 };
  const p = { x: 123, y: 456 };
  const q = unmapPoint(t, mapPoint(t, p));
  near(q.x, p.x); near(q.y, p.y);
  const moved = panTransform(t, 0.1, -0.05);
  const a = mapPoint(t, p), b = mapPoint(moved, p);
  near(b.x - a.x, 0.1); near(b.y - a.y, -0.05);
});

test('coverTransform fills the square and coversImage detects gaps', () => {
  const t = coverTransform(1920, 1080);
  assert.ok(coversImage(t, 1920, 1080));
  assert.ok(!coversImage({ ...t, scale: t.scale / 2 }, 1920, 1080));
});

test('geometryChecks hints', () => {
  const small = geometryChecks({ headH: 0.4, eye: { x: 0.5, y: 0.4 }, top: { y: 0.2 }, chin: { y: 0.6 }, roll: 0, yaw: 0 });
  assert.equal(small.find((c) => c.id === 'size').hint, 'Move closer (head too small)');
  const off = geometryChecks({ headH: 0.6, eye: { x: 0.6, y: 0.4 }, top: { y: 0.1 }, chin: { y: 0.7 }, roll: 0, yaw: 0 });
  assert.match(off.find((c) => c.id === 'center').hint, /←/);
  const offMirror = geometryChecks({ headH: 0.6, eye: { x: 0.6, y: 0.4 }, top: { y: 0.1 }, chin: { y: 0.7 }, roll: 0, yaw: 0 }, { mirrored: true });
  assert.match(offMirror.find((c) => c.id === 'center').hint, /→/);
});

test('regionStats and lightingChecks', () => {
  const w = 4, h = 4;
  const white = new Uint8ClampedArray(w * h * 4).fill(240);
  const s = regionStats(white, w, { x: 0, y: 0, w: 4, h: 4 });
  near(s.mean, 240, 1e-3); near(s.std, 0, 1e-3); near(s.sat, 0);
  const res = lightingChecks({ bg: s, faceLeft: { mean: 150 }, faceRight: { mean: 100 } });
  assert.ok(res.find((c) => c.id === 'bg-white').ok);
  assert.ok(!res.find((c) => c.id === 'even').ok);
});

test('setJpegDpi rewrites JFIF density', () => {
  const hdr = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const out = setJpegDpi(new Uint8Array(hdr), 300);
  assert.equal(out[13], 1);
  assert.equal((out[14] << 8) | out[15], 300);
  assert.equal((out[16] << 8) | out[17], 300);
});

test('anchorTransform keeps the anchor fixed after zoom/rotate', () => {
  const t = { cx: 300, cy: 200, scale: 0.002, rotation: 0.1 };
  const q = { x: 0.3, y: 0.7 };
  const p = unmapPoint(t, q);
  const t2 = anchorTransform({ ...t, scale: 0.003, rotation: -0.2 }, p, q);
  const back = mapPoint(t2, p);
  near(back.x, q.x); near(back.y, q.y);
});

test('mergeStats pools patches with different brightness', () => {
  const a = { mean: 100, std: 0, sat: 0, n: 10 };
  const b = { mean: 200, std: 0, sat: 10, n: 10 };
  const m = mergeStats([a, b]);
  near(m.mean, 150); near(m.std, 50); near(m.sat, 5);
});
