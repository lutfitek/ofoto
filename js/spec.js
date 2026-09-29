// US passport photo rules and the pure geometry/pixel math used by the app.
// Everything here is DOM-free so it can be unit tested with `node --test`.
//
// Source: travel.state.gov/en/passports/apply/help/photos.html
//   - 2 x 2 in (51 x 51 mm), color
//   - head 1 – 1 3/8 in (25 – 35 mm) from bottom of chin to top of head (incl. hair)
//     = 50% – 69% of the image height
//   - eyes 1 1/8 – 1 3/8 in (28 – 35 mm) from the bottom of the photo
//   - plain white or off-white background, no shadows
//   - face the camera directly, neutral expression, both eyes open, mouth closed

export const PHOTO_IN = 2;

// Ratios of the photo height.
export const HEAD_MIN = 1 / PHOTO_IN;            // 0.50
export const HEAD_MAX = 1.375 / PHOTO_IN;        // 0.6875
export const EYES_MIN = 1.125 / PHOTO_IN;        // 0.5625 from bottom
export const EYES_MAX = 1.375 / PHOTO_IN;        // 0.6875 from bottom

// Where auto-crop places the face (comfortably inside both ranges).
export const TARGET_HEAD = 0.6;                  // 1.2 in
export const TARGET_EYE_FROM_TOP = 0.4;          // eyes 1.2 in from bottom

// Landmarks only reach the hairline, so the crown is estimated from the
// eye-to-chin distance: full head height (with hair) ≈ K × eye-to-chin.
export const HEAD_PER_EYE_CHIN = 2.1;

export const DIGITAL_PX = 1200;                  // digital upload: 600–1200 px square
export const PRINT_DPI = 300;

// Pixel-analysis thresholds (0–255 luminance).
export const BG_MIN_LUMA = 170;
export const BG_MAX_SAT = 35;
export const BG_MAX_STD = 24;
export const FACE_MIN_LUMA = 80;
export const FACE_MAX_LUMA = 220;
export const FACE_MAX_SIDE_DIFF = 30;

export const MAX_ROLL_DEG = 3;
export const MAX_YAW = 0.12;
export const MAX_CENTER_OFFSET = 0.05;
export const MAX_EYE_BLINK = 0.5;

const deg = (rad) => (rad * 180) / Math.PI;

// face: { eyeA, eyeB, chin, nose? } in pixel coordinates of any frame
// (x and y must share a scale). Returns head geometry in the same frame.
export function headGeometry(face) {
  const [l, r] = face.eyeA.x <= face.eyeB.x ? [face.eyeA, face.eyeB] : [face.eyeB, face.eyeA];
  const roll = Math.atan2(r.y - l.y, r.x - l.x);
  const eye = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  // Unit vector pointing "down the face" (perpendicular to the eye line).
  const n = { x: -Math.sin(roll), y: Math.cos(roll) };
  const eyeChin = (face.chin.x - eye.x) * n.x + (face.chin.y - eye.y) * n.y;
  const headH = HEAD_PER_EYE_CHIN * eyeChin;
  const up = (HEAD_PER_EYE_CHIN - 1) * eyeChin;
  const top = { x: eye.x - n.x * up, y: eye.y - n.y * up };
  const eyeDist = Math.hypot(r.x - l.x, r.y - l.y);
  let yaw = 0;
  if (face.nose) {
    const u = { x: Math.cos(roll), y: Math.sin(roll) };
    yaw = ((face.nose.x - eye.x) * u.x + (face.nose.y - eye.y) * u.y) / eyeDist;
  }
  return { eye, roll, eyeChin, headH, top, chin: face.chin, eyeDist, yaw };
}

// A transform maps source pixels into the unit output square:
//   out = R(rotation) · (src − c) · scale + (0.5, 0.5)
export function mapPoint(t, p) {
  const dx = p.x - t.cx;
  const dy = p.y - t.cy;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return {
    x: (dx * cos - dy * sin) * t.scale + 0.5,
    y: (dx * sin + dy * cos) * t.scale + 0.5,
  };
}

export function unmapPoint(t, q) {
  const ox = (q.x - 0.5) / t.scale;
  const oy = (q.y - 0.5) / t.scale;
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  return { x: ox * cos - oy * sin + t.cx, y: ox * sin + oy * cos + t.cy };
}

// Pan the transform so the output moves by (du, dv) output units.
export function panTransform(t, du, dv) {
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  return {
    ...t,
    cx: t.cx - (du * cos - dv * sin) / t.scale,
    cy: t.cy - (du * sin + dv * cos) / t.scale,
  };
}

// Fill the square with the image (like CSS object-fit: cover), no rotation.
export function coverTransform(w, h) {
  return { cx: w / 2, cy: h / 2, scale: 1 / Math.min(w, h), rotation: 0 };
}

// Level the eyes, size the head to TARGET_HEAD and put the eyes at
// TARGET_EYE_FROM_TOP, horizontally centred.
export function autoTransform(face) {
  const g = headGeometry(face);
  const scale = TARGET_HEAD / g.headH;
  const rotation = -g.roll;
  // Output offset of the eyes from the centre, rotated back into source space.
  const vy = (TARGET_EYE_FROM_TOP - 0.5) / scale;
  const cos = Math.cos(g.roll);
  const sin = Math.sin(g.roll);
  return {
    cx: g.eye.x - -vy * sin,
    cy: g.eye.y - vy * cos,
    scale,
    rotation,
  };
}

