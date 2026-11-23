// Leaflet divIcons. The markup here is constant (lucide icon paths and the "CP" text); no
// device-supplied value is ever interpolated into it (ARCC XSS guidance). Labels and values go in
// react-leaflet Tooltip/Popup children, which React renders as text.

import L from 'leaflet';

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// lucide 0.383 path data: Flame, Siren, Hourglass
const FLAME = svg(
  '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
);
const SIREN = svg(
  '<path d="M7 18v-6a5 5 0 1 1 10 0v6"/><path d="M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z"/><path d="M21 12h1"/><path d="M18.5 4.5 18 5"/><path d="M2 12h1"/><path d="M12 2v1"/><path d="m4.929 4.929.707.707"/><path d="M12 12v6"/>',
);
const HOURGLASS = svg(
  '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
);

// Pin: a 28 px badge whose tip sits on the hazard point, so a responder dot at the same spot
// (drawn in a higher pane) stays visible under the tip.
const pin = (variant, body) =>
  L.divIcon({
    className: `map-pin map-pin-${variant}`,
    html: `<span class="map-pin-body">${body}</span>`,
    iconSize: [28, 36],
    iconAnchor: [14, 37],
    popupAnchor: [0, -34],
    tooltipAnchor: [0, -34],
  });

export const HAZARD_ICONS = {
  FIRE_SUSPECTED: pin('fire', FLAME),
  FALL: pin('fall', SIREN),
  NO_MOTION: pin('still', HOURGLASS),
};

// Side badge for a pin that shares its point with a more important one (mapData.layoutPins):
// 22 px, no tip, level with the main pin body, slot 1 just right of it, slot 2 next to that.
const SIDE_BODY = { FIRE_SUSPECTED: ['fire', FLAME], FALL: ['fall', SIREN], NO_MOTION: ['still', HOURGLASS] };
const sideIcons = new Map();

export function sidePinIcon(type, slot) {
  const key = `${type}:${slot}`;
  if (!sideIcons.has(key) && SIDE_BODY[type]) {
    const [variant, body] = SIDE_BODY[type];
    const left = 16 + (slot - 1) * 24; // px right of the hazard point
    sideIcons.set(
      key,
      L.divIcon({
        className: `map-pin map-pin-${variant} map-pin-side`,
        html: `<span class="map-pin-body">${body}</span>`,
        iconSize: [22, 22],
        iconAnchor: [-left, 34],
        popupAnchor: [left + 11, -34],
        tooltipAnchor: [left + 11, -34],
      }),
    );
  }
  return sideIcons.get(key);
}

export const CP_ICON = L.divIcon({
  className: 'map-cp',
  html: '<span class="map-cp-body">CP</span>',
  iconSize: [36, 26],
  iconAnchor: [18, 13],
  popupAnchor: [0, -14],
  tooltipAnchor: [0, -14],
});
