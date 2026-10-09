// Styk app: your tags, play a sound, last seen, add and remove tags.
import { store, newId } from './store.js';
import * as ble from './ble.js';
import { demoTags, DemoLink } from './demo.js';
import { drawMap } from './map.js';
import { parsePairing, canScan, scan } from './qr.js';
import { icon, ICON_CHOICES, ui } from './icons.js';
import { esc, relTime, clock, signal, solarWords, directionsUrl } from './format.js';

const VERSION = '0.2.0';
const SIGHTING_EVERY_MS = 2 * 60 * 1000;

const view = document.getElementById('view');
const barLeft = document.getElementById('bar-left');
const barRight = document.getElementById('bar-right');
const toastEl = document.getElementById('toast');
const dialogEl = document.getElementById('dialog');

// ---------------------------------------------------------------- runtime state (not saved)
const runtime = new Map();
function R(id) {
  if (!runtime.has(id)) runtime.set(id, { state: 'idle', link: null, sound: false, rssi: null, rssiAt: 0, error: '', step: '', lastSighting: 0, soundTimer: null });
  return runtime.get(id);
}

let addState = { tag: '', pin: '', name: '', icon: 'backpack', busy: false, step: '', error: '' };
let installPrompt = null;
let currentMap = null;
let mapKey = '';

// A pairing link (?tag=7F3A&pin=482915) opens the Add screen. The PIN is removed from the address bar.
(function readPairingLink() {
  if (!location.search) return;
  const p = parsePairing(location.href);
  if (p) {
    addState = { ...addState, tag: p.tag, pin: p.pin };
    history.replaceState(null, '', location.pathname + '#/add');
  }
})();

// ---------------------------------------------------------------- helpers
function styk(message) {
  const e = new Error(message);
  e.styk = true;
  return e;
}

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

function route() {
  const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (name === 'tag' && id) return { name: 'tag', id: decodeURIComponent(id) };
  if (name === 'add' || name === 'settings') return { name };
  return { name: 'home' };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function hasDemo() {
  return store.tags.some((t) => t.kind === 'demo');
}

async function geoPermission() {
  try {
    const p = await navigator.permissions.query({ name: 'geolocation' });
    return p.state; // granted | prompt | denied
  } catch {
    return 'prompt';
  }
}

function getLocation({ ask = true } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    const run = () => navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 9000 },
    );
    if (ask) return run();
    geoPermission().then((s) => (s === 'granted' ? run() : resolve(null)));
  });
}

function recordSighting(id, how, { force = false } = {}) {
  const r = R(id);
  if (!force && Date.now() - r.lastSighting < SIGHTING_EVERY_MS) return;
  r.lastSighting = Date.now();
  getLocation().then((where) => {
    if (!store.tag(id)) return;
    store.seen(id, where, how);
    refresh(id);
  });
}

// ---------------------------------------------------------------- status words
function statusOf(t) {
  const r = R(t.id);
  const seen = t.lastSeen ? relTime(t.lastSeen.t) : '';
  if (r.state === 'connecting') return { key: 'busy', label: r.step || 'Connecting', line: r.step || 'Connecting' };
  if (r.state === 'connected') return { key: 'good', label: 'Connected', line: 'Connected now' };
  if (r.rssi != null && Date.now() - r.rssiAt < 60000) return { key: 'near', label: 'Nearby', line: 'Nearby now' };
  if (t.kind === 'demo' && t.demoRole === 'near') return { key: 'near', label: 'Nearby', line: 'Nearby now' };
  if (t.kind === 'demo' && t.demoRole === 'away') return { key: 'away', label: 'Out of range', line: `Out of range, seen ${seen}` };
  return { key: 'idle', label: 'Not connected', line: t.lastSeen ? `Seen ${seen}` : 'Not seen yet' };
}

function level(t) {
  const r = R(t.id);
  const st = statusOf(t).key;
  if (st === 'good') return r.rssi != null ? signal(r.rssi).level : 3;
  if (st === 'near') return r.rssi != null ? signal(r.rssi).level : 2;
  return 0;
}

function batteryChip(t) {
  const pct = t.battery?.pct;
  if (pct == null) return '<span class="batt-num quiet">--</span>';
  const low = pct < 15 ? ' low' : '';
  return `<span class="batt${low}" aria-hidden="true"><span class="batt-fill" style="width:${pct}%"></span></span><span class="batt-num" aria-label="Battery ${pct} percent">${pct}%</span>`;
}

function seenText(t) {
  if (!t.lastSeen) return 'Not yet';
  const where = t.lastSeen.lat != null ? '' : ' (location off)';
  return `${relTime(t.lastSeen.t)}, ${clock(t.lastSeen.t)}${where}`;
}