// True if every corner of the output square lands inside the source image.
export function coversImage(t, w, h) {
  return [
    [0, 0], [1, 0], [0, 1], [1, 1],
  ].every(([x, y]) => {
    const p = unmapPoint(t, { x, y });
    return p.x >= -0.5 && p.y >= -0.5 && p.x <= w + 0.5 && p.y <= h + 0.5;
  });
}

// Mean luminance, standard deviation and mean saturation of an RGBA rect.
export function regionStats(data, width, rect) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.floor(rect.x + rect.w);
  const y1 = Math.floor(rect.y + rect.h);
  let n = 0, sum = 0, sum2 = 0, sat = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (i + 2 >= data.length) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += l;
      sum2 += l * l;
      sat += Math.max(r, g, b) - Math.min(r, g, b);
      n++;
    }
  }
  if (!n) return { mean: 0, std: 0, sat: 0, n: 0 };
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), sat: sat / n, n };
}

const check = (id, ok, label, hint) => ({ id, ok, label, hint: ok ? '' : hint });

// Geometry checks for a face already expressed in unit-square output coords.
// `mirrored` flips left/right hints for a selfie-style preview.
export function geometryChecks(g, { mirrored = false } = {}) {
  const head = g.headH;
  const eyesFromBottom = 1 - g.eye.y;
  const offset = mirrored ? 0.5 - g.eye.x : g.eye.x - 0.5;
  const rollDeg = deg(g.roll);
  const out = [];
  out.push(check('size', head >= HEAD_MIN && head <= HEAD_MAX,
    `Head size ${(head * PHOTO_IN).toFixed(2)} in`,
    head < HEAD_MIN ? 'Move closer (head too small)' : 'Move back (head too large)'));
  out.push(check('eyes', eyesFromBottom >= EYES_MIN && eyesFromBottom <= EYES_MAX,
    `Eyes ${(eyesFromBottom * PHOTO_IN).toFixed(2)} in from bottom`,
    eyesFromBottom < EYES_MIN ? 'Aim camera lower (eyes too low)' : 'Aim camera higher (eyes too high)'));
  out.push(check('center', Math.abs(offset) <= MAX_CENTER_OFFSET, 'Face centered',
    offset > 0 ? 'Shift face ← on screen' : 'Shift face → on screen'));
  out.push(check('frame', g.top.y >= 0 && g.chin.y <= 1, 'Whole head in frame',
    'Fit the whole head in the frame'));
  out.push(check('level', Math.abs(rollDeg) <= MAX_ROLL_DEG, 'Head level',
    'Keep head straight (not tilted)'));
  out.push(check('facing', Math.abs(g.yaw) <= MAX_YAW, 'Facing camera',
    'Look straight at the camera'));
  return out;
}

// Pixel checks from stats of the background patches and face halves.
export function lightingChecks({ bg, faceLeft, faceRight }) {
  const out = [];
  if (bg) {
    out.push(check('bg-white', bg.mean >= BG_MIN_LUMA && bg.sat <= BG_MAX_SAT,
      'White / off-white background',
      bg.mean < BG_MIN_LUMA ? 'Background too dark – use a white wall & more light' : 'Background is tinted – use a white wall'));
    out.push(check('bg-plain', bg.std <= BG_MAX_STD, 'Plain background, no shadows',
      'Background not plain – remove objects or shadows behind you'));
  }
  if (faceLeft && faceRight) {
    const mean = (faceLeft.mean + faceRight.mean) / 2;
    out.push(check('exposure', mean >= FACE_MIN_LUMA && mean <= FACE_MAX_LUMA, 'Face well exposed',
      mean < FACE_MIN_LUMA ? 'Face too dark – face a window or lamp' : 'Face overexposed – soften the light'));
    out.push(check('even', Math.abs(faceLeft.mean - faceRight.mean) <= FACE_MAX_SIDE_DIFF,
      'Even light on face', 'Uneven light – shadow on one side of face'));
  }
  return out;
}

// Rewrite the JFIF density fields of a canvas-produced JPEG so print shops
// and photo apps see the intended DPI. Returns a new Uint8Array.
export function setJpegDpi(bytes, dpi) {
  const b = new Uint8Array(bytes);
  // FFD8 FFE0 len(2) 'JFIF\0' ver(2) units(1) xd(2) yd(2)
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[3] === 0xe0 &&
      b[6] === 0x4a && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46) {
    b[13] = 1;
    b[14] = dpi >> 8; b[15] = dpi & 0xff;
    b[16] = dpi >> 8; b[17] = dpi & 0xff;
  }
  return b;
}

// Change scale/rotation while keeping source point `p` under output point `q`.
export function anchorTransform(t, p, q) {
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  const ox = (q.x - 0.5) / t.scale;
  const oy = (q.y - 0.5) / t.scale;
  return { ...t, cx: p.x - (ox * cos - oy * sin), cy: p.y - (ox * sin + oy * cos) };
}

// Pool several regionStats results into one (as if measured together).
export function mergeStats(list) {
  let n = 0, sum = 0, sum2 = 0, sat = 0;
  for (const s of list) {
    n += s.n;
    sum += s.mean * s.n;
    sum2 += (s.std * s.std + s.mean * s.mean) * s.n;
    sat += s.sat * s.n;
  }
  if (!n) return { mean: 0, std: 0, sat: 0, n: 0 };
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), sat: sat / n, n };
}
