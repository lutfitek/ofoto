// Country photo rules and the pure geometry/pixel math used by the app.
// Everything here is DOM-free so it can be unit tested with `node --test`.
//
// Output coordinates: y runs 0 (top) … 1 (bottom) over the photo height and
// x runs 0 … aspect (width / height), so both axes share one unit.

const IN = 25.4;

export const COUNTRIES = {
  us: {
    id: 'us',
    name: 'United States',
    flag: '🇺🇸',
    // travel.state.gov passport photos + photo composition template
    source: 'https://travel.state.gov/en/passports/apply/help/photos.html',
    widthMm: 2 * IN,
    heightMm: 2 * IN,
    sizeLabel: '2 × 2 in (51 × 51 mm)',
    headMm: [1 * IN, 1.375 * IN],          // chin to top of hair: 50–69%
    eyesFromBottomMm: [1.125 * IN, 1.375 * IN],
    topMinMm: null,
    targetHeadMm: 0.6 * 2 * IN,
    targetTopMm: 4.35,                     // puts eyes 1.2 in from the bottom
    background: 'white',                   // white or off-white
    bgLabel: 'plain white or off-white',
    replaceColor: '#ffffff',
    digital: { w: 1200, h: 1200, minH: 600, label: '1200 × 1200 JPEG (600–1200 px square)' },
    noAlteration: 'US rules: photos must not be digitally altered or filtered.',
    rules: [
      ['Size', '2 × 2 in (51 × 51 mm), color'],
      ['Head', '1 – 1 3/8 in (25 – 35 mm) chin to top of head incl. hair (50–69% of height)'],
      ['Eyes', '1 1/8 – 1 3/8 in (28 – 35 mm) from the bottom (56–69%)'],
      ['Background', 'plain white or off-white, no shadows or objects'],
      ['Pose', 'face the camera directly, full face visible, head centered'],
      ['Expression', 'neutral, mouth closed, both eyes open'],
      ['Not allowed', 'glasses, hats/head coverings (except religious or medical with a signed statement), headphones, uniforms, camouflage'],
      ['Quality', 'high resolution, in focus, even lighting, no filters or retouching'],
      ['Recent', 'taken in the last 6 months'],
      ['Digital', 'square JPEG, 600 × 600 to 1200 × 1200 px'],
    ],
  },
  uk: {
    id: 'uk',
    name: 'United Kingdom',
    flag: '🇬🇧',
    source: 'https://www.passport.service.gov.uk/photo/how-to-take-a-photo',
    widthMm: 35,
    heightMm: 45,
    sizeLabel: '35 × 45 mm',
    headMm: [29, 34],
    eyesFromBottomMm: null,
    topMinMm: 2,
    targetHeadMm: 31.5,
    targetTopMm: 5,
    background: 'light',                   // cream, light grey, shades of white
    bgLabel: 'plain light colour (cream, light grey or off-white)',
    replaceColor: '#e4e4e2',
    digital: { w: 700, h: 900, minH: 750, label: '700 × 900 JPEG (min. 600 × 750, 50 KB – 10 MB)' },
    noAlteration: 'UK rules: photos must not be altered using computer software.',
    rules: [
      ['Size', '35 mm wide × 45 mm high, color'],
      ['Head', '29 – 34 mm from chin to crown'],
      ['Background', 'plain light colour – cream, light grey or off-white – in clear contrast to you'],
      ['Framing', 'head, shoulders and upper body; no other objects or people'],
      ['Expression', 'plain expression, mouth closed, eyes open and visible'],
      ['Face', 'facing forwards, looking straight at the camera, no hair over eyes, no red eye'],
      ['Lighting', 'no shadows on face or behind you'],
      ['Not allowed', 'head coverings (unless religious or medical), sunglasses/tinted glasses, glare on glasses'],
      ['Recent', 'taken in the last month'],
      ['Digital', 'at least 600 × 750 px, 50 KB – 10 MB JPEG'],
    ],
  },
  my: {
    id: 'my',
    name: 'Malaysia (eVisa)',
    flag: '🇲🇾',
    source: 'https://malaysiavisa.imi.gov.my/evisa/check-photo',
    widthMm: 35,
    heightMm: 50,
    sizeLabel: '35 × 50 mm',
    headMm: [30, 35],
    eyesFromBottomMm: null,
    topMinMm: 5,
    targetHeadMm: 32,
    targetTopMm: 6,
    background: 'white',
    bgLabel: 'plain white',
    replaceColor: '#ffffff',
    digital: { w: 827, h: 1181, minH: 591, label: '827 × 1181 JPEG (35 × 50 mm at 600 dpi)' },
    noAlteration: 'Uploads are validated automatically – keep edits natural.',
    rules: [
      ['Size', '35 mm wide × 50 mm high, color'],
      ['Head', 'about 30 – 35 mm chin to crown, whole head incl. hairline visible'],
      ['Top margin', 'top of head at least 5 mm below the top edge'],
      ['Background', 'plain white, uniform – no gradients, patterns, objects, shadows or reflections'],
      ['Pose', 'face the camera directly, neutral expression, eyes open'],
      ['Validation', 'eVisa uploads are checked automatically against these specifications'],
    ],
  },
};

