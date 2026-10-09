// Demo tags: simulated Styks so the app can be tried without hardware.
// They behave like the real link in ble.js (open, sound, refresh, close) but nothing leaves the phone.

import { playFindPattern, stopSound } from './sound.js';

const DEFAULT_CENTER = { lat: 41.8827, lng: -87.6233 }; // used only when location is not shared

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function jitter(p, metres) {
  const dLat = (Math.random() - 0.5) * 2 * metres / 111320;
  const dLng = (Math.random() - 0.5) * 2 * metres / (111320 * Math.cos(p.lat * Math.PI / 180));
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}

function offset(p, northM, eastM) {
  return {
    lat: p.lat + northM / 111320,
    lng: p.lng + eastM / (111320 * Math.cos(p.lat * Math.PI / 180)),
  };
}

export function demoTags(center) {
  const here = center || DEFAULT_CENTER;
  const now = Date.now();
  const away = offset(here, 620, 840); // somewhere about a kilometre away
  const history = (p, ages, how) => ages.map((h) => ({ t: now - h * 3600e3, ...jitter(p, 25), acc: 20, how }));
  return [
    {
      kind: 'demo', demoRole: 'near', name: 'Backpack', icon: 'backpack', code: 'D3M0',
      battery: { pct: 88, mv: 3950, t: now }, charging: true, fw: '0.2.0',
      lastSeen: { t: now - 60e3, ...jitter(here, 8), acc: 12, how: 'connected' },
      history: history(here, [0.02, 3, 9, 26], 'connected'),
    },
    {
      kind: 'demo', demoRole: 'away', name: 'Laptop', icon: 'laptop', code: 'D3M1',
      battery: { pct: 64, mv: 3780, t: now - 3 * 3600e3 }, charging: false, fw: '0.2.0',
      lastSeen: { t: now - 3 * 3600e3, ...jitter(away, 10), acc: 18, how: 'connected' },
      history: history(away, [3, 7, 30], 'connected'),
    },
  ];
}

export class DemoLink extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.connected = false;
    this.status = null;
    this.userClosed = false;
    this._timer = null;
  }

  async open(_code, onStep = () => {}) {
    onStep('Connecting');
    await wait(500);
    if (this.tag.demoRole === 'away') {
      await wait(1200);
      const e = new Error('The Laptop is out of range. It was last seen about 3 hours ago; check the map.');
      e.styk = true;
      throw e;
    }
    onStep('Reading status');
    await wait(300);
    this.connected = true;
    this.status = this._makeStatus();
    this._timer = setInterval(() => {
      this.status = this._makeStatus();
      this.dispatchEvent(new CustomEvent('status', { detail: this.status }));
      this.dispatchEvent(new CustomEvent('rssi', { detail: -52 - Math.round(Math.random() * 14) }));
    }, 4000);
    return { code: this.tag.code, status: this.status };
  }

  _makeStatus() {
    const prev = this.status?.pct ?? this.tag.battery?.pct ?? 88;
    const hour = new Date().getHours();
    const charging = hour >= 7 && hour < 20;
    const pct = Math.max(5, Math.min(100, prev + (charging ? (Math.random() < 0.3 ? 1 : 0) : (Math.random() < 0.2 ? -1 : 0))));
    return { version: 1, pct, mv: 3000 + pct * 12, pvMv: charging ? 2900 : 0, flags: 0, charging, lowBattery: pct < 15, separated: false, sound: this._sound || false, fw: '0.2.0' };
  }

  async sound(on) {
    if (!this.connected) throw Object.assign(new Error('Connect to the tag first.'), { styk: true });
    if (on) {
      this._sound = true;
      playFindPattern(() => {
        this._sound = false;
        this.dispatchEvent(new CustomEvent('sound', { detail: false }));
      });
    } else {
      stopSound();
    }
  }

  async refresh() { return this.status; }

  async release() { /* nothing to release on a demo tag */ }

  close() {
    this.userClosed = true;
    this.connected = false;
    clearInterval(this._timer);
    stopSound();
    this.dispatchEvent(new CustomEvent('disconnect', { detail: { expected: true } }));
  }
}
