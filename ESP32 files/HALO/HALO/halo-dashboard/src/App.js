import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, onValue, query, limitToLast, orderByKey } from 'firebase/database';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap, Circle } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const firebaseConfig = {
  apiKey:            "AIzaSyAs5CKRfDMbOLyqhPE5QedKWf8aoVVRnAk",
  authDomain:        "halo-223051.firebaseapp.com",
  databaseURL:       "https://halo-223051-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "halo-223051",
  storageBucket:     "halo-223051.firebasestorage.app",
  messagingSenderId: "740770019914",
  appId:             "1:740770019914:web:2c5876b30a1f99760584b3",
};
const fbApp = initializeApp(firebaseConfig);
const db    = getDatabase(fbApp);

const C = {
  bg:        '#04060d',
  panel:     '#060912',
  card:      '#080c16',
  cardHi:    '#0b1020',
  border:    '#111928',
  borderHi:  '#182436',
  text:      '#6b8aaa',
  bright:    '#ddeeff',
  dim:       '#243447',
  dimText:   '#3d5570',
  green:     '#00e5a0', greenBg: '#00150a', greenDim: '#003322',
  yellow:    '#f5c842', yellowBg:'#130e00', yellowDim: '#2a1f00',
  red:       '#ff2d55', redBg:   '#12000a', redDim: '#2a0015',
  blue:      '#3d9fff', blueBg:  '#00111f', blueDim: '#001828',
  orange:    '#ff7a3d',
  teal:      '#00c8d4',
  purple:    '#8b5cf6',
};

const fv   = (v, d=1) => (v == null || v < 0) ? '—' : Number(v).toFixed(d);
const fi   = (v)      => (v == null || v < 0) ? '—' : String(Math.round(v));
const ts   = (t)      => t ? new Date(t).toLocaleTimeString('en-IN', { hour12: false }) : '—';
const clk  = ()       => new Date().toLocaleTimeString('en-IN', { hour12: false });
const hasGps = (r)    => r && r.lat != null && r.lon != null && (r.lat !== 0 || r.lon !== 0);

// Three-state display helpers for HR and SpO2
// -1 = calibrating (sensor warming up), 0 = no signal, >0 = valid reading
function vitalDisplay(v) {
  if (v === -1)             return { text: 'Calibrating…', color: C.yellow, isCal: true };
  if (v == null || v === 0) return { text: 'No signal',    color: C.dimText, isCal: false };
  return                           { text: String(Math.round(v)), color: null, isCal: false };
}
function hrDisplay(v)   { const d = vitalDisplay(v); return { ...d, color: d.color || hrClr(v) }; }
function spo2Display(v) { const d = vitalDisplay(v); return { ...d, color: d.color || spo2Clr(v) }; }
function hrSub(v)   { if (v === -1) return 'WARMING UP'; if (v == null || v === 0) return 'NO SIGNAL'; if (v > 150) return 'TACHYCARDIA'; if (v < 50) return 'BRADYCARDIA'; return 'NORMAL'; }
function spo2Sub(v) { if (v === -1) return 'WARMING UP'; if (v == null || v === 0) return 'NO SIGNAL'; if (v < 90) return 'CRITICAL HYPOXIA'; if (v < 94) return 'BELOW NORMAL'; return 'ADEQUATE'; }

function prio(r)    { if (!r) return 'offline'; if (r.priority === 0) return 'critical'; if (r.priority === 1) return 'warning'; return 'nominal'; }
function coClr(v)   { if (v > 200) return C.red;    if (v > 50)  return C.yellow; return C.green; }
function spo2Clr(v) { if (!v||v<0) return C.dimText; if (v < 90)  return C.red;    if (v < 94) return C.yellow; return C.green; }
function hrClr(v)   { if (!v||v<0) return C.dimText; if (v > 150) return C.red;    if (v > 120) return C.yellow; return C.green; }
function psiClr(v)  { if (!v||v<0) return C.dimText; if (v >= 9)  return C.red;    if (v >= 7) return C.yellow; return C.green; }
function battClr(v) { if (!v||v<0) return C.dimText; if (v < 20)  return C.red;    if (v < 40) return C.yellow; return C.green; }
function psiLbl(v)  { if (!v||v<0) return '';        if (v >= 9)  return 'DANGEROUS'; if (v >= 7) return 'ELEVATED'; return 'NORMAL'; }

const STATUS = {
  critical: { color: C.red,    bg: C.redBg,    dim: C.redDim,    label: 'CRITICAL' },
  warning:  { color: C.yellow, bg: C.yellowBg, dim: C.yellowDim, label: 'WARNING'  },
  nominal:  { color: C.green,  bg: C.greenBg,  dim: C.greenDim,  label: 'NOMINAL'  },
  offline:  { color: C.dimText,bg: C.card,     dim: C.card,      label: 'OFFLINE'  },
};

function useAlertSound() {
  const ctxRef = useRef(null);
  return useCallback((type) => {
    try {
      if (!ctxRef.current)
        ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = ctxRef.current;
      const patterns = {
        mayday:  [[880,0,.12],[660,.18,.12],[880,.36,.12],[660,.54,.12],[880,.72,.25],[440,.98,.08]],
        warning: [[528,0,.18],[528,.3,.18],[660,.6,.12]],
      };
      (patterns[type] || []).forEach(([freq, delay, dur]) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = type === 'mayday' ? 'square' : 'sine';
        gain.gain.setValueAtTime(0, ctx.currentTime + delay);
        gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + delay + 0.01);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + delay + dur);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + dur + 0.05);
      });
    } catch (_) {}
  }, []);
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; overflow: hidden; }
body {
  background: ${C.bg};
  color: ${C.text};
  font-family: 'Space Grotesk', system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.4;
}
::-webkit-scrollbar { width: 2px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 2px; }
.mono { font-family: 'Space Mono', monospace; }

@keyframes blink      { 0%,100%{opacity:1} 50%{opacity:.1} }
@keyframes blinkDot   { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(.5);opacity:.25} }
@keyframes critBdr    { 0%,100%{border-color:${C.red}} 50%{border-color:${C.redDim}} }
@keyframes slideIn    { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }
@keyframes slideUp    { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
@keyframes shake      { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-4px)} 40%{transform:translateX(4px)} 60%{transform:translateX(-3px)} 80%{transform:translateX(2px)} }
@keyframes spin       { to{transform:rotate(360deg)} }
@keyframes fadeIn     { from{opacity:0} to{opacity:1} }
@keyframes glow       { 0%,100%{text-shadow:0 0 8px currentColor} 50%{text-shadow:0 0 20px currentColor, 0 0 40px currentColor} }
@keyframes warnPulse  { 0%,100%{background:${C.yellowDim}} 50%{background:${C.yellowBg}} }
@keyframes redPulse   { 0%,100%{background:${C.redDim}} 50%{background:${C.redBg}} }

