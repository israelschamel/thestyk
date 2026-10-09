// Web Bluetooth link to a real Styk tag. Protocol: ../PROTOCOL.md

const base = (n) => `5a7e000${n}-6b1d-4c3a-9f2e-0a1b2c3d4e5f`;
export const UUID = {
  service: base(1),
  alert: base(2),
  control: base(3),
  status: base(4),
  info: base(5),
};
export const COMPANY_ID = 0xffff;

const ALERT = { stop: 0x00, find: 0x01, chirp: 0x02 };
const CMD = { release: 0x10, setTime: 0x30 };

export const FLAGS = { charging: 1, lowBattery: 2, separated: 4, sound: 8, timeSet: 16, owned: 32 };

export function supported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth?.requestDevice;
}

export function canReconnectQuietly() {
  return supported() && typeof navigator.bluetooth.getDevices === 'function';
}

export async function radioOn() {
  if (!supported()) return false;
  try {
    return navigator.bluetooth.getAvailability ? await navigator.bluetooth.getAvailability() : true;
  } catch {
    return true;
  }
}

export function parseStatus(dv) {
  if (!dv || dv.byteLength < 10) return null;
  const flags = dv.getUint8(6);
  return {
    version: dv.getUint8(0),
    pct: dv.getUint8(1),
    mv: dv.getUint16(2, true),
    pvMv: dv.getUint16(4, true),
    flags,
    charging: !!(flags & FLAGS.charging),
    lowBattery: !!(flags & FLAGS.lowBattery),
    separated: !!(flags & FLAGS.separated),
    sound: !!(flags & FLAGS.sound),
    fw: `${dv.getUint8(7)}.${dv.getUint8(8)}.${dv.getUint8(9)}`,
  };
}

// Advertising payload (manufacturer data after the company ID).
export function parseAdvert(dv) {
  if (!dv || dv.byteLength < 9 || dv.getUint8(0) !== 1) return null;
  const flags = dv.getUint8(8);
  return { pct: dv.getUint8(7), charging: !!(flags & FLAGS.charging), separated: !!(flags & FLAGS.separated) };
}

// Plain-language messages for the errors Web Bluetooth throws.
export function explain(err, code) {
  const name = err?.name || '';
  const msg = String(err?.message || '');
  if (err?.styk) return err.message;
  if (name === 'NotFoundError') {
    return /cancel/i.test(msg)
      ? 'No Styk was chosen. Keep it close to this phone and try again.'
      : 'No Styk showed up. Check that it is powered and within a few feet, then try again.';
  }
  if (name === 'SecurityError' || /not authorized|authenticat|insufficient/i.test(msg)) {
    return code
      ? `Pairing didn't finish. Try again and enter PIN for ${code} when your phone asks.`
      : "Pairing didn't finish. Try again and enter the PIN when your phone asks.";
  }
  if (name === 'NotSupportedError') return "This browser can't talk to Bluetooth devices. Use Chrome on Android, or Chrome or Edge on a computer.";
  if (name === 'NetworkError' || /disconnect|connection/i.test(msg)) return 'The connection dropped. Move closer to the Styk and try again.';
  if (name === 'NotAllowedError') return 'Bluetooth permission was blocked. Allow it in your browser settings and try again.';
  return `Something went wrong talking to the Styk (${name || 'error'}). Try again.`;
}

function fail(message) {
  const e = new Error(message);
  e.styk = true;
  return e;
}

// Ask the browser to show nearby Styk tags. Must be called from a tap.
export async function chooseTag(code) {
  const filters = code
    ? [{ namePrefix: `Styk-${code}` }, { services: [UUID.service] }]
    : [{ services: [UUID.service] }];
  return navigator.bluetooth.requestDevice({
    filters,
    optionalServices: [UUID.service, 'battery_service', 'device_information'],
  });
}

// Previously approved devices, when the browser supports it.
export async function knownDevices() {
  if (!canReconnectQuietly()) return [];
  try { return await navigator.bluetooth.getDevices(); } catch { return []; }
}

// One open link to a tag. GATT calls are queued because browsers reject overlapping ones.
export class TagLink extends EventTarget {
  constructor(device) {
    super();
    this.device = device;
    this.chars = null;
    this.code = null;
    this.status = null;
    this.userClosed = false;
    this._queue = Promise.resolve();
    this._listening = false;
    this._onDisconnect = () => this.dispatchEvent(new CustomEvent('disconnect', { detail: { expected: this.userClosed } }));
    this._onStatus = (e) => {
      const s = parseStatus(e.target.value);
      if (s) { this.status = s; this.dispatchEvent(new CustomEvent('status', { detail: s })); }
    };
    device.addEventListener('gattserverdisconnected', this._onDisconnect);
  }

  _run(fn) {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => {});
    return next;
  }

  get connected() { return !!this.device?.gatt?.connected; }

  async open(expectedCode, onStep = () => {}) {
    this.userClosed = false;
    onStep('Connecting');
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(UUID.service);
    const [alert, control, status, info] = await Promise.all([
      svc.getCharacteristic(UUID.alert),
      svc.getCharacteristic(UUID.control),
      svc.getCharacteristic(UUID.status),
      svc.getCharacteristic(UUID.info),
    ]);
    this.chars = { alert, control, status, info };

    // Reading Info needs PIN pairing, so the phone asks for the PIN here the first time.
    onStep('Pairing');
    const code = new TextDecoder().decode(await this._run(() => info.readValue())).trim().toUpperCase();
    this.code = code;
    if (expectedCode && code !== expectedCode.toUpperCase()) {
      this.close();
      throw fail(`That was a different Styk (code ${code}). Try again and choose Styk-${expectedCode.toUpperCase()}.`);
    }

    onStep('Reading status');
    this.status = parseStatus(await this._run(() => status.readValue()));
    try {
      if (!this._listening) {
        status.addEventListener('characteristicvaluechanged', this._onStatus);
        this._listening = status;
      } else if (this._listening !== status) {
        this._listening.removeEventListener('characteristicvaluechanged', this._onStatus);
        status.addEventListener('characteristicvaluechanged', this._onStatus);
        this._listening = status;
      }
      await this._run(() => status.startNotifications());
    } catch { /* notifications are optional */ }
    await this.setClock();
    return { code, status: this.status };
  }

  setClock() {
    const buf = new Uint8Array(5);
    buf[0] = CMD.setTime;
    new DataView(buf.buffer).setUint32(1, Math.floor(Date.now() / 1000), true);
    return this._run(() => this.chars.control.writeValueWithResponse(buf)).catch(() => {});
  }

  sound(on) {
    return this._run(() => this.chars.alert.writeValueWithResponse(Uint8Array.of(on ? ALERT.find : ALERT.stop)));
  }

  async refresh() {
    const s = parseStatus(await this._run(() => this.chars.status.readValue()));
    if (s) this.status = s;
    return s;
  }

  async release() {
    await this._run(() => this.chars.control.writeValueWithResponse(Uint8Array.of(CMD.release)));
  }

  close() {
    this.userClosed = true;
    try { this.device.gatt.disconnect(); } catch { /* already closed */ }
  }

  // Watch advertisements to know the tag is near without connecting (Chrome, when enabled).
  async watch(onSeen) {
    if (typeof this.device.watchAdvertisements !== 'function') return false;
    this.device.addEventListener('advertisementreceived', (e) => {
      const dv = e.manufacturerData?.get?.(COMPANY_ID);
      onSeen({ rssi: e.rssi, advert: parseAdvert(dv) });
    });
    try { await this.device.watchAdvertisements(); return true; } catch { return false; }
  }
}