// Landmarks only reach the hairline, so the crown is estimated from the
// eye-to-chin distance: full head height (with hair) ≈ K × eye-to-chin.
export const HEAD_PER_EYE_CHIN = 2.1;

export const PRINT_DPI = 300;
export const SHEET_MM = [6 * IN, 4 * IN];   // 4 × 6 in photo print

// Pixel-analysis thresholds (0–255 luminance).
export const BG = {
  white: { minLuma: 170, maxSat: 35 },
  light: { minLuma: 150, maxSat: 50 },
};
export const BG_MAX_STD = 24;
export const FACE_MIN_LUMA = 80;
export const FACE_MAX_LUMA = 220;
export const FACE_MAX_SIDE_DIFF = 30;
export const SCENE_DARK_LUMA = 70;

export const MAX_ROLL_DEG = 3;
export const MAX_YAW = 0.12;
export const MAX_CENTER_OFFSET = 0.05;     // fraction of photo width
export const MAX_EYE_BLINK = 0.5;
// Nose tip position between the eyes (0) and chin (1). Frontal faces sit
// around 0.35–0.42; shooting from below squashes it toward the eyes.
export const PITCH_RANGE = [0.28, 0.5];

const deg = (rad) => (rad * 180) / Math.PI;

// Ratios (of the photo height) derived from a country's millimetre rules.
export function layout(c) {
  const H = c.heightMm;
  const targetHead = c.targetHeadMm / H;
  const targetTop = c.targetTopMm / H;
  return {
    aspect: c.widthMm / c.heightMm,
    headMin: c.headMm[0] / H,
    headMax: c.headMm[1] / H,
    eyes: c.eyesFromBottomMm ? [c.eyesFromBottomMm[0] / H, c.eyesFromBottomMm[1] / H] : null,
    topMin: c.topMinMm == null ? 0 : c.topMinMm / H,
    targetHead,
    targetTop,
    targetEyeFromTop: targetTop + (targetHead * (HEAD_PER_EYE_CHIN - 1)) / HEAD_PER_EYE_CHIN,
    mmPerUnit: H,
  };
}

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
  let pitch = null;
  if (face.nose) {
    const u = { x: Math.cos(roll), y: Math.sin(roll) };
    yaw = ((face.nose.x - eye.x) * u.x + (face.nose.y - eye.y) * u.y) / eyeDist;
    pitch = ((face.nose.x - eye.x) * n.x + (face.nose.y - eye.y) * n.y) / eyeChin;
  }
  return { eye, roll, eyeChin, headH, top, chin: face.chin, eyeDist, yaw, pitch };
}

// A transform maps source pixels into output units:
//   out = R(rotation) · (src − c) · scale + (aspect / 2, 0.5)
export function mapPoint(t, p) {
  const dx = p.x - t.cx;
  const dy = p.y - t.cy;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return {
    x: (dx * cos - dy * sin) * t.scale + t.aspect / 2,
    y: (dx * sin + dy * cos) * t.scale + 0.5,
  };
}