.crit-screen { position: relative; }
.crit-screen::before {
  content: '';
  position: fixed; inset: 0; pointer-events: none; z-index: 9998;
  background: radial-gradient(ellipse at 50% 0%, ${C.red}0a 0%, transparent 60%);
  animation: fadeIn .3s ease;
}
.crit-screen::after {
  content: '';
  position: fixed; inset: 0; pointer-events: none; z-index: 9999;
  border: 2px solid ${C.red};
  animation: critBdr .8s ease-in-out infinite;
  box-shadow: inset 0 0 40px ${C.red}10;
}

.tab {
  background: none; border: none; cursor: pointer;
  padding: 10px 16px;
  font-size: 10px; font-weight: 700; letter-spacing: 2px;
  color: ${C.dimText}; border-bottom: 2px solid transparent;
  font-family: 'Space Grotesk', sans-serif;
  transition: color .2s, border-color .2s;
  white-space: nowrap; text-transform: uppercase;
}
.tab:hover  { color: ${C.text}; }
.tab.active { color: ${C.blue}; border-bottom-color: ${C.blue}; }

.card  { background: ${C.card};   border: 1px solid ${C.border};  border-radius: 8px; }
.cardB { background: ${C.cardHi}; border: 1px solid ${C.borderHi}; border-radius: 8px; }

.rcard {
  background: ${C.card}; border: 1px solid ${C.border};
  border-radius: 8px; cursor: pointer;
  transition: border-color .2s, background .2s, transform .15s;
  position: relative; overflow: hidden;
}
.rcard:hover  { border-color: ${C.borderHi}; background: ${C.cardHi}; transform: translateY(-1px); }
.rcard.sel    { border-color: ${C.blue} !important; background: ${C.blueDim} !important; }
.rcard.crit   { animation: critBdr 1s infinite; border-color: ${C.red} !important; }
.rcard.warn   { border-color: ${C.yellow}44 !important; }

.mline {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 0; border-bottom: 1px solid ${C.border};
}
.mline:last-child { border-bottom: none; }

.arow {
  padding: 10px 14px; border-bottom: 1px solid ${C.border};
  animation: slideIn .25s ease;
  display: flex; align-items: flex-start; gap: 10px;
}
.arow:first-child { animation: shake .4s ease; }

.stat-card {
  background: ${C.card}; border: 1px solid ${C.border};
  border-radius: 8px; padding: 14px;
  transition: border-color .2s;
}
.stat-card:hover { border-color: ${C.borderHi}; }

.leaflet-container { background: ${C.bg} !important; }
.leaflet-tile-pane { filter: saturate(.15) brightness(.5) hue-rotate(180deg); }
.leaflet-popup-content-wrapper {
  background: ${C.card} !important; border: 1px solid ${C.borderHi} !important;
  border-radius: 6px !important; box-shadow: 0 8px 32px #000c !important;
  color: ${C.text} !important; padding: 0 !important;
}
.leaflet-popup-content { margin: 0 !important; }
.leaflet-popup-tip { background: ${C.card} !important; }
.leaflet-popup-close-button { color: ${C.dimText} !important; top: 6px !important; right: 8px !important; }

.insight-ok       { background: ${C.greenBg}; border: 1px solid ${C.green}18; border-left: 2px solid ${C.green}; }
.insight-warning  { background: ${C.yellowBg}; border: 1px solid ${C.yellow}18; border-left: 2px solid ${C.yellow}; }
.insight-critical { background: ${C.redBg}; border: 1px solid ${C.red}18; border-left: 2px solid ${C.red}; }
`;

function FlyTo({ pos }) {
  const map = useMap();
  useEffect(() => {
    if (pos && pos[0] !== 0) map.flyTo(pos, 17, { duration: 1.1 });
  }, [pos, map]);
  return null;
}

function CTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: C.cardHi, border: `1px solid ${C.borderHi}`, borderRadius: 6, padding: '6px 10px' }}>
      {payload.map((p, i) => (
        <div key={i} className="mono" style={{ fontSize: 11, color: p.color }}>
          {p.name}: {Number(p.value).toFixed(1)}
        </div>
      ))}
    </div>
  );
}

function Spark({ data, k, color, h = 55, domain, refs = [] }) {
  return (
    <ResponsiveContainer width="100%" height={h}>
      <AreaChart data={data} margin={{ top: 4, right: 2, left: -40, bottom: 0 }}>
        <defs>
          <linearGradient id={`g-${k}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity={.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0}   />
          </linearGradient>
        </defs>
        <YAxis domain={domain || ['auto', 'auto']} hide />
        <Tooltip content={<CTip />} />
        {refs.map((r, i) => (
          <ReferenceLine key={i} y={r.y} stroke={r.c} strokeDasharray="3 2" strokeWidth={1} />
        ))}
        <Area
          type="monotone" dataKey={k}
          stroke={color} strokeWidth={1.8}
          fill={`url(#g-${k})`}
          dot={false} isAnimationActive={false}
          name={k.toUpperCase()}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ProgBar({ value = 0, max, warn, danger, height = 4 }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const clr = value > danger ? C.red : value > warn ? C.yellow : C.green;
  return (
    <div style={{ height, background: C.border, borderRadius: height, overflow: 'hidden', marginTop: 6 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: clr, borderRadius: height, transition: 'width .6s cubic-bezier(.4,0,.2,1), background .3s' }} />
    </div>
  );
}

function SL({ children, right, accent }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {accent && <div style={{ width: 2, height: 12, background: accent, borderRadius: 1 }} />}
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2.5, color: C.dimText, textTransform: 'uppercase' }}>{children}</span>
      </div>
      {right && <span style={{ fontSize: 10, color: C.dimText }}>{right}</span>}
    </div>
  );
}

function Badge({ children, color, bg, blink }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: 1.5, padding: '2px 7px',
      borderRadius: 3, background: bg, color, border: `1px solid ${color}28`,
      flexShrink: 0,
      ...(blink ? { animation: 'blink .9s infinite' } : {}),
    }}>{children}</span>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TOPBAR
