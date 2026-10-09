"""End-to-end checks for the Styk web app.

Runs the app in headless Chromium with a simulated Styk tag standing in for real hardware.
The simulated tag records every Bluetooth read and write, so the test can check that the app
sends exactly the bytes the firmware expects (see ../PROTOCOL.md).

Usage:  python3 tests/test_app.py            (needs: pip install playwright; playwright install chromium)
Screenshots are written to tests/screenshots/.
"""
import functools
import http.server
import os
import sys
import threading

from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(ROOT, '..', 'app')
SHOTS = os.path.join(ROOT, 'screenshots')
PORT = 8765
BASE = f'http://localhost:{PORT}/'

FAKE_TAG = r"""
(() => {
  const log = []; window.__bleLog = log;
  const enc = (s) => new TextEncoder().encode(s);
  const statusBytes = () => {
    const b = new Uint8Array(10);
    b[0] = 1; b[1] = 87;
    new DataView(b.buffer).setUint16(2, 2870, true);
    b[6] = 0x20 | 0x01;            // owned + charging
    b[7] = 0; b[8] = 2; b[9] = 0;  // firmware 0.2.0
    return new DataView(b.buffer);
  };
  const device = new EventTarget();
  device.id = 'dev-1'; device.name = 'Styk-7F3A';
  const server = { connected: false };
  class Char extends EventTarget {
    constructor(uuid) { super(); this.uuid = uuid; }
    async readValue() {
      log.push(['read', this.uuid.slice(0, 8)]);
      if (this.uuid.startsWith('5a7e0005')) return new DataView(enc(window.__tagCode || '7F3A').buffer);
      if (this.uuid.startsWith('5a7e0004')) return statusBytes();
      return new DataView(new ArrayBuffer(1));
    }
    async writeValueWithResponse(v) {
      const bytes = Array.from(v instanceof Uint8Array ? v : new Uint8Array(v));
      log.push(['write', this.uuid.slice(0, 8), bytes]);
      if (this.uuid.startsWith('5a7e0003') && bytes[0] === 0x10) setTimeout(() => device.gatt.disconnect(), 50);
    }
    async startNotifications() { log.push(['notify', this.uuid.slice(0, 8)]); return this; }
  }
  const chars = {};
  const svc = { getCharacteristic: async (u) => (chars[u] = chars[u] || new Char(u)) };
  server.getPrimaryService = async (u) => { log.push(['service', u.slice(0, 8)]); return svc; };
  device.gatt = {
    get connected() { return server.connected; },
    connect: async () => { server.connected = true; log.push(['connect']); return server; },
    disconnect: () => {
      if (!server.connected) return;
      server.connected = false; log.push(['disconnect']);
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
  window.__device = device;
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: {
      requestDevice: async (opts) => { log.push(['requestDevice', JSON.stringify(opts.filters)]); return device; },
      getAvailability: async () => true,
    },
  });
})();
"""

NO_BLUETOOTH = "Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: undefined });"


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=APP)
    httpd = http.server.ThreadingHTTPServer(('localhost', PORT), handler)
    httpd.handle_error = lambda *a: None  # the browser closing a connection early is not a failure
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def new_page(browser, scheme='light', init=None, size=(390, 844)):
    ctx = browser.new_context(viewport={'width': size[0], 'height': size[1]}, color_scheme=scheme,
                              geolocation={'latitude': 41.8827, 'longitude': -87.6233},
                              permissions=['geolocation'], device_scale_factor=2)
    ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
    ctx.route('**/fonts.gstatic.com/**', lambda r: r.abort())
    ctx.route('**/tile.openstreetmap.org/**', lambda r: r.abort())
    if init:
        ctx.add_init_script(init)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and errors.append(f'console: {m.text}'))
    return ctx, page, errors


def log(page):
    return page.evaluate('window.__bleLog || []')


def shot(page, name):
    width = page.evaluate('document.documentElement.clientWidth')
    scroll = page.evaluate('document.documentElement.scrollWidth')
    assert scroll <= width, f'{name}: page scrolls sideways ({scroll}px wide in a {width}px window)'
    os.makedirs(SHOTS, exist_ok=True)
    page.screenshot(path=os.path.join(SHOTS, f'{name}.png'), full_page=True)


