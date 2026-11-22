// Follow mode (dash-6) and the first view.
//
// - With follow on and the selected responder on a fresh fix: fly to it once (zoom 17), then pan
//   only when it drifts out of the middle of the view. A new position never triggers a new fly.
// - The user dragging the map turns follow off (onUserPan). Turning follow back on, or selecting
//   another responder, flies once more.
// - Before any fix the map shows MAP_DEFAULT_CENTER. The first time any responder has a position
//   and follow has nothing to fly to, the view fits those positions once.
// There is no location filter: any valid fix anywhere is used (dash-2).

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';

export const FOLLOW_ZOOM = 17;

export default function FollowController({ target, follow, positions, onUserPan }) {
  const map = useMap();
  const flownFor = useRef(null);
  const flying = useRef(false);
  const viewSet = useRef(false);

  useEffect(() => {
    const onDragStart = () => {
      viewSet.current = true;
      onUserPan();
    };
    map.on('dragstart', onDragStart);
    return () => {
      map.off('dragstart', onDragStart);
    };
  }, [map, onUserPan]);

  useEffect(() => {
    if (!follow) flownFor.current = null;
  }, [follow]);

  const id = target ? target.id : null;
  const lat = target ? target.lat : null;
  const lon = target ? target.lon : null;

  useEffect(() => {
    if (!follow || id === null) return;
    const here = L.latLng(lat, lon);
    if (flownFor.current !== id) {
      flownFor.current = id;
      viewSet.current = true;
      flying.current = true;
      map.once('moveend', () => {
        flying.current = false;
      });
      map.flyTo(here, FOLLOW_ZOOM, { duration: 1.2 });
      return;
    }
    if (flying.current) return;
    if (!map.getBounds().pad(-0.25).contains(here)) map.panTo(here, { animate: true, duration: 0.6 });
  }, [map, follow, id, lat, lon]);

  // positions: [[lat, lon], ...] of responders with any known position
  const posKey = positions.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(';');
  useEffect(() => {
    if (viewSet.current || !posKey || (follow && id !== null)) return;
    viewSet.current = true;
    const pts = posKey.split(';').map((s) => s.split(',').map(Number));
    if (pts.length === 1) map.setView(pts[0], 16);
    else map.fitBounds(pts, { padding: [40, 40], maxZoom: FOLLOW_ZOOM });
  }, [map, posKey, follow, id]);

  return null;
}