// ═══════════════════════════════════════════════════════════════════
function Topbar({ responders, alerts, connected, tab, setTab }) {
  const total    = Object.keys(responders).length;
  const critical = Object.values(responders).filter(r => r?.priority === 0).length;
  const warning  = Object.values(responders).filter(r => r?.priority === 1).length;
  const nominal  = Object.values(responders).filter(r => r?.priority === 2).length;
  const [tick, setTick] = useState(clk());
  useEffect(() => { const t = setInterval(() => setTick(clk()), 1000); return () => clearInterval(t); }, []);
  const latestAlert = alerts[0];
  const isCrit = critical > 0;

  return (
    <div style={{
      height: 54, flexShrink: 0,
      background: C.panel,
      borderBottom: `1px solid ${isCrit ? C.red + '55' : C.border}`,
      display: 'flex', alignItems: 'stretch',
      transition: 'border-color .4s',
      position: 'relative', zIndex: 100,
    }}>
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px', borderRight: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 6, flexShrink: 0,
          background: isCrit ? C.redBg : C.blueDim,
          border: `1px solid ${isCrit ? C.red + '55' : C.blue + '44'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all .3s',
          boxShadow: isCrit ? `0 0 14px ${C.red}28` : `0 0 14px ${C.blue}18`,
        }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 2L14 13H2L8 2Z" stroke={isCrit ? C.red : C.blue} strokeWidth="1.5" strokeLinejoin="round"/>
            <circle cx="8" cy="10.5" r="1" fill={isCrit ? C.red : C.blue}/>
            <line x1="8" y1="6.5" x2="8" y2="9" stroke={isCrit ? C.red : C.blue} strokeWidth="1.2"/>
          </svg>
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 5, color: C.bright, lineHeight: 1 }}>HALO</div>
          <div style={{ fontSize: 8, color: C.dimText, letterSpacing: 2.5, marginTop: 2 }}>COMMAND</div>
        </div>
      </div>

      {/* Situation counters */}
      {[
        { label: 'ACTIVE',   value: total,    color: C.blue,   glow: false },
        { label: 'CRITICAL', value: critical, color: C.red,    glow: isCrit },
        { label: 'WARNING',  value: warning,  color: C.yellow, glow: false },
        { label: 'NOMINAL',  value: nominal,  color: C.green,  glow: false },
      ].map(({ label, value, color, glow }) => (
        <div key={label} style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '0 22px', borderRight: `1px solid ${C.border}`, minWidth: 80, flexShrink: 0,
        }}>
          <div className="mono" style={{
            fontSize: 24, fontWeight: 700, color, lineHeight: 1,
            ...(glow && value > 0 ? { animation: 'glow 1.2s ease-in-out infinite' } : {}),
          }}>{value}</div>
          <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: 2, color: C.dimText, marginTop: 3 }}>{label}</div>
        </div>
      ))}

      {/* Nav tabs */}
      <div style={{ display: 'flex', alignItems: 'flex-end', padding: '0 4px', borderRight: `1px solid ${C.border}`, flexShrink: 0 }}>
        {['LIVE MONITORING', 'ANALYTICS'].map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {/* Alert ticker */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '0 16px', overflow: 'hidden', minWidth: 0 }}>
        {latestAlert ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, overflow: 'hidden', width: '100%', animation: 'slideIn .3s ease' }}>
            <Badge
              color={latestAlert.priority === 0 ? C.red : C.yellow}
              bg={latestAlert.priority === 0 ? C.redBg : C.yellowBg}
              blink={latestAlert.priority === 0}
            >
              {latestAlert.priority === 0 ? '⚠ MAYDAY' : '⚡ WARN'}
            </Badge>
            <span style={{
              fontSize: 12, fontWeight: 500,
              color: latestAlert.priority === 0 ? C.red : C.yellow,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {latestAlert.reason} — {latestAlert.responder_id}
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: C.green }} />
            <span style={{ fontSize: 11, color: C.dimText }}>All units nominal</span>
          </div>
        )}
      </div>

      {/* Clock + connection */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 20px', borderLeft: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{ textAlign: 'right' }}>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: C.bright, lineHeight: 1, letterSpacing: 1 }}>{tick}</div>
          <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 1.5, marginTop: 2 }}>IST</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: connected ? C.green : C.red,
              animation: 'blinkDot 1.5s infinite',
              boxShadow: `0 0 6px ${connected ? C.green : C.red}`,
            }} />
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: connected ? C.green : C.red }}>
              {connected ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
          <div style={{ fontSize: 8, color: C.dimText, letterSpacing: 1 }}>FIREBASE</div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// RESPONDER CARD
// ═══════════════════════════════════════════════════════════════════
function RCard({ id, r, sel, onClick, lastSeen }) {
  const s      = STATUS[prio(r)];
  const stale  = lastSeen && (Date.now() - lastSeen > 35000);
  const isCrit = prio(r) === 'critical';
  const isWarn = prio(r) === 'warning';

  return (
    <div
      className={`rcard ${sel ? 'sel' : ''} ${isCrit ? 'crit' : ''} ${isWarn && !isCrit ? 'warn' : ''}`}
      onClick={() => onClick(id)}
      style={{ padding: '13px 14px' }}
    >
      {isCrit && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 2,
          background: `linear-gradient(90deg, ${C.red}, ${C.red}44)`,
          animation: 'blink .8s infinite',
        }} />
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0,
            boxShadow: `0 0 7px ${s.color}`,
            animation: isCrit ? 'blinkDot .7s infinite' : isWarn ? 'blinkDot 1.8s infinite' : 'none',
          }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: C.bright, letterSpacing: .5 }}>{id}</span>
          {stale && <Badge color={C.yellow} bg={C.yellowBg}>STALE</Badge>}
        </div>
        <Badge color={s.color} bg={s.bg} blink={isCrit}>{s.label}</Badge>
      </div>

      {/* Primary vitals */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
        background: C.bg, borderRadius: 6, overflow: 'hidden',
        border: `1px solid ${C.border}`, marginBottom: 10,
      }}>
        {(() => {
          const hd = hrDisplay(r?.hr);
          const sd = spo2Display(r?.spo2);
          return [
            { label: 'HR',   value: hd.text, unit: 'bpm', color: hd.color, isCal: hd.isCal },
            { label: 'SpO₂', value: sd.text, unit: '%',   color: sd.color, isCal: sd.isCal },
            { label: 'CO',   value: fi(r?.co),   unit: 'ppm', color: coClr(r?.co), isCal: false },
          ].map(({ label, value, unit, color, isCal }, i) => (
            <div key={label} style={{
              textAlign: 'center', padding: '10px 4px',
              borderRight: i < 2 ? `1px solid ${C.border}` : 'none',
            }}>
              <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 1.5, marginBottom: 4 }}>{label}</div>
              <div className="mono" style={{ fontSize: isCal ? 10 : 20, fontWeight: 700, color, lineHeight: 1, ...(isCal ? { animation: 'blink 1.5s infinite' } : {}) }}>{value}</div>
              <div style={{ fontSize: 9, color: C.dimText, marginTop: 2 }}>{unit}</div>
            </div>
          ));
        })()}
      </div>

      {/* Secondary row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)' }}>
        {[
          { label: 'TEMP', value: `${fv(r?.temp, 1)}°`, color: C.orange       },
          { label: 'PSI',  value: fv(r?.psi, 1),        color: psiClr(r?.psi) },
          { label: 'BATT', value: `${fi(r?.batt)}%`,    color: battClr(r?.batt) },
          { label: 'RSSI', value: r?.rssi ? `${Math.round(r.rssi)}` : '—', color: C.dimText },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ textAlign: 'center', padding: '4px 0' }}>
            <div style={{ fontSize: 8, color: C.dimText, letterSpacing: 1, marginBottom: 2 }}>{label}</div>
            <div className="mono" style={{ fontSize: 11, fontWeight: 600, color }}>{value}</div>
          </div>
        ))}
      </div>

      {r?.fall && (
        <div style={{
          marginTop: 10, padding: '6px 10px', borderRadius: 4,
          background: C.redBg, border: `1px solid ${C.red}44`,
          display: 'flex', alignItems: 'center', gap: 7,
          animation: 'shake .5s ease',
        }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: C.red, animation: 'blinkDot .6s infinite', boxShadow: `0 0 5px ${C.red}` }} />
          <span style={{ fontSize: 10, fontWeight: 700, color: C.red, letterSpacing: 2 }}>FALL DETECTED</span>
        </div>
      )}

      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 4, height: 4, borderRadius: '50%', background: hasGps(r) ? C.green : C.dimText, flexShrink: 0 }} />
        <span style={{ fontSize: 9, color: C.dimText, fontFamily: 'monospace' }}>
          {hasGps(r) ? `${r.lat?.toFixed(4)}, ${r.lon?.toFixed(4)}` : 'GPS: no fix'}
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DEEP DIVE PANEL
// ═══════════════════════════════════════════════════════════════════
function DeepDive({ id, r, hist, alerts }) {
  const [tab, setTab] = useState('vitals');

  if (!id) return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      <div style={{ width: 44, height: 44, borderRadius: '50%', border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 20, opacity: .15 }}>◎</div>
      </div>
      <div style={{ fontSize: 11, color: C.dimText, letterSpacing: 1.5 }}>SELECT A RESPONDER</div>
    </div>
  );

  const cd       = hist.map((h, i) => ({ i, hr: h.hr > 0 ? h.hr : null, spo2: h.spo2 > 0 ? h.spo2 : null, co: h.co, aq: h.aq, psi: h.psi > 0 ? h.psi : null, accel: h.accel }));
  const myAlerts = alerts.filter(a => a.responder_id === id);
  const s        = STATUS[prio(r)];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 2.5, marginBottom: 4 }}>RESPONDER PROFILE</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.bright, letterSpacing: .5 }}>{id}</div>
          </div>
          <div style={{
            padding: '6px 14px', borderRadius: 6, fontSize: 11, fontWeight: 700, letterSpacing: 2,
            background: s.bg, color: s.color, border: `1px solid ${s.color}28`,
            boxShadow: `0 0 14px ${s.color}12`,
            ...(prio(r) === 'critical' ? { animation: 'blink 1s infinite' } : {}),
          }}>{s.label}</div>
        </div>

        <div className="card" style={{ padding: '10px 13px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 7 }}>
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: C.dimText, marginBottom: 2 }}>PHYSIOLOGICAL STRESS INDEX</div>
              <div style={{ fontSize: 9, color: C.dimText, opacity: .7 }}>HR + core temp · Moran et al. (1998)</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span className="mono" style={{ fontSize: 22, fontWeight: 700, color: psiClr(r?.psi) }}>{fv(r?.psi, 1)}</span>
              <span style={{ fontSize: 11, color: C.dimText }}> /10</span>
              <div style={{ fontSize: 9, color: psiClr(r?.psi), letterSpacing: 1, marginTop: 2, fontWeight: 600 }}>{psiLbl(r?.psi)}</div>
            </div>
          </div>
          <div style={{ height: 5, background: C.border, borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              width: `${Math.min(100, Math.max(0, (r?.psi || 0) / 10 * 100))}%`, height: '100%',
              background: `linear-gradient(90deg, ${C.green}, ${psiClr(r?.psi)})`,
              borderRadius: 3, transition: 'width .6s cubic-bezier(.4,0,.2,1)',
            }} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, flexShrink: 0, background: C.panel, paddingLeft: 6 }}>
        {['vitals', 'environment', 'movement', 'alerts'].map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t.toUpperCase()}{t === 'alerts' && myAlerts.length > 0 ? ` (${myAlerts.length})` : ''}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 15px' }}>

        {tab === 'vitals' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, animation: 'slideUp .2s ease' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {(() => {
                const hd = hrDisplay(r?.hr);
                const sd = spo2Display(r?.spo2);
                return [
                  { label: 'HEART RATE',  v: hd.text,        unit: 'bpm', color: hd.color,          sub: hrSub(r?.hr),   isCal: hd.isCal },
                  { label: 'SpO₂',        v: sd.text,        unit: '%',   color: sd.color,          sub: spo2Sub(r?.spo2), isCal: sd.isCal },
                  { label: 'TEMPERATURE', v: fv(r?.temp,1),  unit: '°C',  color: C.orange,          sub: r?.temp > 38.5 ? 'HYPERTHERMIA' : 'NORMAL', isCal: false },
                  { label: 'BATTERY',     v: fi(r?.batt),    unit: '%',   color: battClr(r?.batt),  sub: r?.batt < 20 ? 'CRITICAL LOW' : r?.batt < 40 ? 'LOW' : 'OK', isCal: false },
                ].map(({ label, v, unit, color, sub, isCal }) => (
                  <div key={label} className="card" style={{ padding: '12px 13px' }}>
                    <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 1.5, marginBottom: 6 }}>{label}</div>
                    <div className="mono" style={{ fontSize: isCal ? 13 : 26, fontWeight: 700, color, lineHeight: 1, ...(isCal ? { animation: 'blink 1.5s infinite' } : {}) }}>
                      {v}{!isCal && <span style={{ fontSize: 11, color: C.dimText, marginLeft: 4 }}>{unit}</span>}
                    </div>
                    <div style={{ fontSize: 9, color, marginTop: 4, fontWeight: 600, letterSpacing: .5 }}>{sub}</div>
                  </div>
                ));
              })()}
            </div>
            <div className="card" style={{ padding: '11px 13px' }}>
              <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 1.5, marginBottom: 7 }}>HEART RATE — 5 MIN</div>
              <Spark data={cd} k="hr" color={C.blue} domain={[40, 200]} h={70} refs={[{ y: 150, c: C.red }, { y: 50, c: C.yellow }]} />
            </div>
            <div className="card" style={{ padding: '11px 13px' }}>
              <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 1.5, marginBottom: 7 }}>SpO₂ — 5 MIN</div>
              <Spark data={cd} k="spo2" color={C.green} domain={[80, 100]} h={70} refs={[{ y: 94, c: C.yellow }, { y: 90, c: C.red }]} />
            </div>
          </div>
        )}

        {tab === 'environment' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, animation: 'slideUp .2s ease' }}>
            <div className="card" style={{ padding: '13px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 1.5, marginBottom: 5 }}>CO CONCENTRATION</div>
                  <div className="mono" style={{ fontSize: 34, fontWeight: 700, color: coClr(r?.co), lineHeight: 1 }}>
                    {fi(r?.co)}<span style={{ fontSize: 14, color: C.dimText, marginLeft: 5 }}>ppm</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 1, marginBottom: 4 }}>15-MIN TWA</div>
                  <div className="mono" style={{ fontSize: 16, color: coClr(r?.twa_co), fontWeight: 700 }}>{fv(r?.twa_co, 1)} ppm</div>
                  <div style={{ fontSize: 9, color: C.dimText, marginTop: 2 }}>NIOSH limit: 35 ppm</div>
                </div>
              </div>
              <ProgBar value={r?.co || 0} max={400} warn={50} danger={200} height={5} />
              <div style={{ marginTop: 12 }}>
                <Spark data={cd} k="co" color={C.yellow} h={62} refs={[{ y: 50, c: C.yellow }, { y: 200, c: C.red }]} />
              </div>
            </div>
            <div className="card" style={{ padding: '13px 14px' }}>
              <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 1.5, marginBottom: 6 }}>AIR QUALITY INDEX</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: C.blue, marginBottom: 7 }}>
                {fi(r?.aq)}<span style={{ fontSize: 12, color: C.dimText, marginLeft: 5 }}>AQI</span>
              </div>
              <ProgBar value={r?.aq || 0} max={500} warn={100} danger={200} height={5} />
              <div style={{ marginTop: 10 }}>
                <Spark data={cd} k="aq" color={C.blue} h={54} />
              </div>
            </div>
            <div className="card" style={{ padding: '13px 14px' }}>
              <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 1.5, marginBottom: 10 }}>NIOSH / OSHA LIMITS</div>
              {[
                { label: 'CO TWA (8hr)',    limit: '35 ppm',   color: C.yellow },
                { label: 'CO STEL (15min)', limit: '200 ppm',  color: C.orange },
                { label: 'CO IDLH',         limit: '1200 ppm', color: C.red    },
              ].map(({ label, limit, color }) => (
                <div key={label} className="mline">
                  <span style={{ fontSize: 11, color: C.text }}>{label}</span>
                  <span className="mono" style={{ fontSize: 11, color, fontWeight: 700 }}>{limit}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'movement' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, animation: 'slideUp .2s ease' }}>
            <div className="card" style={{
              padding: '14px 15px',
              background: r?.fall ? C.redBg : C.greenBg,
              border: `1px solid ${r?.fall ? C.red + '40' : C.green + '28'}`,
              ...(r?.fall ? { animation: 'critBdr 1s infinite' } : {}),
            }}>
              <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 1.5, marginBottom: 7 }}>FALL DETECTION STATUS</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: r?.fall ? C.red : C.green }}>
                {r?.fall ? '⚠  FALL DETECTED' : '✓  STABLE'}
              </div>
              {r?.fall && <div style={{ fontSize: 11, color: C.red, marginTop: 6, lineHeight: 1.5 }}>P0 MAYDAY active. Emergency protocol triggered. Physical assessment required before re-entry.</div>}
            </div>
            <div className="card" style={{ padding: '13px 14px' }}>
              <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 1.5, marginBottom: 6 }}>ACCELERATION MAGNITUDE</div>
              <div className="mono" style={{ fontSize: 26, fontWeight: 700, color: C.blue, lineHeight: 1, marginBottom: 8 }}>
                {fv(r?.accel, 3)}<span style={{ fontSize: 12, color: C.dimText, marginLeft: 5 }}>g</span>
              </div>
              <ProgBar value={r?.accel || 0} max={5} warn={2.0} danger={2.5} height={5} />
              <div style={{ marginTop: 10 }}>
                <Spark data={cd} k="accel" color={C.blue} h={66} refs={[{ y: 2.5, c: C.red }]} />
              </div>
              <div style={{ marginTop: 8, fontSize: 9, color: C.dimText, lineHeight: 1.6 }}>
                Fall criteria: spike &gt;2.5g followed by &lt;0.3g stillness within 800ms
              </div>
            </div>
            <div className="card" style={{ padding: '13px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: 9, color: C.dimText, letterSpacing: 1.5 }}>GPS POSITION</div>
                <div style={{
                  fontSize: 9, fontWeight: 700, padding: '3px 8px', borderRadius: 3,
                  background: hasGps(r) ? C.greenBg : C.card,
                  color: hasGps(r) ? C.green : C.dimText,
                  border: `1px solid ${hasGps(r) ? C.green + '28' : C.border}`,
                }}>
                  {hasGps(r) ? 'FIX OK' : 'NO FIX'}
                </div>
              </div>
              {hasGps(r) ? (
                <div>
                  <div className="mono" style={{ fontSize: 13, color: C.bright, marginBottom: 3 }}>{r.lat?.toFixed(6)}° N</div>
                  <div className="mono" style={{ fontSize: 13, color: C.bright }}>{r.lon?.toFixed(6)}° E</div>
                </div>
              ) : (
                <div style={{ fontSize: 11, color: C.dimText, lineHeight: 1.6 }}>
                  NEO-6M requires outdoor line-of-sight. No fix available indoors.
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'alerts' && (
          <div style={{ animation: 'slideUp .2s ease' }}>
            {myAlerts.length === 0 ? (
              <div style={{ textAlign: 'center', color: C.dimText, padding: 36 }}>
                <div style={{ fontSize: 18, marginBottom: 8, opacity: .25 }}>✓</div>
                <div style={{ fontSize: 11 }}>No alerts logged for {id}.</div>
              </div>
            ) : myAlerts.map((a, i) => {
              const sc = STATUS[a.priority === 0 ? 'critical' : a.priority === 1 ? 'warning' : 'nominal'];
              return (
                <div key={i} className="arow" style={{ borderLeft: `2px solid ${sc.color}` }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: sc.color, fontWeight: 600, marginBottom: 3 }}>{a.reason}</div>
                    <div className="mono" style={{ fontSize: 9, color: C.dimText }}>{ts(a.ts)}</div>
                  </div>
                  <Badge color={sc.color} bg={sc.bg}>P{a.priority}</Badge>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ALERT FEED
// ═══════════════════════════════════════════════════════════════════
function AlertFeed({ alerts, lastP0Time, responders }) {
  const p0 = alerts.filter(a => a.priority === 0);
  const p1 = alerts.filter(a => a.priority === 1);
  const isCrit = p0.length > 0;
  const isWarn = p1.length > 0 && !isCrit;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      <div style={{ padding: '11px 14px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2.5, color: C.dimText }}>ALERT FEED</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {p0.length > 0 && <Badge color={C.red} bg={C.redBg} blink>{p0.length} P0</Badge>}
            {p1.length > 0 && <Badge color={C.yellow} bg={C.yellowBg}>{p1.length} P1</Badge>}
          </div>
        </div>
        {lastP0Time && (
          <div style={{ fontSize: 9, color: C.red }}>
            Last MAYDAY: <span className="mono">{ts(lastP0Time)}</span>
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {alerts.length === 0 ? (
          <div style={{ padding: '28px 14px', textAlign: 'center' }}>
            <div style={{ width: 30, height: 30, borderRadius: '50%', background: C.greenBg, border: `1px solid ${C.green}28`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: C.green }} />
            </div>
            <div style={{ fontSize: 11, color: C.dimText, marginBottom: 3 }}>All clear</div>
            <div style={{ fontSize: 10, color: C.dimText, opacity: .55 }}>No alerts. Monitoring active.</div>
          </div>
        ) : alerts.map((a, i) => {
          const sc = STATUS[a.priority === 0 ? 'critical' : a.priority === 1 ? 'warning' : 'nominal'];
          return (
            <div key={i} className="arow">
              <div style={{ width: 2, alignSelf: 'stretch', background: sc.color, borderRadius: 1, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Badge color={sc.color} bg={sc.bg}>P{a.priority}</Badge>
                  <span style={{ fontSize: 10, color: sc.color, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.reason}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ fontSize: 9, color: C.dimText }}>{a.responder_id}</span>
                  <span className="mono" style={{ fontSize: 9, color: C.dimText }}>{ts(a.ts)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Priority Flow Control — live highlighted */}
      <div style={{ padding: '12px 13px', borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
        <SL accent={isCrit ? C.red : isWarn ? C.yellow : C.green}>Priority Flow Control</SL>
        {[
          { p: 'P0', label: 'MAYDAY',  desc: 'Fall / CO>200 / SpO₂<90', color: C.red,    int: '1s',  active: isCrit },
          { p: 'P1', label: 'WARNING', desc: 'CO>50 / SpO₂<94 / HR>150', color: C.yellow, int: '5s',  active: isWarn },
          { p: 'P2', label: 'NOMINAL', desc: 'Routine telemetry',         color: C.green,  int: '30s', active: !isCrit && !isWarn },
        ].map(row => (
          <div key={row.p} style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5,
            padding: '5px 8px', borderRadius: 5, transition: 'all .3s',
            background: row.active ? `${row.color}10` : 'transparent',
            border: `1px solid ${row.active ? row.color + '28' : 'transparent'}`,
          }}>
            <Badge color={row.color} bg={`${row.color}15`} blink={row.active && row.p === 'P0'}>{row.p}</Badge>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span className="mono" style={{ fontSize: 9, color: row.active ? row.color : C.dimText, fontWeight: 700 }}>{row.label} </span>
              <span style={{ fontSize: 9, color: C.dimText }}>{row.desc}</span>
            </div>
            <span className="mono" style={{ fontSize: 9, color: row.active ? row.color : C.dimText, flexShrink: 0 }}>/{row.int}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ANALYTICS TAB
// ═══════════════════════════════════════════════════════════════════
function Analytics({ hist, alerts }) {
  const valid   = hist.filter(r => r.hr > 0);
  const avgHr   = valid.length ? valid.reduce((s, r) => s + r.hr, 0) / valid.length : 0;
  const maxCo   = hist.length ? Math.max(...hist.map(r => r.co || 0)) : 0;
  const minSpo2 = hist.filter(r => r.spo2 > 0).length ? Math.min(...hist.filter(r => r.spo2 > 0).map(r => r.spo2)) : 0;
  const maxPsi  = hist.filter(r => r.psi > 0).length  ? Math.max(...hist.filter(r => r.psi  > 0).map(r => r.psi))  : 0;
  const falls   = alerts.filter(a => a.reason === 'FALL DETECTED').length;
  const p0s     = alerts.filter(a => a.priority === 0);
  const p1s     = alerts.filter(a => a.priority === 1);

  const insights = [];
  if      (maxCo > 200) insights.push({ t: 'critical', msg: `Peak CO hit ${Math.round(maxCo)} ppm this session — above the NIOSH ceiling of 200 ppm. Evacuation protocol should have triggered.` });
  else if (maxCo > 50)  insights.push({ t: 'warning',  msg: `CO peaked at ${Math.round(maxCo)} ppm, crossing the NIOSH 50 ppm TWA limit. Cumulative exposure time needs reviewing.` });
  else                  insights.push({ t: 'ok',       msg: `No hazardous CO detected. Peak reading was ${Math.round(maxCo)} ppm, well within the NIOSH 50 ppm limit.` });

  if      (minSpo2 > 0 && minSpo2 < 90)  insights.push({ t: 'critical', msg: `SpO₂ dropped to ${Math.round(minSpo2)}% — critical hypoxia threshold breached. Supplemental oxygen was required.` });
  else if (minSpo2 > 0 && minSpo2 < 94)  insights.push({ t: 'warning',  msg: `SpO₂ dipped to ${Math.round(minSpo2)}%, just below the normal 94% baseline. Respiratory monitoring advised on next deployment.` });
  else if (minSpo2 >= 94)                 insights.push({ t: 'ok',       msg: `Oxygen saturation stayed healthy throughout. Minimum recorded was ${Math.round(minSpo2)}%.` });

  if (falls > 0) insights.push({ t: 'critical', msg: `${falls} fall event${falls > 1 ? 's were' : ' was'} logged. Physical injury assessment is required before any re-entry clearance.` });
  else           insights.push({ t: 'ok',       msg: `No falls detected. Movement stayed stable for the full duration of the session.` });

  if      (maxPsi >= 9) insights.push({ t: 'critical', msg: `PSI peaked at ${maxPsi.toFixed(1)}/10 — dangerous heat stress territory. Mandatory cooling and rest are required post-deployment.` });
  else if (maxPsi >= 7) insights.push({ t: 'warning',  msg: `PSI hit ${maxPsi.toFixed(1)}/10, indicating moderate physiological stress. A rest interval should follow within 15 minutes of that reading.` });
  else                  insights.push({ t: 'ok',       msg: `Stress index stayed within safe limits throughout. Peak PSI was ${maxPsi.toFixed(1)}/10.` });

  if (p0s.length > 0) insights.push({ t: 'critical', msg: `${p0s.length} MAYDAY event${p0s.length > 1 ? 's' : ''} triggered this session. Most recent at ${ts(p0s[0]?.ts)}.` });

  const insightClass = { critical: 'insight-critical', warning: 'insight-warning', ok: 'insight-ok' };
  const insightColor = { critical: C.red, warning: C.yellow, ok: C.green };
  const cd = hist.map((r, i) => ({ i, hr: r.hr > 0 ? r.hr : null, spo2: r.spo2 > 0 ? r.spo2 : null, co: r.co, psi: r.psi > 0 ? r.psi : null, accel: r.accel }));

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '24px', background: C.bg, animation: 'slideUp .2s ease' }}>

      {/* Top row: intelligence + summary */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, marginBottom: 24 }}>
        <div>
          <SL accent={C.blue}>System Intelligence</SL>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {insights.map((ins, i) => (
              <div key={i} className={insightClass[ins.t]} style={{ padding: '10px 14px', borderRadius: 6 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: insightColor[ins.t], marginTop: 5, flexShrink: 0 }} />
                  <div style={{ fontSize: 12, color: ins.t === 'ok' ? C.text : insightColor[ins.t], lineHeight: 1.65 }}>{ins.msg}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SL accent={C.purple}>Session Summary</SL>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              { label: 'AVG HR',      value: Math.round(avgHr),   unit: 'bpm',  color: C.blue,          icon: '♥' },
              { label: 'PEAK CO',     value: Math.round(maxCo),   unit: 'ppm',  color: coClr(maxCo),    icon: '◈' },
              { label: 'MIN SpO₂',    value: Math.round(minSpo2), unit: '%',    color: spo2Clr(minSpo2), icon: '○' },
              { label: 'PEAK PSI',    value: maxPsi.toFixed(1),   unit: '/10',  color: psiClr(maxPsi),  icon: '△' },
              { label: 'FALL EVENTS', value: falls,               unit: '',     color: falls > 0 ? C.red : C.green, icon: falls > 0 ? '⚠' : '✓' },
            ].map(({ label, value, unit, color, icon }) => (
              <div key={label} className="stat-card" style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 17, color, marginBottom: 5, opacity: .65 }}>{icon}</div>
                <div className="mono" style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
                <div style={{ fontSize: 10, color: C.dimText, marginTop: 2 }}>{unit}</div>
                <div style={{ fontSize: 8, color: C.dimText, letterSpacing: 1.5, marginTop: 5 }}>{label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Alert classification */}
      <div style={{ marginBottom: 24 }}>
        <SL accent={C.orange}>Alert Classification</SL>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          {[
            { label: 'P0 MAYDAY',  count: p0s.length,                              color: C.red,    bg: C.redBg,    desc: 'Emergency protocols activated' },
            { label: 'P1 WARNING', count: p1s.length,                              color: C.yellow, bg: C.yellowBg, desc: 'Elevated risk events' },
            { label: 'P2 NOMINAL', count: alerts.filter(a=>a.priority===2).length, color: C.green,  bg: C.greenBg,  desc: 'Routine transmissions' },
          ].map(({ label, count, color, bg, desc }) => (
            <div key={label} style={{
              background: bg, border: `1px solid ${color}18`,
              borderRadius: 8, padding: '18px 20px',
              borderLeft: `3px solid ${color}`,
            }}>
              <div className="mono" style={{ fontSize: 40, fontWeight: 700, color, lineHeight: 1, marginBottom: 6 }}>{count}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: 1.5, marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 10, color: C.dimText }}>{desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Trend analysis */}
      <div style={{ marginBottom: 24 }}>
        <SL accent={C.teal}>Trend Analysis</SL>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[
            { title: 'Heart Rate',          sub: 'bpm', k: 'hr',   color: C.blue,   domain: [40,200],  refs: [{y:150,c:C.red},{y:50,c:C.yellow}] },
            { title: 'Blood Oxygen (SpO₂)', sub: '%',   k: 'spo2', color: C.green,  domain: [80,100],  refs: [{y:94,c:C.yellow},{y:90,c:C.red}]  },
            { title: 'CO Concentration',    sub: 'ppm', k: 'co',   color: C.yellow, domain: undefined, refs: [{y:50,c:C.yellow},{y:200,c:C.red}] },
            { title: 'Stress Index (PSI)',  sub: '/10', k: 'psi',  color: C.orange, domain: [0,10],    refs: [{y:7,c:C.yellow},{y:9,c:C.red}]    },
          ].map(({ title, sub, k, color, domain, refs }) => (
            <div key={k} className="card" style={{ padding: '14px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.text }}>{title}</div>
                  <div style={{ fontSize: 9, color: C.dimText, marginTop: 2 }}>{sub}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {refs?.map((r, i) => (
                    <span key={i} style={{ fontSize: 9, color: r.c }}>— {r.y}</span>
                  ))}
                </div>
              </div>
              <Spark data={cd} k={k} color={color} domain={domain} h={100} refs={refs} />
            </div>
          ))}
        </div>
      </div>

      {/* Data export */}
      <div className="card" style={{ padding: '14px 16px' }}>
        <SL accent={C.dimText}>ML Pipeline — Data Export</SL>
        <div style={{ fontSize: 11, color: C.text, marginBottom: 12, lineHeight: 1.65 }}>
          {hist.length} readings stored in Firebase for HALO-01. Pull into a Jupyter notebook for anomaly detection, PSI modelling, or fall classification.
        </div>
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '12px 14px' }}>
          <div className="mono" style={{ fontSize: 10, color: C.blue, lineHeight: 2 }}>
            import firebase_admin; from firebase_admin import db<br />
            snap = db.reference('readings/HALO-01').get()<br />
            df   = pd.DataFrame(snap.values())<br />
            df['ts'] = pd.to_datetime(df['ts'])
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [responders, setResponders] = useState({});
  const [histByID,   setHistByID]   = useState({});
  const [alerts,     setAlerts]     = useState([]);
  const [selId,      setSelId]      = useState(null);
  const [connected,  setConnected]  = useState(false);
  const [tab,        setTab]        = useState('LIVE MONITORING');
  const [lastSeen,   setLastSeen]   = useState({});
  const [lastP0,     setLastP0]     = useState(null);
  const prevPrioRef  = useRef({});
  const playAlert    = useAlertSound();

  useEffect(() => {
    const u1 = onValue(ref(db, 'live'), snap => {
      if (!snap.exists()) return;
      const data = snap.val();
      setConnected(true);
      setLastSeen(prev => {
        const n = { ...prev };
        Object.keys(data).forEach(k => n[k] = Date.now());
        return n;
      });
      Object.entries(data).forEach(([id, r]) => {
        const prev = prevPrioRef.current[id];
        if      (r.priority === 0 && prev !== 0) { playAlert('mayday');  setLastP0(r.ts || new Date().toISOString()); }
        else if (r.priority === 1 && prev !== 1)   playAlert('warning');
        prevPrioRef.current[id] = r.priority;
      });
      setResponders(data);
      setSelId(p => p || Object.keys(data)[0]);
    }, () => setConnected(false));

    const u2 = onValue(query(ref(db, 'alerts'), orderByKey(), limitToLast(100)), snap => {
      if (snap.exists()) setAlerts(Object.values(snap.val()).reverse());
    });

    const u3 = onValue(query(ref(db, 'readings/HALO-01'), orderByKey(), limitToLast(60)), snap => {
      if (snap.exists()) setHistByID(p => ({ ...p, 'HALO-01': Object.values(snap.val()) }));
    });

    return () => { u1(); u2(); u3(); };
  }, [playAlert]);

  const selR    = responders[selId];
  const selHist = histByID[selId] || [];
  const isCrit  = Object.values(responders).some(r => r?.priority === 0);
  const dangerR = Object.values(responders).find(r => r?.co > 50 && hasGps(r));

  return (
    <>
      <style>{CSS}</style>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />

      <div className={isCrit ? 'crit-screen' : ''} style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        <Topbar responders={responders} alerts={alerts} connected={connected} tab={tab} setTab={setTab} />

        {tab === 'ANALYTICS' ? (
          <Analytics hist={selHist} alerts={alerts} />
        ) : (
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '234px 1fr 284px 250px', overflow: 'hidden' }}>

            <div style={{ background: C.panel, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '11px 14px', borderBottom: `1px solid ${C.border}`, flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2.5, color: C.dimText }}>RESPONDERS</span>
                <span className="mono" style={{ fontSize: 11, color: C.blue, fontWeight: 700 }}>{Object.keys(responders).length}</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.keys(responders).length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 28, color: C.dimText }}>
                    <div style={{ width: 20, height: 20, border: `2px solid ${C.border}`, borderTopColor: C.blue, borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
                    <div style={{ fontSize: 11 }}>Waiting for data...</div>
                  </div>
                ) : Object.entries(responders).map(([id, r]) => (
                  <RCard key={id} id={id} r={r} sel={selId === id} onClick={setSelId} lastSeen={lastSeen[id]} />
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', borderRight: `1px solid ${C.border}` }}>
              <div style={{ padding: '11px 14px', background: C.panel, borderBottom: `1px solid ${C.border}`, flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2.5, color: C.dimText }}>OPERATIONAL MAP</span>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: C.dimText }}>{Object.values(responders).filter(r => hasGps(r)).length} GPS active</span>
                  {dangerR && <Badge color={C.red} bg={C.redBg} blink>⚠ Hazard zone</Badge>}
                </div>
              </div>
              <div style={{ flex: 1, position: 'relative' }}>
                <MapContainer center={[12.9716, 77.5946]} zoom={15} style={{ height: '100%', width: '100%' }} zoomControl={false}>
                  <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" attribution="CartoDB" />
                  {hasGps(selR) && <FlyTo pos={[selR.lat, selR.lon]} />}
                  {dangerR && (
                    <Circle
                      center={[dangerR.lat, dangerR.lon]} radius={30}
                      pathOptions={{ color: C.red, fillColor: C.red, fillOpacity: .07, weight: 1.5, dashArray: '5 4' }}
                    />
                  )}
                  {Object.entries(responders).map(([id, r]) => {
                    if (!hasGps(r)) return null;
                    const s = STATUS[prio(r)];
                    return (
                      <React.Fragment key={id}>
                        <CircleMarker center={[r.lat, r.lon]} radius={18}
                          pathOptions={{ color: s.color, fillColor: s.color, fillOpacity: .04, weight: .5 }} />
                        <CircleMarker center={[r.lat, r.lon]} radius={8}
                          pathOptions={{ color: s.color, fillColor: s.color, fillOpacity: .9, weight: 2 }}
                          eventHandlers={{ click: () => setSelId(id) }}>
                          <Popup>
                            <div style={{ fontFamily: 'Space Mono, monospace', fontSize: 11, background: C.card, color: C.bright, padding: 12, minWidth: 155, borderRadius: 6 }}>
                              <div style={{ fontWeight: 700, marginBottom: 7, color: s.color }}>{id} — {s.label}</div>
                              <div style={{ marginBottom: 3, color: C.text }}>HR: {fi(r.hr)} bpm · SpO₂: {fi(r.spo2)}%</div>
                              <div style={{ marginBottom: 3, color: C.text }}>CO: {fi(r.co)} ppm · PSI: {fv(r.psi, 1)}</div>
                              <div style={{ marginTop: 7, fontSize: 10, color: C.dimText }}>{ts(r.ts)}</div>
                            </div>
                          </Popup>
                        </CircleMarker>
                      </React.Fragment>
                    );
                  })}
                </MapContainer>
                {!Object.values(responders).some(r => hasGps(r)) && (
                  <div style={{
                    position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
                    zIndex: 1000, background: `${C.card}ee`, border: `1px solid ${C.border}`,
                    padding: '6px 16px', borderRadius: 4, fontSize: 11, color: C.dimText, pointerEvents: 'none',
                  }}>
                    No GPS fix — outdoor operation required
                  </div>
                )}
              </div>
            </div>

            <div style={{ background: C.panel, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <DeepDive id={selId} r={selR} hist={selHist} alerts={alerts} />
            </div>

            <div style={{ background: C.panel, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <AlertFeed alerts={alerts} lastP0Time={lastP0} responders={responders} />
            </div>

          </div>
        )}
      </div>
    </>
  );
}