def test_demo(browser):
    ctx, page, errors = new_page(browser)
    page.goto(BASE)
    expect(page.get_by_role('heading', name='Find your things with Styk')).to_be_visible()
    shot(page, '01-empty')
    page.get_by_role('button', name='Try the demo tags').click()
    expect(page.locator('.tag-row')).to_have_count(2)
    expect(page.locator('.tag-row', has_text='Backpack')).to_contain_text('Nearby')
    expect(page.locator('.tag-row', has_text='Laptop')).to_contain_text('Out of range')
    shot(page, '02-home')

    page.locator('.tag-row', has_text='Backpack').click()
    expect(page.get_by_role('heading', name='Backpack')).to_be_visible()
    expect(page.locator('#map[data-state="ready"]')).to_have_count(1, timeout=8000)
    page.get_by_role('button', name='Play sound').click()
    expect(page.get_by_role('button', name='Stop sound')).to_be_visible(timeout=5000)
    expect(page.locator('[data-bind="pill"]')).to_have_text('Connected')
    shot(page, '03-detail-playing')
    page.get_by_role('button', name='Stop sound').click()
    expect(page.get_by_role('button', name='Play sound')).to_be_visible()

    page.get_by_role('button', name='Rename or change icon').click()
    page.locator('dialog input[name="name"]').fill('School bag')
    page.locator('dialog').get_by_role('button', name='Save').click()
    expect(page.get_by_role('heading', name='School bag')).to_be_visible()

    page.goto(BASE + '#/')
    page.locator('.tag-row', has_text='Laptop').click()
    page.get_by_role('button', name='Play sound').click()
    expect(page.locator('[data-bind="msg"]')).to_contain_text('out of range', timeout=6000)
    shot(page, '04-detail-away')
    page.get_by_role('button', name='Remove this Styk').click()
    page.locator('dialog').get_by_role('button', name='Remove').click()
    expect(page.locator('.tag-row')).to_have_count(1)

    page.reload()
    expect(page.locator('.tag-row', has_text='School bag')).to_be_visible()
    assert not errors, errors
    ctx.close()
    print('ok  demo: add, play and stop sound, rename, out of range, remove, persists after reload')


def test_real_tag(browser):
    ctx, page, errors = new_page(browser, init=FAKE_TAG)
    page.goto(BASE + '?tag=7f3a&pin=482915')
    expect(page.get_by_role('heading', name='Add a Styk')).to_be_visible()
    assert 'pin=' not in page.url, 'PIN should be removed from the address bar'
    expect(page.locator('input[name="tag"]')).to_have_value('7F3A')
    expect(page.locator('input[name="pin"]')).to_have_value('482915')
    page.locator('input[name="name"]').fill('Toolbox')
    page.locator('.icon-choice', has_text='Tools').click()
    shot(page, '05-add')
    page.get_by_role('button', name='Connect').click()

    expect(page.get_by_role('heading', name='Toolbox')).to_be_visible(timeout=6000)
    expect(page.locator('[data-bind="pill"]')).to_have_text('Connected')
    expect(page.locator('[data-bind="battery"]')).to_have_text('87%')
    expect(page.locator('[data-bind="fw"]')).to_have_text('0.2.0')
    expect(page.locator('[data-bind="solar"]')).to_have_text('Charging from light')
    entries = log(page)
    assert ['requestDevice', '[{"namePrefix":"Styk-7F3A"},{"services":["5a7e0001-6b1d-4c3a-9f2e-0a1b2c3d4e5f"]}]'] in entries, entries
    assert ['read', '5a7e0005'] in entries and ['read', '5a7e0004'] in entries
    assert ['notify', '5a7e0004'] in entries
    clock = [e for e in entries if e[0] == 'write' and e[1] == '5a7e0003']
    assert clock and clock[0][2][0] == 0x30 and len(clock[0][2]) == 5, clock

    page.get_by_role('button', name='Play sound').click()
    expect(page.get_by_role('button', name='Stop sound')).to_be_visible()
    shot(page, '06-real-tag')
    page.get_by_role('button', name='Stop sound').click()
    expect(page.get_by_role('button', name='Play sound')).to_be_visible()
    alerts = [e[2] for e in log(page) if e[0] == 'write' and e[1] == '5a7e0002']
    assert alerts == [[1], [0]], alerts

    page.evaluate('window.__device.gatt.disconnect()')
    expect(page.locator('[data-bind="pill"]')).to_have_text('Not connected')
    expect(page.locator('#toast')).to_contain_text('Lost touch with Toolbox')
    page.get_by_role('button', name='Connect').click()
    expect(page.locator('[data-bind="pill"]')).to_have_text('Connected')

    page.get_by_role('button', name='Remove this Styk').click()
    expect(page.locator('dialog')).to_contain_text('will forget this phone')
    page.locator('dialog').get_by_role('button', name='Remove').click()
    expect(page.get_by_role('heading', name='Find your things with Styk')).to_be_visible()
    releases = [e for e in log(page) if e[0] == 'write' and e[1] == '5a7e0003' and e[2] == [0x10]]
    assert len(releases) == 1, log(page)
    assert not errors, errors
    ctx.close()
    print('ok  simulated tag: pairing link, connect, status, clock, sound bytes, lost-touch alert, reconnect, release')