function batteryText(t) {
  const b = t.battery;
  if (!b || b.pct == null) return 'Unknown until connected';
  const low = b.pct < 15 ? ', low' : '';
  const age = b.t && Date.now() - b.t > 10 * 60000 ? `, as of ${relTime(b.t)}` : '';
  return `${b.pct}%${low}${age}`;
}

function signalText(t) {
  const r = R(t.id);
  const st = statusOf(t).key;
  if (st === 'good' || st === 'near') return r.rssi != null ? signal(r.rssi).words : (st === 'good' ? 'Connected' : 'In range');
  if (st === 'away') return 'Out of range';
  return 'Not connected';
}

// ---------------------------------------------------------------- pieces
function radar(t) {
  const lv = level(t);
  const r = R(t.id);
  const cx = 74, cy = 60;
  const arc = (rad, i) => {
    const a = 48 * Math.PI / 180;
    const x1 = cx + rad * Math.cos(-a), y1 = cy + rad * Math.sin(-a);
    const x2 = cx + rad * Math.cos(a), y2 = cy + rad * Math.sin(a);
    return `<path class="arc${i < lv ? ' on' : ''}" d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${rad} ${rad} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
  };
  return `<svg viewBox="0 0 320 120" class="radar-svg${r.sound ? ' ringing' : ''}" role="img" aria-label="Signal: ${esc(signalText(t))}">
    <rect class="glyph" x="44" y="38" width="44" height="44" rx="10"/>
    <rect class="glyph-window" x="50" y="44" width="32" height="20" rx="4"/>
    ${arc(34, 0)}${arc(56, 1)}${arc(78, 2)}
    <rect class="phone" x="246" y="30" width="34" height="60" rx="7"/>
    <line class="phone-line" x1="258" y1="83" x2="268" y2="83"/>
  </svg>`;
}

function soundButton(t) {
  const r = R(t.id);
  if (r.sound) return `<button class="btn btn-primary btn-xl" data-action="sound" data-on="0">${ui('stop')} Stop sound</button>`;
  const busy = r.state === 'connecting' ? ' disabled' : '';
  return `<button class="btn btn-primary btn-xl" data-action="sound" data-on="1"${busy}>${ui('speaker')} Play sound</button>`;
}

function connectButton(t) {
  const r = R(t.id);
  if (r.state === 'connected') return '<button class="btn btn-line" data-action="disconnect">Disconnect</button>';
  return `<button class="btn btn-line" data-action="connect"${r.state === 'connecting' ? ' disabled' : ''}>Connect</button>`;
}

function mapCard(t) {
  const p = t.lastSeen;
  if (!p || p.lat == null) {
    return `<section class="card"><p class="note">No location saved yet. Allow location for this site and the app will note where this phone was each time it sees ${esc(t.name)}.</p></section>`;
  }
  return `<section class="card map-card">
    <div class="map" id="map" role="img" aria-label="Map of where this phone was when it last saw ${esc(t.name)}"></div>
    <div class="map-foot"><span class="sub">Where this phone was ${esc(relTime(p.t))}</span>
    <a class="link" href="${directionsUrl(p)}" target="_blank" rel="noopener">${ui('route', 18)} Directions</a></div>
  </section>`;
}

function historyCard(t) {
  const h = t.history || [];
  if (!h.length) return '';
  const items = h.slice(0, 10).map((s) => `<li><span>${esc(clock(s.t))}</span><span class="sub">${s.lat != null ? `${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}` : 'no location'}</span></li>`).join('');
  return `<details class="card history"><summary>Recent sightings <span class="sub">(${h.length})</span></summary><ol>${items}</ol></details>`;
}

// ---------------------------------------------------------------- views
function homeView() {
  const tags = store.tags;
  if (!tags.length) return emptyView();
  const rows = tags.map((t) => {
    const st = statusOf(t);
    return `<li><a class="tag-row" href="#/tag/${encodeURIComponent(t.id)}" data-row="${esc(t.id)}">
      <span class="tag-ico">${icon(t.icon)}</span>
      <span class="tag-main"><span class="tag-name">${esc(t.name)}${t.kind === 'demo' ? ' <span class="badge">Demo</span>' : ''}</span>
      <span class="tag-sub"><span class="dot dot-${st.key}"></span><span data-bind="line">${esc(st.line)}</span></span></span>
      <span class="tag-batt" data-bind="batt">${batteryChip(t)}</span>
    </a></li>`;
  }).join('');
  return `<section class="home">
    <h1 class="page-title" tabindex="-1">Your tags</h1>
    <ul class="tag-list">${rows}</ul>
    <a class="btn btn-primary btn-block" href="#/add">${ui('plus')} Add a Styk</a>
    ${hasDemo() ? '' : '<button class="btn btn-quiet btn-block" data-action="demo">Try the demo tags</button>'}
  </section>`;
}

function emptyView() {
  return `<section class="empty">
    <picture>
      <source srcset="img/styk-tag-dark.webp" media="(prefers-color-scheme: dark)">
      <img src="img/styk-tag-light.webp" width="600" height="440" alt="A Styk tag: a thin square sticker with a solar window">
    </picture>
    <h1 class="page-title" tabindex="-1">Find your things with Styk</h1>
    <p class="lead">Add the Styk on your backpack, laptop or toolbox. Then play a sound to find it, and see where this phone last saw it.</p>
    <div class="stack">
      <a class="btn btn-primary btn-block" href="#/add">Add a Styk</a>
      <button class="btn btn-line btn-block" data-action="demo">Try the demo tags</button>
    </div>
    ${ble.supported() ? '' : '<p class="note">This browser can\'t use Bluetooth, so real tags won\'t connect here. The demo still works. For real tags, use Chrome on Android, or Chrome or Edge on a computer.</p>'}
  </section>`;
}

function tagView(id) {
  const t = store.tag(id);
  if (!t) {
    return `<section class="empty"><h1 class="page-title" tabindex="-1">Tag not found</h1><p class="lead">It may have been removed.</p><a class="btn btn-line" href="#/">Back to your tags</a></section>`;
  }
  const st = statusOf(t);
  const r = R(id);
  return `<section class="detail">
    <div class="detail-head">
      <span class="tag-ico big">${icon(t.icon, 28)}</span>
      <div class="detail-title">
        <h1 class="tag-title" tabindex="-1">${esc(t.name)}</h1>
        <p class="pill pill-${st.key}" data-bind="pill"><span class="dot dot-${st.key}"></span><span>${esc(st.label)}</span></p>
      </div>
      ${t.kind === 'demo' ? '<span class="badge">Demo</span>' : ''}
    </div>
    <div class="radar" data-bind="radar">${radar(t)}</div>
    <div class="actions" data-bind="actions">${soundButton(t)}${connectButton(t)}</div>
    <p class="msg${r.error ? ' error' : ''}" data-bind="msg" role="status">${esc(r.error || '')}</p>
    <dl class="rows">
      <div><dt>Last seen</dt><dd data-bind="seen">${esc(seenText(t))}</dd></div>
      <div><dt>Battery</dt><dd data-bind="battery">${esc(batteryText(t))}</dd></div>
      <div><dt>Solar</dt><dd data-bind="solar">${esc(solarWords(t))}</dd></div>
      <div><dt>Signal</dt><dd data-bind="signal">${esc(signalText(t))}</dd></div>
      <div><dt>Firmware</dt><dd data-bind="fw">${esc(t.fw || 'Unknown')}</dd></div>
      ${t.code ? `<div><dt>Tag code</dt><dd>${esc(t.code)}</dd></div>` : ''}
    </dl>
    <div data-bind="map">${mapCard(t)}</div>
    <section class="card">
      <label class="switch-row">
        <span><strong>Left-behind alert</strong><span class="sub">Warn me if this phone loses touch with ${esc(t.name)} while the app is open.</span></span>
        <input type="checkbox" role="switch" data-action="leftbehind" ${t.leftBehind ? 'checked' : ''}>
      </label>
    </section>
    <div data-bind="history">${historyCard(t)}</div>
    <div class="stack">
      <button class="btn btn-line btn-block" data-action="edit">Rename or change icon</button>
      <button class="btn btn-danger-text btn-block" data-action="remove">Remove this Styk</button>
    </div>
  </section>`;
}

function addView() {
  const s = addState;
  const bt = ble.supported();
  const choices = ICON_CHOICES.map(([k, label]) => `<label class="icon-choice"><input type="radio" name="icon" value="${k}"${s.icon === k ? ' checked' : ''}><span>${icon(k, 24)}<em>${label}</em></span></label>`).join('');
  const connect = bt
    ? `<p class="sub">Keep the Styk within a few feet of this device. When your phone asks for a PIN, enter <strong data-bind="pin-echo">${esc(s.pin || 'the PIN from the sticker')}</strong>.</p>
       <button type="submit" class="btn btn-primary btn-block" data-bind="submit"${s.busy ? ' disabled' : ''}>${esc(s.busy ? (s.step || 'Connecting') : 'Connect')}</button>`
    : `<p class="sub">This browser can't use Bluetooth. Open this page in Chrome on Android, or in Chrome or Edge on a computer. You can try the demo tags here.</p>
       <button type="button" class="btn btn-line btn-block" data-action="demo">Try the demo tags</button>`;
  return `<section class="add">
    <h1 class="page-title" tabindex="-1">Add a Styk</h1>
    <form id="add-form" novalidate>
      <fieldset class="card">
        <legend>1. Tag code and PIN</legend>
        <p class="sub">Both are printed with the QR code on the sticker. Scanning that QR code with your phone's camera fills them in. Using a development kit? Leave the code blank and pick it from the list; its PIN is 123456.</p>
        ${canScan() ? `<button type="button" class="btn btn-line" data-action="scan">${ui('camera')} Scan the QR code</button>` : ''}
        <div class="field-row">
          <label class="field"><span>Tag code</span><input name="tag" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="4" placeholder="7F3A" value="${esc(s.tag)}"></label>
          <label class="field"><span>PIN</span><input name="pin" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="482915" value="${esc(s.pin)}"></label>
        </div>
      </fieldset>
      <fieldset class="card">
        <legend>2. Name it</legend>
        <label class="field"><span>Name</span><input name="name" maxlength="32" placeholder="Backpack" value="${esc(s.name)}"></label>
        <div class="icon-grid" role="radiogroup" aria-label="Icon">${choices}</div>
      </fieldset>
      <fieldset class="card">
        <legend>3. Connect</legend>
        ${connect}
        <p class="msg error" role="alert" data-bind="add-error">${esc(s.error)}</p>
      </fieldset>
    </form>
  </section>`;
}

function settingsView() {
  const notif = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const notifCell = notif === 'granted' ? '<span class="state on">On</span>'
    : notif === 'denied' ? '<span class="state">Blocked in browser settings</span>'
      : notif === 'unsupported' ? '<span class="state">Not available here</span>'
        : '<button class="btn btn-line btn-small" data-action="notify">Turn on</button>';
  const yes = (ok) => `<dd class="${ok ? 'ok' : 'no'}">${ok ? 'Ready' : 'Not available'}</dd>`;
  return `<section class="settings">
    <h1 class="page-title" tabindex="-1">Settings</h1>
    <section class="card">
      <h2>Alerts and location</h2>
      <div class="set-row"><div><strong>Notifications</strong><span class="sub">For left-behind alerts while the app is open.</span></div>${notifCell}</div>
      <div class="set-row"><div><strong>Location</strong><span class="sub">Saved with each sighting so you can see where this phone last saw a tag.</span></div><span data-bind="geo" class="state">Checking</span></div>
    </section>
    <section class="card">
      <h2>Demo tags</h2>
      <p class="sub">Two pretend tags that behave like real ones, so you can try the app without hardware.</p>
      ${hasDemo() ? '<button class="btn btn-line btn-small" data-action="undemo">Remove demo tags</button>' : '<button class="btn btn-line btn-small" data-action="demo">Add demo tags</button>'}
    </section>
    <section class="card">
      <h2>Your data</h2>
      <p class="sub">Your tags and their sightings are stored only in this browser. Nothing is sent to Styk.${store.memoryOnly ? ' This browser is blocking storage, so nothing will be kept after you close the page.' : ''}</p>
      <div class="button-row">
        <button class="btn btn-line btn-small" data-action="export">Download a copy</button>
        <button class="btn btn-danger-text btn-small" data-action="wipe">Delete everything</button>
      </div>
    </section>
    <section class="card">
      <h2>This browser</h2>
      <dl class="rows compact">
        <div><dt>Bluetooth</dt>${yes(ble.supported())}</div>
        <div><dt>Scan QR codes in the app</dt>${yes(canScan())}</div>
        <div><dt>Reconnect without the picker</dt>${yes(ble.canReconnectQuietly())}</div>
      </dl>
      <p class="note">Real tags work in Chrome on Android, and in Chrome or Edge on a computer. iPhone browsers don't support Web Bluetooth yet; the iPhone app is on the roadmap.</p>
    </section>
    ${installPrompt ? '<button class="btn btn-line btn-block" data-action="install">Install the Styk app</button>' : '<p class="note">To install, open your browser menu and choose Install app or Add to Home screen.</p>'}
    <p class="note">Styk app ${VERSION}, prototype. <a class="link" href="https://thestyk.com">thestyk.com</a></p>
  </section>`;
}

// ---------------------------------------------------------------- render
function renderBar(r) {
  barLeft.innerHTML = r.name === 'home'
    ? '<a class="wordmark" href="#/" aria-label="Styk, your tags">Styk</a>'
    : `<a class="back" href="#/">${ui('back', 20)}<span>Your tags</span></a>`;
  barRight.innerHTML = r.name === 'settings'
    ? ''
    : `<a class="icon-btn" href="#/settings" aria-label="Settings">${ui('gear', 22)}</a>`;
}

function render() {
  const r = route();
  shown = r;
  renderBar(r);
  if (currentMap) { currentMap.remove(); currentMap = null; }
  mapKey = '';
  if (r.name === 'tag') {
    view.innerHTML = tagView(r.id);
    const t = store.tag(r.id);
    document.title = t ? `${t.name} - Styk` : 'Styk';
    drawMapFor(t);
  } else if (r.name === 'add') {
    view.innerHTML = addView();
    document.title = 'Add a Styk - Styk';
  } else if (r.name === 'settings') {
    view.innerHTML = settingsView();
    document.title = 'Settings - Styk';
    geoPermission().then((s) => {
      const el = view.querySelector('[data-bind="geo"]');
      if (!el) return;
      if (s === 'granted') { el.textContent = 'Allowed'; el.classList.add('on'); }
      else if (s === 'denied') el.textContent = 'Blocked in browser settings';
      else el.outerHTML = '<button class="btn btn-line btn-small" data-action="geo">Allow</button>';
    });
  } else {
    view.innerHTML = homeView();
    document.title = 'Styk';
  }
  // After the first screen, move focus to the new heading so screen readers announce the change.
  const h1 = view.querySelector('h1');
  if (h1 && rendered) h1.focus({ preventScroll: true });
  rendered = true;
  window.scrollTo(0, 0);
}
let rendered = false;
let shown = { name: 'none' }; // the screen currently drawn, which can lag the address briefly

function drawMapFor(t) {
  const el = view.querySelector('#map');
  if (!t || !el || !t.lastSeen || t.lastSeen.lat == null) return;
  mapKey = `${t.id}:${t.lastSeen.t}`;
  drawMap(el, t.lastSeen).then((m) => { currentMap = m; });
}

// Update one tag's parts of the screen in place, without rebuilding the page.
function refresh(id) {
  const r = shown;
  const t = store.tag(id);
  if (!t) return;
  if (r.name === 'home') {
    const row = view.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (!row) return;
    const st = statusOf(t);
    row.querySelector('[data-bind="line"]').textContent = st.line;
    row.querySelector('.dot').className = `dot dot-${st.key}`;
    row.querySelector('[data-bind="batt"]').innerHTML = batteryChip(t);
    return;
  }
  if (r.name !== 'tag' || r.id !== id || !view.querySelector('.detail')) return;
  const st = statusOf(t);
  const rt = R(id);
  const set = (key, text) => { const el = view.querySelector(`[data-bind="${key}"]`); if (el) el.textContent = text; };
  const pill = view.querySelector('[data-bind="pill"]');
  if (pill) { pill.className = `pill pill-${st.key}`; pill.innerHTML = `<span class="dot dot-${st.key}"></span><span>${esc(st.label)}</span>`; }
  view.querySelector('[data-bind="radar"]').innerHTML = radar(t);
  view.querySelector('[data-bind="actions"]').innerHTML = soundButton(t) + connectButton(t);
  const msg = view.querySelector('[data-bind="msg"]');
  msg.textContent = rt.error || '';
  msg.classList.toggle('error', !!rt.error);
  set('seen', seenText(t));
  set('battery', batteryText(t));
  set('solar', solarWords(t));
  set('signal', signalText(t));
  set('fw', t.fw || 'Unknown');
  const key = t.lastSeen && t.lastSeen.lat != null ? `${t.id}:${t.lastSeen.t}` : '';
  if (key !== mapKey) {
    if (currentMap) { currentMap.remove(); currentMap = null; }
    view.querySelector('[data-bind="map"]').innerHTML = mapCard(t);
    view.querySelector('[data-bind="history"]').innerHTML = historyCard(t);
    drawMapFor(t);
  }
}

// ---------------------------------------------------------------- tag links
function attach(id, link) {
  const r = R(id);
  r.link = link;
  link.addEventListener('status', (e) => applyStatus(id, e.detail));
  link.addEventListener('rssi', (e) => { r.rssi = e.detail; r.rssiAt = Date.now(); refresh(id); });
  link.addEventListener('sound', (e) => { r.sound = !!e.detail; refresh(id); });
  link.addEventListener('disconnect', (e) => onDisconnect(id, e.detail?.expected));
}

function applyStatus(id, s) {
  if (!s || !store.tag(id)) return;
  const r = R(id);
  store.update(id, { battery: { pct: s.pct, mv: s.mv, t: Date.now() }, charging: s.charging, fw: s.fw });
  if (store.tag(id).kind !== 'demo') {
    r.sound = s.sound;
    if (!s.sound) clearTimeout(r.soundTimer);
  }
  if (r.state === 'connected') recordSighting(id, 'connected');
  refresh(id);
}

function onDisconnect(id, expected) {
  const t = store.tag(id);
  const r = R(id);
  const wasConnected = r.state === 'connected';
  r.state = 'idle';
  r.sound = false;
  r.rssi = null;
  if (!t) return;
  if (wasConnected && !expected) {
    r.error = `Lost touch with ${t.name}.`;
    recordSighting(id, 'lost', { force: true });
    if (t.leftBehind) leftBehindAlert(t);
  }
  refresh(id);
}

function leftBehindAlert(t) {
  const text = `Lost touch with ${t.name} at ${clock(Date.now())}. Its last place is saved in the app.`;
  toast(text);
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const opts = { body: text, tag: `left-${t.id}`, icon: 'icons/icon-192.png', data: { url: `#/tag/${t.id}` } };
    navigator.serviceWorker?.ready
      .then((reg) => reg.showNotification(`${t.name} may be left behind`, opts))
      .catch(() => { try { new Notification(`${t.name} may be left behind`, opts); } catch { /* ignore */ } });
  }
}

