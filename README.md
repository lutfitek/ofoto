# US Passport Photo Helper

A phone web app for taking a US passport photo that meets the
[State Department photo requirements](https://travel.state.gov/en/passports/apply/help/photos.html).
It runs entirely in the browser. Photos never leave the device.

## What it does

1. **Camera with live guidance.** It overlays the target head outline and the allowed eye band
   (1 1/8 – 1 3/8 in from the bottom). It tracks the face and gives live hints like "Move closer",
   "Keep head straight", "Background too dark" or "Uneven light". **Auto** takes the picture once
   everything has been green for about a second. There's also a 3 s / 10 s timer, a front/rear
   camera switch, and an upload button for existing photos.
2. **Auto-crop and adjust.** It levels the eyes and scales the head to 1.2 in (60% of the photo).
   The eyes land 1.2 in from the bottom. You can fine-tune by dragging, pinching or using the
   sliders. The checks re-run as you adjust.
3. **Export.**
   - Digital: a 1200 × 1200 JPEG for online renewal.
   - Print: a 4 × 6 in sheet at 300 dpi with two 2 × 2 in photos and cut lines. Print it at
     actual size on photo paper.

## Checks

| Automatic | Manual (listed in the app) |
|---|---|
| Head size 1 – 1 3/8 in (50–69%) | No glasses |
| Eyes 1 1/8 – 1 3/8 in from bottom | Neutral expression, mouth closed |
| Face centered, whole head in frame | No hat / head covering, no headphones |
| Head level, facing camera, eyes open, one person | Everyday clothes, no uniform |
| White/off-white, plain background | Sharp photo, taken within 6 months |
| Face exposure and even lighting (no side shadow) | |

Face tracking uses the [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker),
which the app loads from a CDN. Landmarks stop at the hairline, so the top of the head is
estimated from the eye-to-chin distance. Check the crown against the oval. If the model can't
load, the app still works with manual alignment.

The app only crops, rotates and scales. It never retouches, filters or replaces the background,
because the State Department doesn't accept digitally altered photos. It's a helper: the passport
agency makes the final call.

## Run

Camera access needs HTTPS (or `localhost`). You can serve the folder with any static host, such
as GitHub Pages, Netlify or `npm start` (runs `python3 -m http.server 8080`), then open it on
your phone.

```sh
npm test   # unit tests for the geometry / pixel math (Node 20+)
```

## Files

- `index.html`, `css/style.css`: UI (camera → adjust → export)
- `js/app.js`: camera, gestures, rendering, exports
- `js/face.js`: MediaPipe wrapper
- `js/spec.js`: requirements, crop geometry and image checks (pure, unit tested)
