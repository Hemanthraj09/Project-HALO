// Leaflet measures its container only on window resize. The map panel also changes size when the
// header wraps or unwraps (a long alert in the ticker), so watch the container itself and let
// Leaflet re-measure; otherwise follow, fit and new tiles use the old size.

import { useEffect } from 'react';
import { useMap } from 'react-leaflet';

export default function MapResizer() {
  const map = useMap();
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  return null;
}
