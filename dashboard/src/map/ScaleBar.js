// Metric scale bar (L.control.scale), bottom left.

import { useEffect } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';

export default function ScaleBar() {
  const map = useMap();
  useEffect(() => {
    const control = L.control.scale({ position: 'bottomleft', metric: true, imperial: false, maxWidth: 140 });
    control.addTo(map);
    return () => {
      control.remove();
    };
  }, [map]);
  return null;
}