def test_wrong_tag(browser):
    ctx, page, errors = new_page(browser, init=FAKE_TAG + "\nwindow.__tagCode = 'AAAA';")
    page.goto(BASE + '#/add')
    page.locator('input[name="tag"]').fill('7F3A')
    page.locator('input[name="pin"]').fill('482915')
    page.get_by_role('button', name='Connect').click()
    expect(page.locator('[data-bind="add-error"]')).to_contain_text('different Styk (code AAAA)')
    page.locator('input[name="pin"]').fill('12')
    page.get_by_role('button', name='Connect').click()
    expect(page.locator('[data-bind="add-error"]')).to_contain_text('PIN is 6 digits')
    assert not errors, errors
    ctx.close()
    print('ok  wrong tag and bad PIN are explained')


def test_blank_code(browser):
    ctx, page, errors = new_page(browser, init=FAKE_TAG)
    page.goto(BASE + '#/add')
    page.locator('input[name="name"]').fill('Dev kit')
    page.get_by_role('button', name='Connect').click()
    expect(page.get_by_role('heading', name='Dev kit')).to_be_visible(timeout=6000)
    expect(page.locator('.rows')).to_contain_text('7F3A')
    first = [e for e in log(page) if e[0] == 'requestDevice'][0]
    assert first[1] == '[{"services":["5a7e0001-6b1d-4c3a-9f2e-0a1b2c3d4e5f"]}]', first
    assert not errors, errors
    ctx.close()
    print('ok  blank code: picker lists every Styk and the code is read from the tag')


def test_no_bluetooth(browser):
    ctx, page, errors = new_page(browser, init=NO_BLUETOOTH)
    page.goto(BASE + '#/add')
    expect(page.locator('.add')).to_contain_text("This browser can't use Bluetooth")
    page.goto(BASE + '#/settings')
    expect(page.locator('.rows')).to_contain_text('Not available')
    assert not errors, errors
    ctx.close()
    print('ok  browsers without Bluetooth get a clear message and the demo')


def test_offline_and_dark(browser):
    ctx, page, errors = new_page(browser, scheme='dark')
    page.goto(BASE)
    page.evaluate('navigator.serviceWorker.ready')
    cached = page.evaluate("caches.open('styk-app-0.2.0').then(c => c.keys()).then(k => k.length)")
    assert cached >= 20, cached
    page.get_by_role('button', name='Try the demo tags').click()
    shot(page, '07-home-dark')
    page.locator('.tag-row', has_text='Backpack').click()
    expect(page.get_by_role('heading', name='Backpack')).to_be_visible()
    shot(page, '08-detail-dark')
    page.goto(BASE + '#/settings')
    shot(page, '09-settings-dark')
    assert not errors, errors
    ctx.close()
    print(f'ok  installable: service worker cached {cached} files; dark mode renders')


def test_desktop(browser):
    ctx, page, errors = new_page(browser, size=(1280, 860))
    page.goto(BASE)
    page.get_by_role('button', name='Try the demo tags').click()
    page.locator('.tag-row', has_text='Backpack').click()
    expect(page.get_by_role('heading', name='Backpack')).to_be_visible()
    shot(page, '10-desktop')
    assert not errors, errors
    ctx.close()
    print('ok  desktop layout')


if __name__ == '__main__':
    httpd = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        failures = 0
        for test in (test_demo, test_real_tag, test_wrong_tag, test_blank_code, test_no_bluetooth, test_offline_and_dark, test_desktop):
            try:
                test(browser)
            except Exception as exc:  # report every failure, keep going
                failures += 1
                print(f'FAIL {test.__name__}: {exc}')
        browser.close()
    httpd.shutdown()
    sys.exit(1 if failures else 0)
