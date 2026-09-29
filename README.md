# Passport Photo Helper

A phone web app that guides you to a compliant passport or visa photo. It runs entirely in the
browser. Photos never leave the device.

Supported documents (pick one in **⋯ Settings → Document**):

| | Size | Head (chin–crown) | Other placement | Background |
|---|---|---|---|---|
| 🇺🇸 United States ([rules](https://travel.state.gov/en/passports/apply/help/photos.html)) | 2 × 2 in (51 × 51 mm) | 25–35 mm (50–69%) | eyes 28–35 mm from bottom | white / off-white |
| 🇬🇧 United Kingdom ([rules](https://www.passport.service.gov.uk/photo/how-to-take-a-photo)) | 35 × 45 mm | 29–34 mm | – | plain light colour (cream, light grey) |
| 🇲🇾 Malaysia eVisa ([rules](https://malaysiavisa.imi.gov.my/evisa/check-photo)) | 35 × 50 mm | 30–35 mm | ≥ 5 mm above head | white |

## How it works

One screen, three buttons:

```
┌───────────────────┐
│  photo frame      │  live camera, or the captured photo (drag / pinch to adjust)
│   ( oval guide )  │  pulsing red arrows / lines show what to move
└───────────────────┘
   ( ✓ bubble )        what to fix next → big green ✓ when the photo meets the rules
[ Upload ] [ ◉ ] [ ⋯ ]  upload · capture / save · settings
```

- **When the camera turns on**, it shows how-to instructions for the selected country (dismissable).
- **Live guidance.** The app tracks the face and finds the most important problem, like
  *Too far – move closer*, *Too dark*, *Camera too low*, *Keep head straight* or
  *Background not plain*. It shows it in the bubble and animates a cue in the frame:
  - Arrows point out or in when you need to move closer or back.
  - The eye band pulses when the eyes are too high or low.
  - An arrow points toward the center line when the face is off-center.
  - A curved arrow shows which way to straighten a tilted head.
  - Side arrows tell you to raise or lower the phone.
  - A warm glow means it's too dark.
  - Highlighted background patches point at clutter or shadows.

  Serious problems (too dark, too far) make the frame glow red. When everything passes, the
  bubble turns into a green ✓ and, with auto-capture on, the photo is taken after about 1 s of
  holding still.
- **Captured / uploaded photo.** Auto-crop levels the eyes and sizes and places the head per the
  country's rules. If the photo is dark or flat it is auto-enhanced (light/contrast/sharpen). The
  same checks run again, with photo-specific hints (*Drag the photo up*, *Taken too close –
  retake from further back*, and so on).
- **⋯ Settings:**
  - document/country and rules
  - camera flip, timer, auto-capture
  - zoom/rotate and auto-crop
  - enhance (light, contrast, sharpen; ✨ Auto; Original)
  - background replace (white, off-white, light grey, cream) or remove (transparent PNG)
  - digital file-size limit
- **Save:**
  - the digital JPEG in the country's pixel size
  - a 4 × 6 in print sheet at 300 dpi with as many photos as fit and cut lines
  - a transparent PNG cut-out, when the background was removed

## Checks

| Automatic | Manual (listed when saving) |
|---|---|
| One face, head size, eye height / top margin, centered, whole head in frame | No glasses / glare |
| Head level, facing camera, camera at eye level, eyes open | Neutral expression, mouth closed |
| Background colour and plainness | No hat or head covering (unless religious/medical) |
| Face exposure, even light (no side shadow) | Sharp, recent photo |
| Photo fills the frame, enough resolution | |

Face tracking uses the MediaPipe Face Landmarker, and background replacement uses the MediaPipe
selfie multiclass segmenter. Both load from a CDN; the segmenter (~16 MB) only loads the first
time you replace a background. Landmarks stop at the hairline, so the top of the head is
estimated from the eye-to-chin distance. The "camera at eye level" check compares where the nose
tip sits between the eyes and the chin.

**Retouching warning.** The US and UK both forbid digitally altered photos. When enhancement or
background replacement is on, the app says so. Retaking in good light against a plain wall is
always the safest option. The app is a helper; the issuing agency makes the final decision.

## Run

Camera access needs HTTPS (or `localhost`). You can serve the folder with any static host, such
as GitHub Pages, Netlify or `npm start` (runs `python3 -m http.server 8080`), then open it on
your phone.

```sh
npm test   # unit tests for rules, geometry, pixel checks and enhancement (Node 20+)
```

## Files

- `index.html`, `css/style.css`: single-screen UI, settings/save sheets
- `js/app.js`: camera, guidance, gestures, rendering, export
- `js/face.js`: MediaPipe face landmarker + background segmenter
- `js/spec.js`: country rules, crop geometry and checks (pure, unit tested)
- `js/enhance.js`: light/contrast/sharpen and mask helpers (pure, unit tested)
