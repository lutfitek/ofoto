window.PPH_ASSETS = {
  bundle: new URL('mediapipe/vision_bundle.mjs', document.baseURI).href,
  wasm: new URL('mediapipe/wasm', document.baseURI).href,
  faceModel: new URL('models/face_landmarker.task', document.baseURI).href,
  segModel: new URL('models/selfie_multiclass_256x256.tflite', document.baseURI).href,
  segModelSize: '16 MB',
  segMaskIndex: 0,          // class 0 = background
  segMaskIsBackground: true,
  // Download sizes, for the progress shown while the face guide loads.
  engineBytes: 9423986,
  faceModelBytes: 3758596,
};
