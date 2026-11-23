// Map overlay: Follow toggle, hazard time window, layer toggles and the legend. It sits beside the
// Leaflet container (not inside it), so clicks here never pan the map.

import React from 'react';
import { Layers, LocateFixed } from 'lucide-react';
import { MARKER, T } from '../theme';
import { HAZARD_WINDOWS } from '../lib/hazards';

export const LAYERS = [
  { key: 'hazards', label: 'Hazards' },
  { key: 'trail', label: 'Trail' },
  { key: 'accuracy', label: 'GPS accuracy' },
  { key: 'halos', label: 'Sensing halos' },
  { key: 'labels', label: 'Labels' },
];

function Dot({ fill, stroke, dashed }) {
  return <span className="swatch" style={{ background: fill, borderColor: stroke || fill, borderStyle: dashed ? 'dashed' : 'solid' }} />;
}

function Line({ color }) {
  return <span className="swatch-line" style={{ background: color }} />;
}

// Symbol names only; the colours follow the same P0 / P1 / P2 scheme as the rest of the dashboard.
function Legend() {
  const items = [
    [<Dot key="p0" fill={T.redFill} stroke={MARKER.ring} />, 'P0 MAYDAY'],
    [<Dot key="p1" fill={T.amberFill} stroke={MARKER.ring} />, 'P1 WARNING'],
    [<Dot key="p2" fill={T.greenFill} stroke={MARKER.ring} />, 'P2 NOMINAL'],
    [<Dot key="lost" fill={T.grayFill} stroke={T.redFill} dashed />, 'Link lost'],
    [<Dot key="stale" fill={T.greenBg} stroke={T.grayFill} dashed />, 'Stale fix'],
    [<Dot key="acc" fill={T.blueBg} stroke={T.blueFill} />, 'GPS accuracy'],
    [<Dot key="halo" fill={T.greenBg} stroke={T.greenFill} />, 'Sensing halo'],
    [<Dot key="co" fill={T.orangeBg} stroke={T.orangeFill} />, 'CO'],
    [<Dot key="air" fill={T.purpleBg} stroke={T.purpleFill} />, 'Smoke'],
    [<Dot key="heat" fill={T.amberBg} stroke={T.amberFill} />, 'Heat'],
    [<Dot key="fire" fill={T.redFill} stroke={MARKER.ring} />, 'Possible fire'],
    [<Dot key="fall" fill={T.redFill} stroke={MARKER.ring} />, 'Fall'],
    [<Dot key="still" fill={T.amberFill} stroke={MARKER.ring} />, 'No motion'],
    [<Line key="trail" color={T.blueFill} />, 'Trail'],
    [<span key="cp" className="legend-cp">CP</span>, 'Command post'],
  ];
  return (
    <div className="legend-grid">
      {items.map(([sw, text]) => (
        <span key={text} className="legend-item">
          <span className="legend-sw">{sw}</span>
          <span>{text}</span>
        </span>
      ))}
    </div>
  );
}

export default function MapControls({ follow, canFollow, onToggleFollow, layers, onToggleLayer, hzWindow, onHzWindow }) {
  return (
    <div className="map-ctl">
      <div className="map-ctl-box">
        <button type="button" className="seg-btn" aria-pressed={follow} onClick={onToggleFollow}>
          <LocateFixed size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Follow{follow && !canFollow ? ' (no fresh fix)' : ''}
        </button>
      </div>
      <div className="map-ctl-box" role="group" aria-label="Hazard time window">
        <span className="map-ctl-label">Hazards</span>
        {HAZARD_WINDOWS.map((w) => (
          <button key={w.key} type="button" className="seg-btn" aria-pressed={hzWindow === w.key} onClick={() => onHzWindow(w.key)}>
            {w.label}
          </button>
        ))}
      </div>
      <details>
        <summary>
          <Layers size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Layers and legend
        </summary>
        <div className="map-ctl-panel">
          <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
            <legend className="map-ctl-label" style={{ padding: 0, marginBottom: 4 }}>
              Layers
            </legend>
            <div className="map-ctl-toggles">
              {LAYERS.map((l) => (
                <label key={l.key}>
                  <input type="checkbox" checked={layers[l.key] !== false} onChange={() => onToggleLayer(l.key)} />
                  {l.label}
                </label>
              ))}
            </div>
          </fieldset>
          <Legend />
        </div>
      </details>
    </div>
  );
}