async function connectTag(id, thenSound = false) {
  const t = store.tag(id);
  const r = R(id);
  if (!t || r.state === 'connecting') return;
  r.error = '';
  r.state = 'connecting';
  r.step = 'Connecting';
  refresh(id);
  try {
    if (!r.link) {
      if (t.kind === 'demo') {
        attach(id, new DemoLink(t));
      } else {
        if (!ble.supported()) throw styk("This browser can't use Bluetooth. Use Chrome on Android, or Chrome or Edge on a computer.");
        if (!(await ble.radioOn())) throw styk('Bluetooth is off on this device. Turn it on and try again.');
        const known = ble.canReconnectQuietly() ? (await ble.knownDevices()).find((d) => d.id === t.deviceId) : null;
        const device = known || await ble.chooseTag(t.code);
        attach(id, new ble.TagLink(device));
      }
    }
    const res = await r.link.open(t.kind === 'demo' ? null : t.code, (step) => { r.step = step; refresh(id); });
    if (t.kind !== 'demo' && r.link.device) store.update(id, { deviceId: r.link.device.id });
    r.state = 'connected';
    r.step = '';
    applyStatus(id, res.status);
    recordSighting(id, 'connected', { force: true });
    if (thenSound) await setSound(id, true);
  } catch (e) {
    r.state = 'idle';
    r.step = '';
    r.error = ble.explain(e, t.code);
    // A real tag that could not be reached (or the wrong tag was picked) is chosen afresh next time.
    if (t.kind !== 'demo' && !r.link?.connected) r.link = null;
  }
  refresh(id);
}

