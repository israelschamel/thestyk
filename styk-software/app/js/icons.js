// Line icons for the things people stick a Styk on. 24 x 24, drawn with currentColor.

const P = {
  backpack: '<path d="M6 9a6 6 0 0 1 12 0v9.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 18.5z"/><path d="M9.5 4.6a2.5 2.5 0 0 1 5 0"/><path d="M9 13h6v4H9z"/>',
  laptop: '<path d="M5 6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5V15H5z"/><path d="M3 18.5h18"/>',
  wallet: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6H18v12H5.5A1.5 1.5 0 0 1 4 16.5z"/><path d="M14 10h6v4h-6a2 2 0 0 1 0-4z"/>',
  keys: '<circle cx="8" cy="15.5" r="4"/><path d="M11 12.5l8-8"/><path d="M16 7.5l2 2"/><path d="M13.6 9.9l2 2"/>',
  bike: '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-7h5.5L18 16"/><path d="M10 9l3.2 7"/><path d="M8.5 6h3"/>',
  notebook: '<path d="M7 4h10.5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7z"/><path d="M5 7.5h4M5 12h4M5 16.5h4"/><path d="M11 8.5h4.5M11 11.5h4.5"/>',
  luggage: '<path d="M6.5 8h11v11h-11z"/><path d="M9.5 8V5h5v3"/><path d="M10 11v5M14 11v5"/><path d="M8.5 19v1.5M15.5 19v1.5"/>',
  toolbox: '<path d="M4 10h16v9H4z"/><path d="M9 10V7h6v3"/><path d="M4 14h16"/>',
  tag: '<rect x="4.5" y="4.5" width="15" height="15" rx="3.5"/><rect x="7" y="7" width="10" height="6.4" rx="1.2"/>',
};

export const ICON_CHOICES = [
  ['backpack', 'Backpack'], ['laptop', 'Laptop'], ['wallet', 'Wallet'], ['keys', 'Keys'],
  ['bike', 'Bike'], ['notebook', 'Notebook'], ['luggage', 'Luggage'], ['toolbox', 'Tools'], ['tag', 'Other'],
];

export function icon(name, size = 24, label = '') {
  const body = P[name] || P.tag;
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${body}</svg>`;
}

export const UI = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  speaker: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.5-2h5L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.5"/>',
  route: '<path d="M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M6 15V9a3 3 0 0 1 3-3h1M18 9v6a3 3 0 0 1-3 3h-1"/>',
};

export function ui(name, size = 22) {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI[name]}</svg>`;
}