export function unmapPoint(t, q) {
  const ox = (q.x - t.aspect / 2) / t.scale;
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

// Change scale/rotation while keeping source point `p` under output point `q`.
export function anchorTransform(t, p, q) {
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  const ox = (q.x - t.aspect / 2) / t.scale;
  const oy = (q.y - 0.5) / t.scale;
  return { ...t, cx: p.x - (ox * cos - oy * sin), cy: p.y - (ox * sin + oy * cos) };
}

// Fill the photo with the image (like CSS object-fit: cover), no rotation.
export function coverTransform(w, h, aspect) {
  return { cx: w / 2, cy: h / 2, scale: Math.max(aspect / w, 1 / h), rotation: 0, aspect };
}

// Level the eyes, size the head and place the crown per the country layout.
export function autoTransform(face, L) {
  const g = headGeometry(face);
  const scale = L.targetHead / g.headH;
  const vy = (L.targetEyeFromTop - 0.5) / scale;
  const cos = Math.cos(g.roll);
  const sin = Math.sin(g.roll);
  return {
    cx: g.eye.x + vy * sin,
    cy: g.eye.y - vy * cos,
    scale,
    rotation: -g.roll,
    aspect: L.aspect,
  };
}

// True if every corner of the output lands inside the source image.
export function coversImage(t, w, h) {
  return [
    [0, 0], [t.aspect, 0], [0, 1], [t.aspect, 1],
  ].every(([x, y]) => {
    const p = unmapPoint(t, { x, y });
    return p.x >= -0.5 && p.y >= -0.5 && p.x <= w + 0.5 && p.y <= h + 0.5;
  });
}

// Mean luminance, standard deviation and mean saturation of an RGBA rect.
// Transparent pixels (outside the photo) are ignored.
export function regionStats(data, width, rect) {
  const height = Math.floor(data.length / 4 / width);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.floor(rect.x + rect.w));
  const y1 = Math.min(height, Math.floor(rect.y + rect.h));
  let n = 0, sum = 0, sum2 = 0, sat = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
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

const check = (id, ok, label, hint, cue) => ({ id, ok, label, hint: ok ? '' : hint, cue: ok ? null : cue });

// Geometry checks for a face in output units. `cue` tells the overlay which
// visual cue to animate. `mirrored` flips left/right hints for a selfie preview.
export function geometryChecks(g, L, { mirrored = false } = {}) {
  const mm = (v) => `${(v * L.mmPerUnit).toFixed(1)} mm`;
  const head = g.headH;
  const offset = (mirrored ? -1 : 1) * (g.eye.x - L.aspect / 2) / L.aspect;
  const rollDeg = deg(g.roll);
  const out = [];
  out.push(check('size', head >= L.headMin && head <= L.headMax,
    `Head ${mm(head)}`,
    head < L.headMin ? 'Too far – move closer' : 'Too close – move back',
    head < L.headMin ? 'grow' : 'shrink'));
  if (L.eyes) {
    const eyes = 1 - g.eye.y;
    out.push(check('eyes', eyes >= L.eyes[0] && eyes <= L.eyes[1],
      `Eyes ${mm(eyes)} from bottom`,
      eyes < L.eyes[0] ? 'Eyes too low – tilt camera down / raise head in frame' : 'Eyes too high – tilt camera up',
      eyes < L.eyes[0] ? 'up' : 'down'));
  }
  if (L.topMin > 0) {
    out.push(check('top', g.top.y >= L.topMin, `Space above head ${mm(Math.max(0, g.top.y))}`,
      'Not enough space above head – tilt camera up', 'down'));
  }
  out.push(check('center', Math.abs(offset) <= MAX_CENTER_OFFSET, 'Face centered',
    offset > 0 ? 'Shift face ← on screen' : 'Shift face → on screen', offset > 0 ? 'left' : 'right'));
  out.push(check('frame', g.top.y >= 0 && g.chin.y <= 1, 'Whole head in frame',
    'Fit the whole head in the frame', 'shrink'));
  out.push(check('level', Math.abs(rollDeg) <= MAX_ROLL_DEG, 'Head level',
    'Keep head straight (not tilted)', 'tilt'));
  out.push(check('facing', Math.abs(g.yaw) <= MAX_YAW, 'Facing camera',
    'Look straight at the camera', 'facing'));
  if (g.pitch != null) {
    const low = g.pitch < PITCH_RANGE[0];
    out.push(check('pitch', g.pitch >= PITCH_RANGE[0] && g.pitch <= PITCH_RANGE[1], 'Camera at eye level',
      low ? 'Camera too low – raise it to eye level (chin level)' : 'Camera too high – lower it to eye level',
      low ? 'raise' : 'lower'));
  }
  return out;
}

// Pixel checks from stats of the background patches, face halves and scene.
export function lightingChecks({ bg, faceLeft, faceRight, scene }, background = 'white') {
  const out = [];
  if (scene && !(faceLeft && faceRight)) {
    out.push(check('dark', scene.mean >= SCENE_DARK_LUMA, 'Enough light',
      'Too dark – turn on lights or face a window', 'dark'));
  }
  if (bg?.n) {
    const rule = BG[background];
    const label = background === 'white' ? 'White background' : 'Light plain background';
    out.push(check('bg-color', bg.mean >= rule.minLuma && bg.sat <= rule.maxSat, label,
      bg.mean < rule.minLuma ? 'Background too dark – use a light wall & more light' : 'Background is tinted – use a plain light wall',
      'bg'));
    out.push(check('bg-plain', bg.std <= BG_MAX_STD, 'Plain background, no shadows',
      'Background not plain – remove objects or shadows behind you', 'bg'));
  }
  if (faceLeft && faceRight) {
    const mean = (faceLeft.mean + faceRight.mean) / 2;
    out.push(check('dark', mean >= FACE_MIN_LUMA, 'Enough light on face',
      'Too dark – turn on lights or face a window', 'dark'));
    out.push(check('bright', mean <= FACE_MAX_LUMA, 'Face not overexposed',
      'Face overexposed – soften the light', 'dark'));
    out.push(check('even', Math.abs(faceLeft.mean - faceRight.mean) <= FACE_MAX_SIDE_DIFF,
      'Even light on face', 'Uneven light – shadow on one side of face', 'dark'));
  }
  return out;
}

// How many photos of w × h mm fit on a sheet, trying both orientations.
export function sheetLayout(wMm, hMm, sheet = SHEET_MM, margin = 3, gap = 3) {
  let best = null;
  for (const [sw, sh] of [sheet, [sheet[1], sheet[0]]]) {
    const cols = Math.floor((sw - 2 * margin + gap) / (wMm + gap));
    const rows = Math.floor((sh - 2 * margin + gap) / (hMm + gap));
    if (!best || cols * rows > best.cols * best.rows) best = { sw, sh, cols, rows };
  }
  return best;
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