async function setSound(id, on) {
  const t = store.tag(id);
  const r = R(id);
  if (!t) return;
  if (r.state !== 'connected') {
    if (on) return connectTag(id, true);
    return;
  }
  try {
    await r.link.sound(on);
    r.sound = on;
    r.error = '';
    clearTimeout(r.soundTimer);
    if (on) {
      toast(`Playing sound on ${t.name}`);
      // Real tags report when the sound ends; this is a fallback if that report is missed.
      r.soundTimer = setTimeout(() => { r.sound = false; refresh(id); }, 12000);
    }
  } catch (e) {
    r.error = ble.explain(e, t.code);
  }
  refresh(id);
}

// ---------------------------------------------------------------- dialogs
function ask({ title, body, confirm, alt, danger }) {
  return new Promise((resolve) => {
    dialogEl.innerHTML = `<form method="dialog" class="dialog-body">
      <h2>${esc(title)}</h2><p>${esc(body)}</p>
      <div class="dialog-actions">
        <button value="cancel" class="btn btn-quiet">Cancel</button>
        ${alt ? `<button value="alt" class="btn btn-line">${esc(alt)}</button>` : ''}
        <button value="confirm" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(confirm)}</button>
      </div></form>`;
    dialogEl.onclose = () => resolve(dialogEl.returnValue || 'cancel');
    dialogEl.showModal();
  });
}

