import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTRIES, layout, headGeometry, autoTransform, mapPoint, unmapPoint, panTransform, coverTransform,
  coversImage, regionStats, anchorTransform, mergeStats, geometryChecks, lightingChecks, sheetLayout,
  setJpegDpi,
} from '../js/spec.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

function rotateAbout(p, c, ang) {
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

const upright = { eyeA: { x: 400, y: 500 }, eyeB: { x: 520, y: 500 }, chin: { x: 460, y: 640 }, nose: { x: 460, y: 570 } };

test('US layout matches the State Department template', () => {
  const L = layout(COUNTRIES.us);
  near(L.aspect, 1);
  near(L.headMin, 0.5);
  near(L.headMax, 0.6875);
  near(L.eyes[0], 0.5625);
  near(L.eyes[1], 0.6875);
});

for (const c of Object.values(COUNTRIES)) {
  test(`${c.id}: target placement is inside the rules`, () => {
    const L = layout(c);
    assert.ok(L.targetHead >= L.headMin && L.targetHead <= L.headMax);
    assert.ok(L.targetTop >= L.topMin);
    assert.ok(L.targetTop + L.targetHead < 1, 'chin inside the photo');
    if (L.eyes) {
      const eyes = 1 - L.targetEyeFromTop;
      assert.ok(eyes >= L.eyes[0] && eyes <= L.eyes[1]);
    }
  });

  test(`${c.id}: autoTransform levels, sizes and positions a tilted face`, () => {
    const L = layout(c);
    const center = { x: 460, y: 560 };
    const face = Object.fromEntries(Object.entries(upright).map(([k, p]) => [k, rotateAbout(p, center, 0.2)]));
    const t = autoTransform(face, L);
    const mapped = Object.fromEntries(Object.entries(face).map(([k, p]) => [k, mapPoint(t, p)]));
    const g = headGeometry(mapped);
    near(g.roll, 0);
    near(g.headH, L.targetHead);
    near(g.eye.x, L.aspect / 2);
    near(g.eye.y, L.targetEyeFromTop);
    near(g.top.y, L.targetTop);
    assert.deepEqual(geometryChecks(g, L).filter((x) => !x.ok), []);
  });
}

test('headGeometry on an upright face', () => {
  const g = headGeometry(upright);
  near(g.roll, 0);
  near(g.eyeChin, 140);
  near(g.eye.x, 460); near(g.eye.y, 500);
  assert.ok(g.top.y < g.eye.y);
  near(g.yaw, 0);
});

test('mapPoint/unmapPoint round-trip, pan and anchor with non-square aspect', () => {
  const t = { cx: 300, cy: 200, scale: 0.002, rotation: 0.3, aspect: 0.7 };
  const p = { x: 123, y: 456 };
  const q = unmapPoint(t, mapPoint(t, p));
  near(q.x, p.x); near(q.y, p.y);
  const a = mapPoint(t, p), b = mapPoint(panTransform(t, 0.1, -0.05), p);
  near(b.x - a.x, 0.1); near(b.y - a.y, -0.05);
  const anchor = { x: 0.3, y: 0.7 };
  const src = unmapPoint(t, anchor);
  const t2 = anchorTransform({ ...t, scale: 0.003, rotation: -0.2 }, src, anchor);
  const back = mapPoint(t2, src);
  near(back.x, anchor.x); near(back.y, anchor.y);
});

test('coverTransform fills the photo and coversImage detects gaps', () => {
  for (const A of [1, 35 / 45, 35 / 50]) {
    const t = coverTransform(1920, 1080, A);
    assert.ok(coversImage(t, 1920, 1080));
    assert.ok(!coversImage({ ...t, scale: t.scale / 2 }, 1920, 1080));
  }
});

test('geometryChecks hints and cues', () => {
  const L = layout(COUNTRIES.us);
  const base = { headH: 0.6, eye: { x: 0.5, y: 0.4 }, top: { y: 0.1 }, chin: { y: 0.7 }, roll: 0, yaw: 0 };
  const small = geometryChecks({ ...base, headH: 0.4 }, L).find((c) => c.id === 'size');
  assert.equal(small.hint, 'Too far – move closer');
  assert.equal(small.cue, 'grow');
  const off = geometryChecks({ ...base, eye: { x: 0.6, y: 0.4 } }, L).find((c) => c.id === 'center');
  assert.match(off.hint, /←/);
  const offMirror = geometryChecks({ ...base, eye: { x: 0.6, y: 0.4 } }, L, { mirrored: true }).find((c) => c.id === 'center');
  assert.match(offMirror.hint, /→/);
  const my = layout(COUNTRIES.my);
  const noRoom = geometryChecks({ ...base, eye: { x: my.aspect / 2, y: 0.4 }, top: { y: 0.05 } }, my).find((c) => c.id === 'top');
  assert.equal(noRoom.ok, false);
});

test('regionStats, mergeStats and lightingChecks', () => {
  const white = new Uint8ClampedArray(4 * 4 * 4).fill(240);
  const s = regionStats(white, 4, { x: 0, y: 0, w: 4, h: 4 });
  near(s.mean, 240, 1e-3); near(s.std, 0, 1e-3); near(s.sat, 0);
  const res = lightingChecks({ bg: s, faceLeft: { mean: 150 }, faceRight: { mean: 100 } });
  assert.ok(res.find((c) => c.id === 'bg-color').ok);
  assert.ok(!res.find((c) => c.id === 'even').ok);
  const dark = lightingChecks({ scene: { mean: 40 } });
  assert.equal(dark.find((c) => c.id === 'dark').hint, 'Too dark – turn on lights or face a window');
  const grey = { mean: 160, std: 5, sat: 10, n: 1 };
  assert.ok(!lightingChecks({ bg: grey }, 'white').find((c) => c.id === 'bg-color').ok);
  assert.ok(lightingChecks({ bg: grey }, 'light').find((c) => c.id === 'bg-color').ok);
  const m = mergeStats([{ mean: 100, std: 0, sat: 0, n: 10 }, { mean: 200, std: 0, sat: 10, n: 10 }]);
  near(m.mean, 150); near(m.std, 50); near(m.sat, 5);
});

test('sheetLayout fits photos on a 4x6 sheet', () => {
  const count = (c) => { const s = sheetLayout(c.widthMm, c.heightMm); return s.cols * s.rows; };
  assert.equal(count(COUNTRIES.us), 2);
  assert.equal(count(COUNTRIES.uk), 6);
  assert.equal(count(COUNTRIES.my), 4);
});

test('setJpegDpi rewrites JFIF density', () => {
  const hdr = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const out = setJpegDpi(new Uint8Array(hdr), 300);
  assert.equal(out[13], 1);
  assert.equal((out[14] << 8) | out[15], 300);
  assert.equal((out[16] << 8) | out[17], 300);
});

test('regionStats ignores transparent pixels', () => {
  const d = new Uint8ClampedArray([255, 255, 255, 0, 10, 10, 10, 255]);
  const s = regionStats(d, 2, { x: 0, y: 0, w: 2, h: 1 });
  assert.equal(s.n, 1);
  near(s.mean, 10, 1e-3);
  assert.equal(lightingChecks({ bg: regionStats(d, 2, { x: 0, y: 0, w: 1, h: 1 }) }).length, 0);
});
