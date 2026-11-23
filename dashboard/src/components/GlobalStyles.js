// Global stylesheet, generated from the theme tokens so there is one source for every colour,
// font and size. Light theme only. Rendered once by App as a <style> element; it contains only
// constants from theme.js, never data.

import { FONT, FS, RADIUS, SHADOW, T } from '../theme';

const px = (n) => `${n}px`;

const CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body, #root { height: 100%; }
body {
  margin: 0;
  background: ${T.bg0};
  color: ${T.text};
  font-family: ${FONT.ui};
  font-size: ${px(FS.md)};
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { cursor: default; opacity: 0.6; }
:focus-visible { outline: 2px solid ${T.blueFill}; outline-offset: 2px; }
code, .mono { font-family: ${FONT.mono}; font-variant-numeric: tabular-nums; }
.num { font-variant-numeric: tabular-nums; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* ── shell ── */
.app { position: relative; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
.mainnav { display: flex; align-items: center; gap: 4px; padding: 0 16px; background: ${T.bg1}; border-bottom: 1px solid ${T.border}; flex-shrink: 0; }
.tab { background: none; border: none; border-bottom: 2px solid transparent; padding: 10px 12px; font-size: ${px(FS.sm)}; font-weight: 600; letter-spacing: 0.06em; color: ${T.textDim}; white-space: nowrap; }
.tab:hover { color: ${T.text}; }
.tab[aria-selected="true"] { color: ${T.blue}; border-bottom-color: ${T.blueFill}; }
.analytics-host { flex: 1; min-height: 0; overflow-y: auto; }

/* ── live grid: 4 columns >= 1440 px, feed under the deep dive below that, stacked below 1100 px ── */
.live-grid {
  flex: 1; min-height: 0; display: grid; gap: 12px; padding: 12px;
  grid-template-columns: minmax(260px, 300px) minmax(420px, 1fr) minmax(320px, 380px) minmax(280px, 320px);
  grid-template-rows: minmax(0, 1fr);
  grid-template-areas: "resp map deep feed";
}
.area-resp { grid-area: resp; }
.area-map { grid-area: map; }
.area-deep { grid-area: deep; }
.area-feed { grid-area: feed; }
@media (max-width: 1439.98px) {
  .live-grid {
    grid-template-columns: minmax(260px, 300px) minmax(420px, 1fr) minmax(320px, 380px);
    grid-template-rows: minmax(0, 3fr) minmax(0, 2fr);
    grid-template-areas: "resp map deep" "resp map feed";
  }
}
@media (max-width: 1099.98px) {
  .app { height: auto; min-height: 100vh; overflow: visible; }
  .live-grid { display: flex; flex-direction: column; }
  .area-resp { max-height: 75vh; }
  .area-map { height: 65vh; min-height: 420px; }
  .area-deep { height: 85vh; min-height: 560px; }
  .area-feed { height: 70vh; min-height: 420px; }
  .analytics-host { overflow: visible; }
}

/* ── panels and cards ── */
.panel { position: relative; min-height: 0; min-width: 0; display: flex; flex-direction: column; background: ${T.bg1}; border: 1px solid ${T.border}; border-radius: ${px(RADIUS.md)}; box-shadow: ${SHADOW.card}; overflow: hidden; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid ${T.border}; flex-shrink: 0; min-height: 41px; }
.panel-title { margin: 0; display: inline-flex; align-items: center; gap: 6px; font-size: ${px(FS.sm)}; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: ${T.textMuted}; }
.panel-meta { font-size: ${px(FS.sm)}; color: ${T.textDim}; font-variant-numeric: tabular-nums; text-align: right; }
.panel-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.card { background: ${T.bg2}; border: 1px solid ${T.border}; border-radius: ${px(RADIUS.md)}; box-shadow: ${SHADOW.card}; padding: 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.card-title { display: inline-flex; align-items: center; gap: 6px; font-size: ${px(FS.sm)}; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: ${T.textMuted}; }
.card-meta { font-size: ${px(FS.xs)}; color: ${T.textDim}; text-align: right; font-variant-numeric: tabular-nums; }
.label { font-size: ${px(FS.xs)}; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: ${T.textDim}; }
.note { font-size: ${px(FS.xs)}; color: ${T.textDim}; line-height: 1.45; }
.rows { display: flex; flex-direction: column; }
.row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid ${T.border}; }
.row:last-child { border-bottom: none; }
.row-label { font-size: ${px(FS.sm)}; color: ${T.textMuted}; }
.row-value { font-size: ${px(FS.md)}; color: ${T.textStrong}; font-variant-numeric: tabular-nums; text-align: right; overflow-wrap: anywhere; }
.row-note { font-size: ${px(FS.xs)}; color: ${T.textDim}; margin-left: 6px; }
.row-sub { display: block; font-size: ${px(FS.xs)}; color: ${T.textDim}; white-space: nowrap; }
.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px 12px; text-align: center; color: ${T.textDim}; font-size: ${px(FS.sm)}; }
.empty-title { font-size: ${px(FS.md)}; font-weight: 600; color: ${T.textMuted}; }
.spinner { width: 20px; height: 20px; border: 2px solid ${T.border}; border-top-color: ${T.blueFill}; border-radius: 50%; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── badges, chips, buttons ── */
.badge { display: inline-flex; align-items: center; gap: 4px; font-size: ${px(FS.xs)}; font-weight: 700; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 999px; border: 1px solid; white-space: nowrap; font-variant-numeric: tabular-nums; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 4px; font-size: ${px(FS.sm)}; font-weight: 600; padding: 4px 10px; border-radius: 999px; border: 1px solid ${T.borderMid}; background: ${T.bg1}; color: ${T.textMuted}; }
.chip:hover { background: ${T.bg3}; }
.chip[aria-pressed="true"] { background: ${T.blueBg}; border-color: ${T.blueFill}; color: ${T.blue}; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: ${px(FS.md)}; font-weight: 600; padding: 7px 14px; border-radius: ${px(RADIUS.sm)}; border: 1px solid ${T.borderMid}; background: ${T.bg1}; color: ${T.text}; }
.btn:hover { background: ${T.bg3}; }
.btn-primary { background: ${T.blueFill}; border-color: ${T.blueFill}; color: ${T.bg1}; }
.btn-primary:hover { background: ${T.blue}; }
.btn-small { font-size: ${px(FS.sm)}; padding: 4px 10px; }
.linkbtn { background: none; border: none; padding: 0; color: ${T.blue}; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }

/* ── banners ── */
.banner { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: ${px(RADIUS.sm)}; border: 1px solid; font-size: ${px(FS.sm)}; font-weight: 700; letter-spacing: 0.04em; }
.banner-p0 { color: ${T.red}; background: ${T.redBg}; border-color: ${T.redFill}; }
.banner-p1 { color: ${T.amber}; background: ${T.amberBg}; border-color: ${T.amberFill}; }
.banner-info { color: ${T.blue}; background: ${T.blueBg}; border-color: ${T.blueFill}; font-weight: 600; }
.banner-muted { color: ${T.textMuted}; background: ${T.grayBg}; border-color: ${T.borderMid}; font-weight: 600; }
.banner.is-live { animation: banner-pulse 1.2s ease-in-out infinite; }
@keyframes banner-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.inline-error { font-size: ${px(FS.sm)}; color: ${T.red}; background: ${T.redBg}; border: 1px solid ${T.redFill}; border-radius: ${px(RADIUS.sm)}; padding: 8px 10px; overflow-wrap: anywhere; }

/* ── situation bar ── */
.sitbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 8px 16px; background: ${T.bg1}; border-bottom: 1px solid ${T.border}; box-shadow: ${SHADOW.card}; flex-shrink: 0; position: relative; z-index: 2; }
.sitbar.is-critical { box-shadow: inset 0 -3px 0 ${T.redFill}, ${SHADOW.card}; }
.brand { display: flex; align-items: center; gap: 8px; padding-right: 8px; }
.brand-mark { width: 32px; height: 32px; border-radius: ${px(RADIUS.md)}; display: flex; align-items: center; justify-content: center; border: 1px solid; }
.brand-name { font-size: ${px(FS.lg)}; font-weight: 700; letter-spacing: 0.12em; color: ${T.textStrong}; line-height: 1.1; }
.brand-sub { font-size: ${px(FS.xs)}; font-weight: 600; letter-spacing: 0.08em; color: ${T.textDim}; }
.counters { display: flex; flex-wrap: wrap; gap: 4px; }
.counter { min-width: 84px; padding: 2px 10px; border-left: 1px solid ${T.border}; }
.counter:first-child { border-left: none; }
.counter-value { font-size: ${px(FS.xxl)}; font-weight: 700; line-height: 1.1; color: ${T.textStrong}; font-variant-numeric: tabular-nums; }
.counter-label { font-size: ${px(FS.xs)}; font-weight: 600; letter-spacing: 0.06em; color: ${T.textDim}; white-space: nowrap; }
.counter.is-blinking .counter-value { animation: banner-pulse 1s ease-in-out infinite; }
.ticker { flex: 1 1 320px; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid ${T.border}; border-radius: ${px(RADIUS.md)}; background: ${T.bg3}; text-align: left; }
.ticker:hover { border-color: ${T.borderMid}; }
.ticker-chip { flex-shrink: 0; font-size: ${px(FS.xs)}; font-weight: 700; letter-spacing: 0.08em; padding: 2px 8px; border-radius: ${px(RADIUS.sm)}; border: 1px solid; }
.ticker-text { min-width: 0; white-space: normal; overflow-wrap: anywhere; font-size: ${px(FS.md)}; font-weight: 600; }
.ticker-meta { flex-shrink: 0; font-size: ${px(FS.sm)}; color: ${T.textMuted}; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ticker-more { flex-shrink: 0; font-size: ${px(FS.sm)}; font-weight: 600; color: ${T.textDim}; white-space: nowrap; }
.ticker-empty { color: ${T.textDim}; font-size: ${px(FS.sm)}; cursor: default; }
.sit-active { font-size: ${px(FS.sm)}; color: ${T.textMuted}; white-space: nowrap; font-variant-numeric: tabular-nums; }
.sit-right { display: flex; align-items: center; gap: 16px; margin-left: auto; }
.clock { display: inline-flex; align-items: baseline; gap: 6px; }
.clock-time { font-size: ${px(FS.lg)}; font-weight: 600; color: ${T.textStrong}; }
.clock-tz { font-size: ${px(FS.xs)}; font-weight: 600; color: ${T.textDim}; }
.conn { display: inline-flex; align-items: center; gap: 6px; font-size: ${px(FS.xs)}; font-weight: 700; letter-spacing: 0.06em; }
.conn-dot { width: 8px; height: 8px; border-radius: 50%; }
.user-box { display: flex; align-items: center; gap: 8px; }
.user-email { font-size: ${px(FS.sm)}; color: ${T.textMuted}; max-width: 200px; overflow-wrap: anywhere; }

/* ── responder cards ── */
.resp-card { position: relative; background: ${T.bg2}; border: 1px solid ${T.border}; border-left: 4px solid ${T.border}; border-radius: ${px(RADIUS.md)}; box-shadow: ${SHADOW.card}; padding: 12px; display: flex; flex-direction: column; gap: 8px; cursor: pointer; }
.resp-card:hover { background: ${T.bg3}; }
.resp-card.is-selected { box-shadow: 0 0 0 2px ${T.blueFill}, ${SHADOW.card}; }
.resp-card.is-p0 { animation: p0-flash 1.2s ease-in-out infinite; }
.resp-card.is-lost { border-style: dashed; border-left-style: solid; }
@keyframes p0-flash { 0%, 100% { background-color: ${T.bg2}; } 50% { background-color: ${T.redBg}; } }
.rc-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 4px; }
.rc-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.rc-id { font-size: ${px(FS.lg)}; font-weight: 700; color: ${T.textStrong}; letter-spacing: 0.02em; white-space: nowrap; }
.rc-src { font-size: ${px(FS.xs)}; font-weight: 600; color: ${T.textDim}; border: 1px solid ${T.border}; border-radius: ${px(RADIUS.sm)}; padding: 0 4px; }
.rc-status { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.rc-last { font-size: ${px(FS.xs)}; font-weight: 700; letter-spacing: 0.04em; }
.rc-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 12px; }
.tile-label { font-size: ${px(FS.xs)}; font-weight: 600; letter-spacing: 0.06em; color: ${T.textDim}; }
.tile-value { display: flex; align-items: baseline; gap: 3px; min-width: 0; }
.tile-num { font-size: ${px(FS.xl)}; font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tile-unit { font-size: ${px(FS.xs)}; color: ${T.textDim}; }
.tile-note { font-size: ${px(FS.xs)}; font-weight: 600; letter-spacing: 0.02em; color: ${T.textDim}; white-space: normal; overflow-wrap: anywhere; }
.rc-sub { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 12px; padding-top: 6px; border-top: 1px solid ${T.border}; }
.mini-num { font-size: ${px(FS.md)}; font-weight: 600; font-variant-numeric: tabular-nums; }
.rc-dev { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.rc-line { display: flex; align-items: center; gap: 6px; font-size: ${px(FS.sm)}; color: ${T.textMuted}; font-variant-numeric: tabular-nums; min-width: 0; }
.rc-line > span { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.batt-pill { display: inline-flex; align-items: center; gap: 4px; font-size: ${px(FS.sm)}; font-weight: 600; font-variant-numeric: tabular-nums; }
.batt-name { font-weight: 500; color: ${T.textMuted}; }
.armoff { display: inline-flex; align-items: center; gap: 4px; font-size: ${px(FS.xs)}; font-weight: 700; letter-spacing: 0.04em; color: ${T.amber}; background: ${T.amberBg}; border: 1px solid ${T.amberFill}; border-radius: ${px(RADIUS.sm)}; padding: 1px 6px; }

/* ── deep dive ── */
.dd-head { padding: 12px; border-bottom: 1px solid ${T.border}; display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.dd-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dd-id { font-size: ${px(FS.xl)}; font-weight: 700; color: ${T.textStrong}; margin: 0; }
.dd-meta { font-size: ${px(FS.sm)}; color: ${T.textMuted}; font-variant-numeric: tabular-nums; }
.dd-tabs { display: flex; flex-wrap: wrap; gap: 0; padding: 0 4px; border-bottom: 1px solid ${T.border}; flex-shrink: 0; }
.dd-tabs .tab { padding: 9px 6px; letter-spacing: 0.02em; }
.dd-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.stat { background: ${T.bg2}; border: 1px solid ${T.border}; border-radius: ${px(RADIUS.md)}; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.stat-num { font-size: ${px(FS.xxl)}; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; white-space: nowrap; }
.stat-num.is-big { font-size: ${px(FS.num)}; }
.stat-unit { font-size: ${px(FS.sm)}; font-weight: 500; color: ${T.textDim}; margin-left: 4px; }
.stat-note { font-size: ${px(FS.xs)}; font-weight: 600; letter-spacing: 0.04em; }
.gauge { display: flex; flex-direction: column; gap: 4px; }
.gauge-track { position: relative; height: 8px; border-radius: 4px; overflow: hidden; display: flex; background: ${T.bg3}; }
.gauge-zone { height: 100%; opacity: 0.22; }
.gauge-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; }
.gauge-ticks { position: relative; height: 15px; font-size: ${px(FS.xs)}; color: ${T.textDim}; font-variant-numeric: tabular-nums; }
.gauge-ticks span { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
.flags { display: flex; flex-wrap: wrap; gap: 6px; }
.flag { display: inline-flex; align-items: center; gap: 4px; font-size: ${px(FS.xs)}; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid ${T.border}; background: ${T.bg3}; color: ${T.textMuted}; }
.flag.is-ok { color: ${T.green}; background: ${T.greenBg}; border-color: ${T.greenFill}; }
.flag.is-off { color: ${T.textDim}; background: ${T.grayBg}; border-color: ${T.borderMid}; text-decoration: line-through; }
.flag.is-warn { color: ${T.amber}; background: ${T.amberBg}; border-color: ${T.amberFill}; }

/* ── charts ── */
.chart-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.chart-empty { display: flex; align-items: center; justify-content: center; font-size: ${px(FS.sm)}; color: ${T.textDim}; background: ${T.bg3}; border-radius: ${px(RADIUS.sm)}; }
.chart-tip { background: ${T.bg1}; border: 1px solid ${T.borderMid}; border-radius: ${px(RADIUS.sm)}; box-shadow: ${SHADOW.pop}; padding: 6px 8px; font-size: ${px(FS.xs)}; color: ${T.text}; font-variant-numeric: tabular-nums; }
.chart-tip-time { font-weight: 600; color: ${T.textMuted}; margin-bottom: 2px; }
.chart-tip-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.chart-tip-swatch { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
.recharts-wrapper { font-family: ${FONT.ui}; }

/* ── alert feed ── */
.feed-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.feed-filters { padding: 10px 12px; border-bottom: 1px solid ${T.border}; flex-shrink: 0; }
.feed-list { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
.alert-row { display: flex; gap: 10px; padding: 10px 12px; border-bottom: 1px solid ${T.border}; border-left: 3px solid transparent; }
.alert-row.is-cleared, .alert-row.is-ongoing { background: ${T.bg3}; }
.alert-ev { flex-shrink: 0; display: flex; padding-top: 1px; }
.alert-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.alert-top { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.sev-chip { font-size: ${px(FS.xs)}; font-weight: 700; letter-spacing: 0.06em; padding: 0 6px; border-radius: ${px(RADIUS.sm)}; border: 1px solid; }
.alert-type { font-size: ${px(FS.sm)}; font-weight: 600; color: ${T.textStrong}; }
.alert-event { font-size: ${px(FS.xs)}; font-weight: 600; letter-spacing: 0.04em; color: ${T.textDim}; text-transform: uppercase; }
.alert-reason { font-size: ${px(FS.md)}; overflow-wrap: anywhere; }
.alert-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: ${px(FS.xs)}; color: ${T.textDim}; font-variant-numeric: tabular-nums; }
.feed-note { padding: 8px 12px; font-size: ${px(FS.xs)}; color: ${T.amber}; background: ${T.amberBg}; border-top: 1px solid ${T.border}; flex-shrink: 0; overflow-wrap: anywhere; }
.legend { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; padding: 8px 12px; border-top: 1px solid ${T.border}; flex-shrink: 0; background: ${T.bg1}; font-size: ${px(FS.xs)}; font-weight: 600; letter-spacing: 0.04em; }
.legend-key { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

/* ── map ── */
.map-body { flex: 1; min-height: 0; position: relative; }
.map-wrap { position: absolute; inset: 0; isolation: isolate; }
.map-canvas { position: absolute; inset: 0; }
.leaflet-container { font-family: ${FONT.ui}; font-size: ${px(FS.sm)}; background: ${T.bg3}; }
.leaflet-container a { color: ${T.blue}; }
/* Tooltips sit in Leaflet's zero-width tooltip pane: without max-content they shrink to one word per line. */
.leaflet-tooltip { font-size: ${px(FS.sm)}; color: ${T.text}; background: ${T.bg1}; border: 1px solid ${T.borderMid}; border-radius: ${px(RADIUS.sm)}; box-shadow: ${SHADOW.pop}; padding: 6px 8px; white-space: normal; width: max-content; max-width: 300px; overflow-wrap: anywhere; }
.leaflet-tooltip.map-label { font-size: ${px(FS.xs)}; padding: 3px 6px; line-height: 1.3; box-shadow: ${SHADOW.card}; white-space: normal; width: max-content; max-width: 200px; overflow-wrap: anywhere; }
.leaflet-popup-content-wrapper { border-radius: ${px(RADIUS.md)}; box-shadow: ${SHADOW.pop}; }
.leaflet-popup-content { margin: 10px 12px; font-size: ${px(FS.sm)}; line-height: 1.45; color: ${T.text}; }
.map-info { display: flex; flex-direction: column; gap: 4px; min-width: 220px; max-width: 280px; font-variant-numeric: tabular-nums; }
.map-info-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.map-info-id { font-size: ${px(FS.md)}; font-weight: 700; color: ${T.textStrong}; }
.map-info-grid { display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; margin: 0; }
.map-info-grid dt { color: ${T.textDim}; font-size: ${px(FS.xs)}; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding-top: 1px; }
.map-info-grid dd { margin: 0; color: ${T.textStrong}; }
.map-label-id { font-weight: 700; color: ${T.textStrong}; }
.map-pulse-ring { animation: map-ring 1.6s ease-out infinite; }
@keyframes map-ring { 0% { stroke-opacity: 0.9; stroke-width: 2px; } 100% { stroke-opacity: 0; stroke-width: 18px; } }
.map-hz-pulse { animation: map-hz 2s ease-in-out infinite; }
@keyframes map-hz { 0%, 100% { fill-opacity: 0.3; stroke-opacity: 0.95; } 50% { fill-opacity: 0.1; stroke-opacity: 0.5; } }
.map-pin { background: none; border: none; }
.map-pin-body { position: absolute; left: 0; top: 0; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: ${T.bg1}; border: 2px solid ${T.bg1}; box-shadow: ${SHADOW.pop}; }
.map-pin-body::after { content: ""; position: absolute; left: 50%; bottom: -9px; transform: translateX(-50%); border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 8px solid ${T.bg1}; }
.map-pin-fire .map-pin-body { background: ${T.redFill}; }
.map-pin-fall .map-pin-body { background: ${T.redFill}; }
.map-pin-still .map-pin-body { background: ${T.amberFill}; }
.map-pin-side .map-pin-body { width: 22px; height: 22px; }
.map-pin-side .map-pin-body::after { display: none; }
.map-pin-side svg { width: 12px; height: 12px; }
.map-cp { background: none; border: none; }
.map-cp-body { display: flex; align-items: center; justify-content: center; width: 36px; height: 26px; border-radius: ${px(RADIUS.sm)}; background: ${T.textStrong}; color: ${T.bg1}; font-size: ${px(FS.sm)}; font-weight: 700; letter-spacing: 0.08em; border: 2px solid ${T.bg1}; box-shadow: ${SHADOW.pop}; cursor: move; }
.map-ctl { position: absolute; top: 10px; right: 10px; z-index: 1100; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-width: calc(100% - 70px); }
.map-ctl-box { background: ${T.bg1}; border: 1px solid ${T.borderMid}; border-radius: ${px(RADIUS.md)}; box-shadow: ${SHADOW.pop}; padding: 6px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.map-ctl-label { font-size: ${px(FS.xs)}; font-weight: 600; letter-spacing: 0.06em; color: ${T.textDim}; padding: 0 4px; text-transform: uppercase; }
.seg-btn { font-size: ${px(FS.sm)}; font-weight: 600; padding: 3px 8px; border-radius: ${px(RADIUS.sm)}; border: 1px solid ${T.border}; background: ${T.bg1}; color: ${T.textMuted}; white-space: nowrap; }
.seg-btn:hover { background: ${T.bg3}; }
.seg-btn[aria-pressed="true"] { background: ${T.blueBg}; border-color: ${T.blueFill}; color: ${T.blue}; }
.map-ctl details { background: ${T.bg1}; border: 1px solid ${T.borderMid}; border-radius: ${px(RADIUS.md)}; box-shadow: ${SHADOW.pop}; max-width: 300px; }
.map-ctl summary { padding: 6px 10px; font-size: ${px(FS.sm)}; font-weight: 600; color: ${T.textMuted}; cursor: pointer; }
.map-ctl-panel { padding: 4px 10px 10px; max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.map-ctl-toggles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 10px; font-size: ${px(FS.sm)}; }
.map-ctl-toggles label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.legend-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 12px; font-size: ${px(FS.xs)}; color: ${T.text}; }
.legend-item { display: flex; align-items: center; gap: 6px; min-width: 0; }
.legend-item > span:last-child { min-width: 0; overflow-wrap: anywhere; }
.legend-sw { width: 24px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; }
.legend-cp { display: inline-flex; align-items: center; justify-content: center; height: 16px; padding: 0 3px; border-radius: 3px; background: ${T.textStrong}; color: ${T.bg1}; font-size: ${px(FS.xs)}; font-weight: 700; letter-spacing: 0.04em; line-height: 1; }
.swatch { width: 14px; height: 14px; border-radius: 50%; border: 2px solid; display: inline-block; }
.swatch-line { width: 16px; height: 4px; border-radius: 2px; display: inline-block; }
.map-overlay-note { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 1050; max-width: 320px; text-align: center; background: ${T.bg1}; border: 1px solid ${T.borderMid}; border-radius: ${px(RADIUS.md)}; box-shadow: ${SHADOW.pop}; padding: 10px 14px; font-size: ${px(FS.sm)}; color: ${T.textMuted}; pointer-events: none; }
.map-overlay-error { position: absolute; left: 10px; right: 10px; bottom: 34px; z-index: 1050; }

/* ── sign-in and access panels ── */
.gate { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; background: ${T.bg0}; }
.gate-card { width: 100%; max-width: 440px; background: ${T.bg1}; border: 1px solid ${T.border}; border-radius: ${px(RADIUS.lg)}; box-shadow: ${SHADOW.pop}; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
.gate-card.is-wide { max-width: 640px; }
.gate-title { margin: 0; font-size: ${px(FS.xxl)}; font-weight: 700; color: ${T.textStrong}; }
.gate-sub { margin: 0; color: ${T.textMuted}; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field label { font-size: ${px(FS.sm)}; font-weight: 600; color: ${T.textMuted}; }
.field-row { display: flex; gap: 6px; }
.input { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid ${T.borderStrong}; border-radius: ${px(RADIUS.sm)}; background: ${T.bg1}; color: ${T.textStrong}; font-size: ${px(FS.md)}; }
.input:focus { outline: 2px solid ${T.blueFill}; outline-offset: 0; border-color: ${T.blueFill}; }
.form-error { font-size: ${px(FS.sm)}; color: ${T.red}; background: ${T.redBg}; border: 1px solid ${T.redFill}; border-radius: ${px(RADIUS.sm)}; padding: 8px 10px; }
.uid-box { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; background: ${T.bg3}; border: 1px solid ${T.border}; border-radius: ${px(RADIUS.sm)}; }
.uid-box code { font-size: ${px(FS.md)}; color: ${T.textStrong}; overflow-wrap: anywhere; }
.steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
.steps code { background: ${T.bg3}; border: 1px solid ${T.border}; border-radius: ${px(RADIUS.sm)}; padding: 0 4px; font-size: ${px(FS.sm)}; }
.access-inline { display: flex; flex-direction: column; gap: 4px; font-size: ${px(FS.sm)}; color: ${T.red}; background: ${T.redBg}; border: 1px solid ${T.redFill}; border-radius: ${px(RADIUS.sm)}; padding: 8px 10px; }
.access-inline code { color: ${T.textStrong}; overflow-wrap: anywhere; }

@media (prefers-reduced-motion: reduce) {
  .resp-card.is-p0, .banner.is-live, .counter.is-blinking .counter-value, .map-pulse-ring, .map-hz-pulse, .spinner { animation: none !important; }
}
`;

export default function GlobalStyles() {
  return <style>{CSS}</style>;
}