function editDialog(id) {
  const t = store.tag(id);
  const choices = ICON_CHOICES.map(([k, label]) => `<label class="icon-choice"><input type="radio" name="icon" value="${k}"${t.icon === k ? ' checked' : ''}><span>${icon(k, 24)}<em>${label}</em></span></label>`).join('');
  dialogEl.innerHTML = `<form method="dialog" class="dialog-body" id="edit-form">
    <h2>Rename or change icon</h2>
    <label class="field"><span>Name</span><input name="name" maxlength="32" value="${esc(t.name)}" required></label>
    <div class="icon-grid" role="radiogroup" aria-label="Icon">${choices}</div>
    <div class="dialog-actions"><button value="cancel" class="btn btn-quiet">Cancel</button><button value="save" class="btn btn-primary">Save</button></div>
  </form>`;
  dialogEl.onclose = () => {
    if (dialogEl.returnValue !== 'save') return;
    const f = new FormData(dialogEl.querySelector('form'));
    const name = String(f.get('name') || '').trim() || t.name;
    store.update(id, { name, icon: String(f.get('icon') || t.icon) });
    toast('Saved');
    render();
  };
  dialogEl.showModal();
}

async function scanDialog() {
  const ctrl = new AbortController();
  dialogEl.innerHTML = `<form method="dialog" class="dialog-body">
    <h2>Scan the QR code</h2><p class="sub">Point the camera at the code on the sticker.</p>
    <video class="scanner" playsinline muted></video>
    <div class="dialog-actions"><button value="cancel" class="btn btn-quiet">Cancel</button></div></form>`;
  dialogEl.onclose = () => ctrl.abort();
  dialogEl.showModal();
  try {
    const text = await scan(dialogEl.querySelector('video'), ctrl.signal);
    if (dialogEl.open) dialogEl.close();
    const p = parsePairing(text);
    if (p) {
      addState = { ...addState, tag: p.tag, pin: p.pin || addState.pin, error: '' };
      render();
      toast(`Found tag ${p.tag}`);
    } else if (text) {
      addState.error = "That QR code isn't a Styk code. Type the code and PIN instead.";
      render();
    }
  } catch {
    if (dialogEl.open) dialogEl.close();
    addState.error = "The camera couldn't start. Type the code and PIN instead.";
    render();
  }
}

