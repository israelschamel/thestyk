// Reading the code printed on a Styk: from a link (?tag=7F3A&pin=482915) or the phone camera.

export function parsePairing(text) {
  if (!text) return null;
  try {
    const u = new URL(text, location.href);
    const tag = (u.searchParams.get('tag') || '').trim().toUpperCase();
    const pin = (u.searchParams.get('pin') || '').trim();
    if (/^[0-9A-F]{4}$/.test(tag)) return { tag, pin: /^\d{6}$/.test(pin) ? pin : '' };
  } catch { /* not a URL */ }
  const m = String(text).toUpperCase().match(/\b([0-9A-F]{4})\b[\s\S]*?\b(\d{6})\b/);
  return m ? { tag: m[1], pin: m[2] } : null;
}

export function canScan() {
  return 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
}

// Streams the back camera into `video` until a QR code is found or `signal` aborts.
export async function scan(video, signal) {
  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  video.srcObject = stream;
  await video.play();
  try {
    while (!signal.aborted) {
      const codes = await detector.detect(video).catch(() => []);
      if (codes.length) return codes[0].rawValue;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
}
