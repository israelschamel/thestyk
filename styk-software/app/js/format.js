// Small formatting helpers shared by the views.

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const rtf = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat
  ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  : null;

export function relTime(t, now = Date.now()) {
  if (!t) return 'never';
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (!rtf) return new Date(t).toLocaleString();
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function clock(t) {
  if (!t) return '';
  const d = new Date(t);
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

// RSSI in dBm to plain words and a 0-3 strength.
export function signal(rssi) {
  if (rssi == null) return { words: 'Unknown', level: 0 };
  if (rssi >= -60) return { words: 'Strong, very close', level: 3 };
  if (rssi >= -75) return { words: 'Good, in the room', level: 2 };
  return { words: 'Weak, a few rooms away', level: 1 };
}

export function solarWords(tag) {
  if (tag.charging) return 'Charging from light';
  if (tag.battery?.pct != null) return 'Not charging right now';
  return 'Not measured yet';
}

export function directionsUrl(p) {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}