// ---------------------------------------------------------------- actions
async function addDemo() {
  const where = await getLocation({ ask: false });
  demoTags(where).forEach((t) => store.add({ id: newId(), ...t }));
  toast('Two demo tags added');
  go('#/');
}

async function submitAdd(form) {
  const f = new FormData(form);
  const tag = String(f.get('tag') || '').trim().toUpperCase();
  const pin = String(f.get('pin') || '').trim();
  const name = String(f.get('name') || '').trim() || 'My Styk';
  const ic = String(f.get('icon') || 'tag');
  addState = { ...addState, tag, pin, name: String(f.get('name') || ''), icon: ic, error: '' };
  // Both are optional: without a code the picker lists every Styk nearby; the PIN is typed into the phone's own prompt.
  if (tag && !/^[0-9A-F]{4}$/.test(tag)) return showAddError('The tag code is 4 letters or numbers, like 7F3A.');
  if (pin && !/^\d{6}$/.test(pin)) return showAddError('The PIN is 6 digits, like 482915.');
  const existing = tag && store.tags.find((t) => t.code === tag && t.kind === 'ble');
  if (existing) { toast(`${existing.name} is already in your tags`); return go(`#/tag/${existing.id}`); }

  setAddBusy(true, 'Opening the Bluetooth picker');
  let link = null;
  try {
    if (!(await ble.radioOn())) throw styk('Bluetooth is off on this device. Turn it on and try again.');
    const device = await ble.chooseTag(tag || null);
    link = new ble.TagLink(device);
    const res = await link.open(tag || null, (step) => setAddBusy(true, step === 'Pairing' ? (pin ? `Pairing: enter PIN ${pin} if asked` : 'Pairing: enter the PIN if asked') : step));
    const dup = store.tags.find((t) => t.kind === 'ble' && t.code === res.code);
    if (dup) {
      store.update(dup.id, { deviceId: device.id });
      attach(dup.id, link);
      R(dup.id).state = 'connected';
      applyStatus(dup.id, res.status);
      addState = { tag: '', pin: '', name: '', icon: 'backpack', busy: false, step: '', error: '' };
      toast(`${dup.name} is connected`);
      return go(`#/tag/${dup.id}`);
    }
    const id = newId();
    store.add({ id, kind: 'ble', name, icon: ic, code: res.code, deviceId: device.id, fw: res.status?.fw || null });
    attach(id, link);
    R(id).state = 'connected';
    applyStatus(id, res.status);
    recordSighting(id, 'connected', { force: true });
    addState = { tag: '', pin: '', name: '', icon: 'backpack', busy: false, step: '', error: '' };
    toast(`${name} added`);
    go(`#/tag/${id}`);
  } catch (e) {
    if (link?.connected) link.close();
    setAddBusy(false);
    showAddError(ble.explain(e, tag));
  }
}

