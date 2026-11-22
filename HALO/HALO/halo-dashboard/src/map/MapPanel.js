// Operational map. OSM tiles in normal colours, zoom control, scale bar, follow mode, responder
// markers with accuracy circles and sensing halos, hazard zones, the selected responder's trail
// and a draggable command post. Custom panes keep the draw order fixed when layers are toggled:
// halos < hazard zones < accuracy < trail < command post < hazard pins < responders
// (< Leaflet tooltips and popups).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MapContainer, Pane, TileLayer } from 'react-leaflet';
import { Map as MapIcon } from 'lucide-react';
import { useEvery } from '../lib/clock';
import { isLatLonPair, validLatLon } from '../lib/geo';
import { filterHazards, isHazardWindow } from '../lib/hazards';
import { useStoredState } from '../lib/storage';
import { AccessNotice } from '../components/NotAuthorised';
import { Panel } from '../components/ui';
import CommandPost from './CommandPost';
import FollowController from './FollowController';
import { HazardPins, HazardZones } from './HazardLayer';
import MapControls, { LAYERS } from './MapControls';
import MapResizer from './MapResizer';
import { AccuracyCircles, ResponderMarkers, SensingHalos } from './ResponderLayer';
import ScaleBar from './ScaleBar';
import TrailLayer from './TrailLayer';

// Bull Temple Rd, Basavanagudi, Bengaluru: only the view before any fix (no location filter).
export const MAP_DEFAULT_CENTER = [12.94289, 77.56821];
const MAP_DEFAULT_ZOOM = 15;
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const DEFAULT_LAYERS = LAYERS.reduce((acc, l) => ({ ...acc, [l.key]: true }), {});
const isLayerState = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'boolean');

// The command post defaults to MAP_DEFAULT_CENTER, which is also the simulator's base position,
// so its pane sits under the pins and responders: a responder on the CP stays visible and clickable.
const PANES = [
  ['halo-halos', 330],
  ['halo-hazards', 340],
  ['halo-accuracy', 350],
  ['halo-trail', 360],
  ['halo-cp', 435],
  ['halo-pins', 440],
  ['halo-responders', 450],
];
const paneStyle = (z) => ({ zIndex: z });

// selectSeq changes on every selection, including a click on the responder already selected.
function MapPanel({ responders, lostIds, selectedId, selectSeq, readings, hazards, hazardsError, user, onSelect }) {
  const [follow, setFollow] = useState(true);
  const [storedLayers, setLayers] = useStoredState('halo.map.layers.v1', DEFAULT_LAYERS, isLayerState);
  const [hzWindow, setHzWindow] = useStoredState('halo.map.hazardWindow.v1', 'active', isHazardWindow);
  const [cp, setCp] = useStoredState('halo.map.commandPost.v1', MAP_DEFAULT_CENTER, isLatLonPair);
  const layers = useMemo(() => ({ ...DEFAULT_LAYERS, ...storedLayers }), [storedLayers]);
  const now = useEvery(10000);

  // Selecting a responder (card, map, ticker or alert log) turns follow back on, also when it is
  // the responder already selected.
  useEffect(() => {
    setFollow(true);
  }, [selectedId, selectSeq]);

  const stopFollow = useCallback(() => setFollow(false), []);
  const toggleFollow = useCallback(() => setFollow((f) => !f), []);
  const toggleLayer = useCallback((key) => setLayers((prev) => ({ ...DEFAULT_LAYERS, ...prev, [key]: prev[key] === false })), [setLayers]);

  const sel = selectedId ? responders[selectedId] : null;
  const selLost = selectedId ? lostIds.has(selectedId) : true;
  const tLat = sel ? sel.lat : null;
  const tLon = sel ? sel.lon : null;
  const tFresh = Boolean(sel) && !selLost && sel.gps_ok === true && validLatLon(tLat, tLon);
  const target = useMemo(() => (tFresh ? { id: selectedId, lat: tLat, lon: tLon } : null), [tFresh, selectedId, tLat, tLon]);

  const positioned = Object.keys(responders).filter((id) => validLatLon(responders[id].lat, responders[id].lon));
  const positions = positioned.map((id) => [responders[id].lat, responders[id].lon]);
  const freshCount = positioned.filter((id) => responders[id].gps_ok === true && !lostIds.has(id)).length;
  const shownHazards = useMemo(() => filterHazards(hazards, hzWindow, now), [hazards, hzWindow, now]);
  const activeHazards = hazards.filter((h) => h.active).length;

  const meta = `${freshCount} fresh fix${freshCount === 1 ? '' : 'es'} · ${activeHazards} active hazard${activeHazards === 1 ? '' : 's'}`;

  return (
    <Panel title="Operational map" icon={MapIcon} meta={meta} className="area-map" bodyClassName="map-body">
      <div className="map-wrap">
        <MapContainer center={MAP_DEFAULT_CENTER} zoom={MAP_DEFAULT_ZOOM} zoomControl className="map-canvas">
          <TileLayer url={OSM_URL} attribution={OSM_ATTRIBUTION} maxZoom={19} />
          <ScaleBar />
          <MapResizer />
          <FollowController target={target} follow={follow} positions={positions} onUserPan={stopFollow} />
          {PANES.map(([name, z]) => (
            <Pane key={name} name={name} style={paneStyle(z)}>
              {name === 'halo-halos' && layers.halos ? <SensingHalos responders={responders} lostIds={lostIds} /> : null}
              {name === 'halo-hazards' && layers.hazards ? <HazardZones hazards={shownHazards} now={now} /> : null}
              {name === 'halo-accuracy' && layers.accuracy ? <AccuracyCircles responders={responders} lostIds={lostIds} /> : null}
              {name === 'halo-trail' && layers.trail ? <TrailLayer readings={readings} /> : null}
              {name === 'halo-cp' ? <CommandPost cp={cp} onMove={setCp} responders={responders} /> : null}
              {name === 'halo-pins' && layers.hazards ? <HazardPins hazards={shownHazards} now={now} /> : null}
              {name === 'halo-responders' ? (
                <ResponderMarkers responders={responders} lostIds={lostIds} selectedId={selectedId} cp={cp} showLabels={layers.labels} onSelect={onSelect} />
              ) : null}
            </Pane>
          ))}
        </MapContainer>
        <MapControls
          follow={follow}
          canFollow={Boolean(target)}
          onToggleFollow={toggleFollow}
          layers={layers}
          onToggleLayer={toggleLayer}
          hzWindow={hzWindow}
          onHzWindow={setHzWindow}
        />
        {positions.length === 0 ? <div className="map-overlay-note">No GPS position yet</div> : null}
        {hazardsError ? (
          <div className="map-overlay-error">
            <AccessNotice error={hazardsError} user={user} />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

export default React.memo(MapPanel);
