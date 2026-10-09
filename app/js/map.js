// Last-seen map. Leaflet is bundled in lib/; map tiles come from OpenStreetMap.

let loading = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'lib/leaflet/leaflet.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = 'lib/leaflet/leaflet.js';
      js.onload = () => (window.L ? resolve(window.L) : reject(new Error('Leaflet missing')));
      js.onerror = () => { loading = null; reject(new Error('Leaflet failed to load')); };
      document.head.appendChild(js);
    });
  }
  return loading;
}

export async function drawMap(el, point) {
  if (!el || !point) return null;
  try {
    const L = await loadLeaflet();
    if (!el.isConnected) return null;
    el.textContent = '';
    const map = L.map(el, { zoomControl: false, scrollWheelZoom: false, attributionControl: true })
      .setView([point.lat, point.lng], 16);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    const solar = getComputedStyle(document.documentElement).getPropertyValue('--solar').trim() || '#24386B';
    if (point.acc) L.circle([point.lat, point.lng], { radius: Math.min(point.acc, 500), color: solar, weight: 1, fillOpacity: 0.1 }).addTo(map);
    L.circleMarker([point.lat, point.lng], { radius: 8, color: '#ffffff', weight: 3, fillColor: solar, fillOpacity: 1 }).addTo(map);
    el.dataset.state = 'ready';
    return map;
  } catch {
    el.dataset.state = 'fallback';
    el.innerHTML = `<p class="map-fallback">Map unavailable right now. Last position: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}.</p>`;
    return null;
  }
}