function setAddBusy(busy, step = '') {
  addState.busy = busy;
  addState.step = step;
  const b = view.querySelector('[data-bind="submit"]');
  if (b) { b.disabled = busy; b.textContent = busy ? step : 'Connect'; }
}

function showAddError(text) {
  addState.error = text;
  const el = view.querySelector('[data-bind="add-error"]');
  if (el) el.textContent = text;
}

async function removeTag(id) {
  const t = store.tag(id);
  const r = R(id);
  if (!t) return;
  const connected = r.state === 'connected';
  let choice;
  if (t.kind === 'demo') {
    choice = await ask({ title: `Remove ${t.name}?`, body: 'This demo tag will be removed from this phone.', confirm: 'Remove', danger: true });
  } else if (connected) {
    choice = await ask({ title: `Remove ${t.name}?`, body: `${t.name} will forget this phone, so it can be added to another one.`, confirm: 'Remove', danger: true });
  } else {
    choice = await ask({
      title: `Remove ${t.name}?`,
      body: `${t.name} isn't connected, so it will still be paired to this phone. Connect and release it first, or remove it from this list only.`,
      confirm: 'Remove from list', alt: 'Connect and release', danger: true,
    });
  }
  if (choice === 'alt') {
    await connectTag(id);
    if (R(id).state === 'connected') return removeTag(id);
    return;
  }
  if (choice !== 'confirm') return;
  if (r.link) {
    r.link.userClosed = true;
    if (connected && t.kind === 'ble') { try { await r.link.release(); } catch { /* the tag may already be gone */ } }
    r.link.close();
  }
  runtime.delete(id);
  store.remove(id);
  toast(`${t.name} removed`);
  go('#/');
}

