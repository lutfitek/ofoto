// Saving files: native in the Android app (Capacitor), browser APIs on the web.

const cap = globalThis.Capacitor;
export const isNative = Boolean(cap?.isNativePlatform?.());

const FOLDER = 'ofoto';

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Android app: write to Documents/ofoto, then open the share sheet
// (print, Drive, messaging…). Returns where the file was saved.
async function saveNative(blob, name) {
  const { Filesystem, Share } = cap.Plugins;
  const data = await toBase64(blob);
  const path = `${FOLDER}/${name}`;
  let saved = null;
  try {
    await Filesystem.writeFile({ path, data, directory: 'DOCUMENTS', recursive: true });
    saved = `Documents/${path}`;
  } catch {
    // Older Android without storage access: fall back to the share sheet only.
  }
  const { uri } = await Filesystem.writeFile({ path: name, data, directory: 'CACHE' });
  try {
    await Share.share({ title: name, files: [uri] });
  } catch {
    // Share sheet dismissed – the file is still saved.
  }
  return saved ?? 'the share sheet';
}

// Browser: share sheet where supported, otherwise a download.
async function saveWeb(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'the share sheet';
    } catch (err) {
      if (err.name === 'AbortError') return null;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  return null; // can't tell whether the browser allowed the download
}

export const saveFile = (blob, name) => (isNative ? saveNative(blob, name) : saveWeb(blob, name));
