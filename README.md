# simplytake

**A guided passport and visa photo app.** Point your phone's camera and simplytake tells you what
to fix, whether that's distance, head tilt, camera height, lighting, shadows or background.
When the photo meets the rules, a green ✓ appears. It crops the photo to the exact size and
saves a digital file plus a 4 × 6 in print sheet. Everything runs on the phone; photos never
leave the device.

> **Experimental.** simplytake is a free tool for people to try out. It isn't affiliated with
> any government or passport agency, and its checks are estimates. **Always check the current
> official requirements and instructions for your document before you apply.**

**Try it:**
- **Web:** https://lutfitek.github.io/simplytake/ (works in a phone browser, with the live camera)
- **Android:** download `simplytake.apk` from [Releases → android-test](https://github.com/lutfitek/simplytake/releases/tag/android-test)

| Document | Size | Head (chin to crown) | Other placement | Background |
|---|---|---|---|---|
| 🇺🇸 United States ([rules](https://travel.state.gov/en/passports/apply/help/photos.html)) | 2 × 2 in (51 × 51 mm); digital 600–1200 px square | 25–35 mm (50–69 %) | eyes 28–35 mm from bottom | white / off-white |
| 🇬🇧 United Kingdom ([rules](https://www.passport.service.gov.uk/photo/how-to-take-a-photo)) | 35 × 45 mm print; digital **uncropped** (head, shoulders, upper body, ≥ 600 × 750 px, 50 KB–10 MB) | 29–34 mm | – | plain light colour (cream, light grey) |
| 🇲🇾 Malaysia eVisa ([rules](https://malaysiavisa.imi.gov.my/evisa/check-photo)) | 35 × 50 mm | 30–35 mm | ≥ 5 mm above head | white or blue |

A green ✓ means the photo passed simplytake's own checks, not that it will be accepted. The
issuing agency makes the final decision, and rules change, so use the links above to check the
official requirements.

## Install on Android

1. On your phone, open [Releases → android-test](https://github.com/lutfitek/simplytake/releases/tag/android-test).
2. Tap `simplytake.apk` to download it.
3. Open the download. Android will ask whether your browser may install apps: allow it, then
   tap **Install**. (Android warns about apps from outside the Play Store; this is a test build.)
4. Open **simplytake** and allow camera access.

New builds install over the old one, so you can update the same way. The app needs camera
access and has **no internet permission**.

## Privacy

- Your photos never leave your device. Face detection, checks and editing all run on the phone.
- The Android app has no internet permission. The web version downloads the app and its
  face-detection models from GitHub Pages once, then works on your device; your photos are
  never uploaded.
- No accounts, analytics or tracking. The only things stored are your settings (like the
  chosen document), on your device.

## Feedback

Found a problem, or got a photo accepted or rejected? Open an issue with the
[feedback form](https://github.com/lutfitek/simplytake/issues/new?template=feedback.md), or use
**⋯ Settings → Send feedback** in the app. **Please don't attach photos of your face or
documents**, as issues are public.

## How it works

One screen, three buttons:

```
┌───────────────────┐
│  photo frame      │  live camera, or the captured photo (drag / pinch to adjust)
│   ( oval guide )  │  pulsing arrows / lines show what to move
└───────────────────┘
   ( ✓ bubble )        what to fix next → big green ✓ when the photo meets the rules
[ Upload ] [ ◉ ] [ ⋯ ]  upload · capture / save · settings
```

- **Before the camera starts**, the frame shows a placeholder from the app icon. When the
  camera turns on, it shows how-to instructions for the selected document.
- **Live guidance.** The app tracks the face and names the most important problem, like
  *Too far – move closer*, *Too dark*, *Camera too low*, *Keep head straight* or *Shadow on
  one side*. It shows it in the bubble and animates a cue in the frame:
  - Arrows point out or in when you need to move closer or back.
  - The eye band pulses when the eyes are too high or low.
  - An arrow points toward the center line when the face is off-center.
  - A curved arrow shows which way to straighten a tilted head.
  - Side arrows tell you to raise or lower the phone.
  - A pulsing ring marks a shadowed spot on the face.
  - Highlighted patches point at a cluttered background.

  When everything passes, the bubble turns into a green ✓ and, with auto-capture on, the photo
  is taken after about a second of holding still.
- **Zoom.** A slider under the frame (or pinch on the preview) zooms the live camera, using the
  camera's own zoom when it has one and digital zoom otherwise.
- **Sharp captures.** If the phone's camera can take stills sharper than the preview, simplytake
  uses the full-resolution still. It falls back to the preview frame automatically if that
  fails.
- **Captured or uploaded photo.** Auto-crop levels the eyes and sizes and places the head per
  the document's rules. Dark or flat photos are auto-enhanced (light, contrast, sharpen). The
  checks run again with photo-specific hints (*Drag the photo up*, *Taken too close – retake
  from further back*, and so on).
- **⋯ Settings:**
  - document and its rules
  - camera flip, timer, auto-capture, full-resolution stills
  - zoom, rotate and auto-crop
  - enhance
  - background replace (white, off-white, light grey, cream; blue for Malaysia) or remove
  - digital file-size limit
- **Save:**
  - the digital JPEG in the document's pixel size (uncropped for UK online applications)
  - a 4 × 6 in print sheet at 300 dpi with cut lines
  - a transparent PNG cut-out, when the background was removed

  In the Android app, files go to `Documents/simplytake` and the share sheet opens. In a
  browser, press and hold the image to save it.

## Checks

| Automatic | Manual (listed when saving) |
|---|---|
| One face, head size, eye height / top margin, centered, whole head in frame | No glasses / glare |
| Head level, facing camera, camera at eye level, eyes open | Neutral expression, mouth closed |
| Background colour and plainness | No hat or head covering (unless religious/medical) |
| Exposure; even light, comparing mirror-image skin spots | Sharp, recent photo |
| Photo fills the frame, enough resolution; shoulders visible (UK) | |

How some checks work:

- **Face tracking** uses the MediaPipe Face Landmarker. Landmarks stop at the hairline, so the
  top of the head is estimated from the eye-to-chin distance.
- **Camera at eye level** compares where the nose tip sits between the eyes and the chin.
- **Even light** compares the forehead, under the eyes, beside the nose and the cheeks on each
  side. It only counts skin-coloured pixels, so hair and beards don't read as shadow. The
  middle value of the left/right differences must stay within 13 %.

**Retouching warning.** The US and UK reject digitally altered photos, and US uploads are
screened automatically. When enhancement or background replacement is on, the app says so.
Retaking in good light against a plain wall is always the safest option.

## Develop

```sh
npm ci
npm test            # unit tests: rules, geometry, pixel and shadow checks, enhancement
npm start           # serve the web app at http://localhost:8080
```

Camera access needs HTTPS or `localhost`. Serving the source folder directly (as `npm start`
does) loads the MediaPipe runtime and models from their CDNs. The published web app is built
with `npm run build:web` instead, which bundles them, and `.github/workflows/pages.yml`
deploys that `www/` folder to GitHub Pages on every push to `main`.

### Android app

`android/` is a [Capacitor](https://capacitorjs.com) wrapper around the same web app.
`scripts/build-web.mjs` builds `www/` with the MediaPipe runtime (SIMD build) and both models
bundled, so the app runs fully offline. The models are the 3.7 MB face landmarker and the 16 MB
multiclass background model.

```sh
npm run android:debug   # build www/, cap sync, gradle assembleDebug (Node 22, JDK 21, Android SDK)
```

Builds are signed with `android/app/sideload.keystore`, a **test key committed on purpose** so
sideloaded builds install over each other. Before publishing to Google Play, create a private
upload key, keep it out of git, and read it from CI secrets instead.

### Files

- `index.html`, `css/style.css`: single-screen UI, settings and save sheets
- `js/app.js`: camera, guidance, gestures, rendering, export
- `js/face.js`: MediaPipe face landmarker and background segmenter
- `js/spec.js`: document rules, crop geometry and checks (pure, unit tested)
- `js/enhance.js`: light, contrast, sharpen and mask helpers (pure, unit tested)
- `js/platform.js`: saving files (native in the Android app, share/download on the web)
- `scripts/build-web.mjs`, `capacitor.config.json`, `android/`: Android app
- `.github/workflows/android.yml`: APK build and android-test release
- `.github/workflows/pages.yml`: web app build and GitHub Pages deploy
- `.github/ISSUE_TEMPLATE/feedback.md`: the feedback form

## License

simplytake is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). You may
use, change and share it for any noncommercial purpose. Commercial use needs a separate
license from the author.

Required Notice: Copyright (c) 2026 lutfitek (https://github.com/lutfitek)

Third-party components keep their own licenses:

- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) and its face landmarker
  and selfie segmentation models: Apache License 2.0.
- [Capacitor](https://github.com/ionic-team/capacitor): MIT License.