view.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const r = route();
  const id = r.id;
  switch (el.dataset.action) {
    case 'demo': return addDemo();
    case 'undemo':
      store.tags.filter((t) => t.kind === 'demo').forEach((t) => { R(t.id).link?.close(); runtime.delete(t.id); store.remove(t.id); });
      toast('Demo tags removed');
      return render();
    case 'sound': return setSound(id, el.dataset.on === '1');
    case 'connect': return connectTag(id);
    case 'disconnect': { const rt = R(id); rt.link?.close(); rt.state = 'idle'; return refresh(id); }
    case 'edit': return editDialog(id);
    case 'remove': return removeTag(id);
    case 'scan': return scanDialog();
    case 'notify':
      if (typeof Notification !== 'undefined') {
        const p = await Notification.requestPermission();
        store.setting('notifications', p === 'granted');
      }
      return render();
    case 'geo': await getLocation(); return render();
    case 'export': {
      const blob = new Blob([store.exportJson()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `styk-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return toast('Download started');
    }
    case 'wipe': {
      const c = await ask({ title: 'Delete everything?', body: 'This removes every tag and sighting from this browser. Real tags stay paired until you reset them.', confirm: 'Delete everything', danger: true });
      if (c !== 'confirm') return;
      runtime.forEach((x) => x.link?.close());
      runtime.clear();
      store.wipe();
      toast('Everything deleted');
      return go('#/');
    }
    case 'install':
      if (installPrompt) { installPrompt.prompt(); installPrompt = null; render(); }
      return;
    default:
  }
});

view.addEventListener('change', (e) => {
  if (e.target.matches('[data-action="leftbehind"]')) {
    store.update(route().id, { leftBehind: e.target.checked });
    toast(e.target.checked ? 'Left-behind alert on' : 'Left-behind alert off');
  }
});

view.addEventListener('input', (e) => {
  const form = e.target.closest('#add-form');
  if (!form) return;
  const { name, value } = e.target;
  if (name === 'tag') { e.target.value = value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 4); addState.tag = e.target.value; }
  if (name === 'pin') {
    e.target.value = value.replace(/\D/g, '').slice(0, 6);
    addState.pin = e.target.value;
    const echo = view.querySelector('[data-bind="pin-echo"]');
    if (echo) echo.textContent = addState.pin || 'the PIN from the sticker';
  }
  if (name === 'name') addState.name = value;
  if (name === 'icon') addState.icon = value;
});

view.addEventListener('submit', (e) => {
  if (e.target.id === 'add-form') {
    e.preventDefault();
    if (!addState.busy) submitAdd(e.target);
  }
});

window.addEventListener('hashchange', render);
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (route().name === 'settings') render();
});

// Keep "2 min ago" and similar words fresh.
setInterval(() => store.tags.forEach((t) => refresh(t.id)), 30000);

// Where the browser allows it, notice approved tags nearby without opening a connection.
async function watchKnownTags() {
  if (!ble.canReconnectQuietly()) return;
  const devices = await ble.knownDevices();
  for (const t of store.tags.filter((x) => x.kind === 'ble' && x.deviceId)) {
    const device = devices.find((d) => d.id === t.deviceId);
    if (!device) continue;
    const link = new ble.TagLink(device);
    attach(t.id, link);
    link.watch(({ rssi, advert }) => {
      const r = R(t.id);
      r.rssi = rssi;
      r.rssiAt = Date.now();
      if (advert) store.update(t.id, { battery: { pct: advert.pct, t: Date.now() }, charging: advert.charging });
      recordSighting(t.id, 'nearby');
      refresh(t.id);
    });
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}

render();
watchKnownTags();
