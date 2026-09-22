// Generates the "Clarion Declarative Workspace" artboards (revision 2:
// the CATALOG is the workspace). Run from this folder: `node generate.mjs`
// → project/*.dc.html + project/canvas.json. Every colour, radius, font and
// spacing is an Observatory token (frontend/app/globals.css); the rail, top
// bar, chips and tab styles copy IconRail.tsx / TopBar.tsx / ManageLayer.tsx.
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('project', { recursive: true });

// ── Observatory tokens (frontend/app/globals.css) ─────────────────────────
const T = {
  bg:'#eef0f2', surface:'#f8f9fa', raised:'#ffffff', soft:'#e3e6ea', softer:'#edeff2',
  line:'#d0d5da', lineStrong:'#b8bec5', ink:'#0f1a22', ink2:'#334049', ink3:'#4a5660',
  muted:'#6b7680', muted2:'#8891a0', ocean:'#164e63', oceanHover:'#103d4f',
  oceanSoft:'#d0e1e6', oceanSofter:'#e8f0f3', ai:'#c08a5e', aiSoft:'#f1e4d6', aiInk:'#7a4f2b',
  ok:'#3f7a5c', okSoft:'#dbe8e0', warn:'#a06a1c', warnSoft:'#f1e4c8', err:'#a43a3a', errSoft:'#f1d7d7',
  fact:'#6b4e8c', factSoft:'#ece6f3', grid:'#b45309', gridSoft:'#f6e8dc',
};
const SANS = `Inter, system-ui, sans-serif`;
const SERIF = `"Source Serif 4", Georgia, serif`;
const MONO = `"Geist Mono", ui-monospace, monospace`;

// ── icons (lucide-style, 24 viewBox, stroke 1.5) ──────────────────────────
const P = {
  home:'<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  message:'<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  code:'<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  plug:'<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8z"/>',
  table:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  blocks:'<rect x="14" y="3" width="7" height="7" rx="1"/><path d="M10 21H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6v8z"/><path d="M10 13V4a1 1 0 0 1 1-1h3"/>',
  share:'<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  book:'<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  workflow:'<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/>',
  inbox:'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-7A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1z"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  dollar:'<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  chevron:'<path d="m6 9 6 6 6-6"/>',
  chevronR:'<path d="m9 6 6 6-6 6"/>',
  sparkles:'<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  x:'<path d="M18 6 6 18M6 6l12 12"/>',
  database:'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  sheet:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8M8 9h2"/>',
  arrowR:'<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  branch:'<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6"/><path d="M18 15V9a3 3 0 0 0-3-3H9"/>',
  play:'<path d="m6 4 14 8-14 8z"/>',
  landmark:'<path d="M3 22h18"/><path d="M6 18v-7M10 18v-7M14 18v-7M18 18v-7"/><path d="M12 2 2 8h20z"/>',
  receipt:'<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M8 7h8M8 11h8M12 15h4"/>',
  cart:'<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2 2h3l2.7 12.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  history:'<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 3"/>',
  link:'<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19.5"/>',
  quote:'<path d="M3 21c3 0 7-1 7-8V5H3v8h4c0 4-2 6-4 6z"/><path d="M15 21c3 0 7-1 7-8V5h-7v8h4c0 4-2 6-4 6z"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  bell:'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  pencil:'<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  alert:'<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  more:'<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  external:'<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
};
const ico = (n, s=16, c='currentColor', sw=1.5) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;display:block">${P[n]}</svg>`;

// ── connector marks (frontend/lib/connectorIcons.tsx, same paths + hexes) ──
// "for source data I want to have the symbol of the source as the catalog"
const MARKS = {
  exactonline: { color:'#E4002B', paths:[
    'M5 2.4h14a2.6 2.6 0 0 1 2.6 2.6v14a2.6 2.6 0 0 1-2.6 2.6H5A2.6 2.6 0 0 1 2.4 19V5A2.6 2.6 0 0 1 5 2.4Zm0 1.7A.9.9 0 0 0 4.1 5v14a.9.9 0 0 0 .9.9h14a.9.9 0 0 0 .9-.9V5a.9.9 0 0 0-.9-.9Z',
    'M8.3 6.6h7.4v1.9h-5.3v2.6h4.7v1.9h-4.7v2.6h5.3v1.9H8.3Z' ] },
  odoo: { color:'#714B67', paths:[
    'M21.1002 15.7957c-1.6015 0-2.8997-1.2983-2.8997-2.8998s1.2983-2.8997 2.8997-2.8997c1.6015 0 2.8998 1.2982 2.8998 2.8997 0 1.5999-1.2979 2.8998-2.8998 2.8998zm0-1.2c.9388.0006 1.7003-.7601 1.7008-1.6989.0004-.9388-.7602-1.7003-1.699-1.7007h-.0018c-.9388.0004-1.6994.7619-1.699 1.7007.0005.9381.761 1.6985 1.699 1.699zm-6.0655 1.2c-1.6014 0-2.8997-1.2983-2.8997-2.8998s1.2983-2.8997 2.8997-2.8997c1.6015 0 2.8998 1.2982 2.8998 2.8997 0 1.5999-1.2999 2.8998-2.8998 2.8998zm0-1.2c.9389.0006 1.7003-.7601 1.7008-1.6989.0005-.9388-.7602-1.7003-1.699-1.7007h-.0018c-.9388.0004-1.6994.7619-1.699 1.7007.0005.9381.761 1.6985 1.699 1.699zM11.865 12.858c0 1.6199-1.2979 2.9378-2.8977 2.9378s-2.8998-1.314-2.8998-2.9358 1.1799-2.8597 2.8998-2.8597c.6359 0 1.2239.134 1.6998.484v-1.68a.6.6 0 0 1 1.2 0v4.0537h-.002zm-2.8977 1.7399c.9388.0005 1.7002-.7602 1.7007-1.699.0005-.9388-.7602-1.7003-1.699-1.7007h-.0017c-.9389.0004-1.6995.7619-1.699 1.7007.0004.9381.7608 1.6985 1.699 1.699zm-6.0675 1.1979C1.2983 15.7957 0 14.4974 0 12.8959s1.2983-2.8997 2.8998-2.8997 2.8997 1.2982 2.8997 2.8997c0 1.5999-1.2999 2.8998-2.8997 2.8998zm0-1.2c.9388.0006 1.7002-.7601 1.7007-1.699.0005-.9387-.7602-1.7002-1.699-1.7006h-.0017c-.9388.0004-1.6995.7619-1.699 1.7007.0004.9381.7608 1.6985 1.699 1.699z' ] },
  excel: { color:'#217346', paths:[
    'M21.17 3.25q.33 0 .59.25q.24.24.24.58v15.84q0 .34-.24.58q-.26.25-.59.25H7.83q-.33 0-.59-.25q-.24-.24-.24-.58V17H2.83q-.33 0-.59-.24Q2 16.5 2 16.17V7.83q0-.33.24-.59Q2.5 7 2.83 7H7V4.08q0-.34.24-.58q.26-.25.59-.25M7 13.06l1.18 2.22h1.79L8 12.06l1.93-3.17H8.22L7.13 10.9l-.04.06l-.03.07q-.26-.53-.56-1.07q-.25-.53-.53-1.07H4.16l1.89 3.19L4 15.28h1.78m8.1 4.22V17H8.25v2.5m5.63-3.75v-3.12H12v3.12m1.88-4.37V8.25H12v3.13M13.88 7V4.5H8.25V7m12.5 12.5V17h-5.62v2.5m5.62-3.75v-3.12h-5.62v3.12m5.62-4.37V8.25h-5.62v3.13M20.75 7V4.5h-5.62V7Z' ] },
};
const MARK_LABEL = { exactonline:'Exact Online', odoo:'Odoo', excel:'Excel' };
function mark(id, size=14, {tile=true}={}) {
  const m = MARKS[id];
  const svg = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${m.color}" style="display:block;flex-shrink:0">${m.paths.map(d=>`<path d="${d}"/>`).join('')}</svg>`;
  if (!tile) return svg;
  const box = Math.round(size * 1.7);
  return `<span style="width:${box}px;height:${box}px;border-radius:${box>26?8:5}px;background:${m.color}14;border:1px solid ${m.color}2E;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${svg}</span>`;
}

// ── page wrapper ───────────────────────────────────────────────────────────
function page(title, w, h, body, extraCss='') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;1,8..60,400&family=Geist+Mono:wght@400;500&display=swap">
<style>
body{margin:0;background:${T.bg};color:${T.ink};font-family:${SANS};-webkit-font-smoothing:antialiased;font-feature-settings:"ss01","cv11"}
a{color:${T.ocean};text-decoration:none}a:hover{color:${T.oceanHover}}
.eyebrow{font-family:${MONO};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${T.muted2};font-weight:500}
.mono{font-family:${MONO}}
.serif{font-family:${SERIF}}
.chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11px;font-family:${MONO};letter-spacing:0.04em;line-height:1.6;white-space:nowrap}
.btn{display:inline-flex;align-items:center;gap:6px;border:1px solid ${T.line};background:${T.raised};color:${T.ink};font:500 13px ${SANS};padding:7px 12px;border-radius:6px;cursor:pointer;line-height:1.3;white-space:nowrap}
.btn-primary{background:${T.ocean};border-color:${T.ocean};color:#fff}
.btn-primary:disabled{opacity:.45}
.btn-ghost{border-color:transparent;background:transparent;color:${T.ink3}}
.row{display:flex;align-items:center}
.card{background:${T.raised};border:1px solid ${T.line};border-radius:10px}
.k{color:#7dd3fc}.s{color:#fde68a}.f{color:#c4b5fd}.c{color:#8891a0}
${extraCss}
</style>
</helmet>
${body}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>
class Component extends DCLogic { renderVals() { return {}; } }
</script>
</body>
</html>
`;
}

// ── chrome ─────────────────────────────────────────────────────────────────
function topbar() {
  return `<div style="height:48px;box-sizing:border-box;background:${T.raised};border-bottom:1px solid ${T.line};display:flex;align-items:center;gap:12px;padding:0 16px;flex-shrink:0">
  <div class="row" style="gap:8px">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${T.ocean}" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="${T.ocean}"/></svg>
    <span class="serif" style="font-size:17px;font-weight:500;letter-spacing:-0.02em">Clarion</span>
  </div>
  <div style="flex:1"></div>
  <div class="row" style="gap:8px;height:32px;border:1px solid ${T.line};background:${T.surface};border-radius:6px;padding:0 10px;width:320px;color:${T.muted};font-size:12.5px">${ico('search',13,T.muted2)}<span style="flex:1">Search or ask…</span><kbd class="mono" style="font-size:10px;border:1px solid ${T.line};border-radius:4px;padding:1px 5px;background:${T.raised}">⌘K</kbd></div>
  <div style="flex:1"></div>
  ${ico('bell',16,T.ink3)}
  <div style="width:26px;height:26px;border-radius:999px;background:${T.oceanSofter};color:${T.ocean};font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center">AV</div>
</div>`;
}

function railRow(icon, label, active=false, badge='') {
  const st = active
    ? `border-left:2px solid ${T.ocean};background:${T.raised};color:${T.ink};font-weight:500`
    : `border-left:2px solid transparent;color:${T.ink2}`;
  return `<a href="#" style="display:flex;align-items:center;gap:8px;padding:9px 12px 9px 14px;font-size:14px;${st}">${ico(icon,16,active?T.ocean:T.muted)}<span style="flex:1">${label}</span>${badge?`<span class="mono" style="min-width:20px;height:18px;border-radius:999px;font-size:10px;display:inline-flex;align-items:center;justify-content:center;background:${T.raised};color:${T.ink3};border:1px solid ${T.line}">${badge}</span>`:''}</a>`;
}
function eyebrowRow(label) {
  return `<div class="eyebrow row" style="gap:6px;padding:14px 16px 6px;margin-top:4px">${label}<span style="flex:1"></span>${ico('chevron',12,T.muted2)}</div>`;
}
// Studio today vs proposed. Proposed: six entries, one job each. Build and
// Suggestions fold into Catalog (the badge = 2 need attention + 28 to review);
// Definitions is the glossary as its own pane.
function rail(active, {before=false}={}) {
  const studio = before
    ? [['plug','Sources','sources','1'],['table','Your tables','grids'],['blocks','Build','build'],['share','Relations','relations'],['book','Catalog','catalog'],['workflow','Refresh','refresh'],['inbox','Suggestions','review','28']]
    : [['plug','Sources','sources','1'],['book','Catalog','catalog','30'],['quote','Definitions','definitions'],['table','Your tables','grids'],['share','Relations','relations'],['workflow','Refresh','refresh']];
  return `<div style="width:220px;flex-shrink:0;box-sizing:border-box;background:${T.soft};border-right:1px solid ${T.line};display:flex;flex-direction:column;padding:8px 0">
  ${railRow('home','Home',active==='home')}
  ${eyebrowRow('Uncover')}
  ${railRow('message','Ask',active==='ask')}
  ${railRow('grid','Dashboards',active==='dashboards')}
  ${railRow('search','Investigate',active==='investigate')}
  ${railRow('layers','Subjects',active==='subjects')}
  ${railRow('code','Notebooks',active==='notebooks')}
  ${eyebrowRow('Studio')}
  ${studio.map(([i,l,k,b])=>railRow(i,l,active===k,b)).join('')}
  ${eyebrowRow('Settings')}
  <div style="flex:1"></div>
  <div class="mono" style="border-top:1px solid ${T.line};padding:10px 16px;font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:${T.muted}">Collapse</div>
</div>`;
}
function shell(active, content) {
  return `<div style="width:1440px;height:900px;box-sizing:border-box;display:flex;flex-direction:column;background:${T.bg};overflow:hidden;font-family:${SANS}">
${topbar()}
<div style="flex:1;display:flex;min-height:0">
${rail(active)}
${content}
</div></div>`;
}

// ── the tree (one view on the left; sources by their mark) ─────────────────
const dot = (c) => `<span style="width:7px;height:7px;border-radius:999px;background:${c};display:inline-block;flex-shrink:0"></span>`;
const stOk = `<span title="built">${dot(T.ok)}</span>`;
const stWarn = `<span title="needs attention" style="display:inline-flex">${ico('alert',13,T.warn,1.8)}</span>`;
const stBuild = `<span title="building" style="width:9px;height:9px;border-radius:999px;border:1.5px dashed ${T.ocean};display:inline-block;flex-shrink:0"></span>`;
const stReview = (n) => `<span class="mono" title="${n} meanings to review" style="font-size:10px;color:${T.aiInk};background:${T.aiSoft};border-radius:999px;padding:0 6px;line-height:1.6">${n}</span>`;
const stFeeds = (n) => `<span class="mono" title="feeds ${n} tables" style="font-size:10.5px;color:${T.muted2}">→ ${n}</span>`;

function treeRow(label, {kind='fact', sel=false, status='', indent=1, muted=false}={}) {
  const color = kind==='fact'?T.fact:kind==='dim'?T.ocean:kind==='grid'?T.grid:T.muted2;
  const glyph = kind==='fact'?'▣':kind==='dim'?'◇':kind==='grid'?'▤':'·';
  const pad = 14 + indent*14;
  return `<div style="display:flex;align-items:center;gap:8px;padding:6px 12px 6px ${pad}px;font-size:13px;border-left:2px solid ${sel?T.ocean:'transparent'};background:${sel?T.raised:'transparent'};color:${muted?T.muted:T.ink2};${sel?'font-weight:500;color:'+T.ink:''}">
    <span class="mono" style="font-size:12.5px;color:${color};flex-shrink:0;width:10px;text-align:center">${glyph}</span>
    <span class="mono" style="font-size:12.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span>
    ${status}
  </div>`;
}
function groupRow(label, glyph, {open=false, sel=false, status='', indent=0}={}) {
  const pad = 14 + indent*14;
  return `<div style="display:flex;align-items:center;gap:8px;padding:7px 12px 7px ${pad}px;font-size:13.5px;border-left:2px solid ${sel?T.ocean:'transparent'};background:${sel?T.raised:'transparent'};color:${T.ink};${sel?'font-weight:500':''}">
    ${ico(open?'chevron':'chevronR',12,T.muted2)}${ico(glyph,15,sel?T.ocean:T.ink3)}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span>${status}</div>`;
}
function sourceRow(label, markId, {open=false, sel=false, count=''}={}) {
  return `<div style="display:flex;align-items:center;gap:8px;padding:6px 12px 6px 14px;font-size:13.5px;border-left:2px solid ${sel?T.ocean:'transparent'};background:${sel?T.raised:'transparent'};color:${T.ink};${sel?'font-weight:500':''}">
    ${ico(open?'chevron':'chevronR',12,T.muted2)}${mark(markId,13)}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span><span class="mono" style="font-size:10.5px;color:${T.muted2}">${count}</span></div>`;
}
function eyebrowGroup(label, {note='', open=true, count=''}={}) {
  return `<div class="eyebrow row" style="padding:14px 16px 4px;gap:6px">${open?'':ico('chevronR',10,T.muted2)}${label}${note?`<span style="font-weight:400;letter-spacing:0;text-transform:none;font-family:${SANS};font-size:11px">· ${note}</span>`:''}<span style="flex:1"></span>${count?`<span style="letter-spacing:0">${count}</span>`:''}</div>`;
}

// state: which node is selected, which groups are open
function tree({selected=null, subjectSel=null, sourceSel=null, srcTableSel=null, financeOpen=true, sharedOpen=true, eoOpen=false, odooOpen=false}={}) {
  const eoTables = [['TransactionLines',12480,2,12],['SalesInvoiceLines',8102,1,0],['Accounts',1289,1,9],['GLAccounts',412,1,7],['Journals',18,1,0],['PaymentConditions',12,1,0],['Receivables',611,1,0]];
  return `<div style="width:260px;flex-shrink:0;box-sizing:border-box;background:${T.surface};border-right:1px solid ${T.line};display:flex;flex-direction:column;overflow:hidden">
  <div style="padding:12px 12px 8px">
    <div class="row" style="gap:8px;height:32px;border:1px solid ${T.line};background:${T.raised};border-radius:6px;padding:0 10px;color:${T.muted2};font-size:12.5px">${ico('search',13,T.muted2)}Find a table, subject or source…</div>
  </div>
  <div style="flex:1;overflow:auto;padding-bottom:12px">
    ${eyebrowGroup('Subjects')}
    ${groupRow('Finance','landmark',{open:financeOpen, sel:subjectSel==='finance', status: subjectSel==='finance'?'':stOk})}
    ${financeOpen ? `
    ${treeRow('fact_transaction_lines',{sel:selected==='fact_transaction_lines', status: selected==='fact_transaction_lines'?'':stOk, indent:2})}
    ${treeRow('fact_receivables',{indent:2, status:stWarn})}
    ${treeRow('fact_payables',{indent:2, status:stOk})}` : ''}
    ${groupRow('Sales','receipt',{status:stOk})}
    ${groupRow('Purchasing','cart',{status:stBuild})}
    ${eyebrowGroup('Shared data',{open:sharedOpen, count: sharedOpen?'':'7'})}
    ${sharedOpen ? `
    ${treeRow('dim_account',{kind:'dim',status:stOk})}
    ${treeRow('dim_item',{kind:'dim',status:stWarn})}
    ${treeRow('dim_item_group',{kind:'dim',status:stOk})}
    ${treeRow('dim_gl_account',{kind:'dim',status:stOk})}
    ${treeRow('dim_journal',{kind:'dim',status:stOk})}
    ${treeRow('dim_payment_condition',{kind:'dim',status:stOk})}
    ${treeRow('dim_date',{kind:'dim',status:stOk})}` : ''}
    ${eyebrowGroup('Your tables')}
    ${treeRow('budget_2026',{kind:'grid',status:`<span title="linked to Finance" style="display:inline-flex">${ico('link',12,T.grid)}</span>`})}
    ${eyebrowGroup('Sources',{note:'read-only inputs'})}
    ${sourceRow('Exact Online','exactonline',{open:eoOpen, sel:sourceSel==='eo', count: eoOpen?'':'7 of 61'})}
    ${eoOpen ? eoTables.map(([n,r,f,rv])=>`<div style="display:flex;align-items:center;gap:8px;padding:5px 12px 5px 44px;font-size:12.5px;border-left:2px solid ${srcTableSel===n?T.ocean:'transparent'};background:${srcTableSel===n?T.raised:'transparent'};color:${srcTableSel===n?T.ink:T.ink2};${srcTableSel===n?'font-weight:500':''}"><span class="mono" style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${n}</span>${rv?stReview(rv):''}${stFeeds(f)}</div>`).join('') + `<div style="padding:5px 12px 6px 44px;font-size:11.5px;color:${T.muted}">54 more, not synced · <a href="#">pick them on Sources</a></div>` : ''}
    ${sourceRow('Odoo (staging)','odoo',{open:odooOpen, sel:sourceSel==='odoo', count:'21'})}
    ${sourceRow('Budget 2026.xlsx','excel',{count:'3'})}
  </div>
  <div style="border-top:1px solid ${T.line};padding:10px 12px">
    <button class="btn" style="width:100%;justify-content:center">${ico('plus',14,T.ink3)}Add a subject</button>
  </div>
</div>`;
}

// ── SQL rendering — lines as [text, kind]; kind '' | 'add' | 'del' ──────────
const SQL_LINES = [
  ['<span class="k">SELECT</span>'],
  ['  tl.ID                       <span class="k">AS</span> transaction_line_id,'],
  ['  <span class="f">TRY_CAST</span>(tl.Date <span class="k">AS DATE</span>)  <span class="k">AS</span> transaction_date,'],
  ['  tl.GLAccountCode            <span class="k">AS</span> gl_account_code,'],
  ['  tl.AccountCode              <span class="k">AS</span> account_code,'],
  ['  tl.JournalCode              <span class="k">AS</span> journal_code,'],
  ['  tl.AmountDC                 <span class="k">AS</span> amount_dc,'],
  ['  tl.VATAmountDC              <span class="k">AS</span> vat_amount_dc,'],
  ['  tl.Description              <span class="k">AS</span> description'],
  ['<span class="k">FROM</span> TransactionLines tl'],
  ['<span class="k">WHERE</span> tl.Status = <span class="s">50</span>               <span class="c">-- processed entries only</span>'],
];
function sqlEditor(lines, {diff=false}={}) {
  const rows = lines.map(([txt, kind], i) => {
    let bg='transparent', mk='&nbsp;', mc=T.muted2;
    if (kind==='add') { bg='rgba(63,122,92,0.22)'; mk='+'; mc='#86efac'; }
    if (kind==='del') { bg='rgba(164,58,58,0.25)'; mk='−'; mc='#fca5a5'; }
    return `<div style="display:flex;background:${bg}"><span style="width:34px;text-align:right;padding-right:10px;color:rgba(255,255,255,0.28);user-select:none;flex-shrink:0">${kind==='add'?'':i+1}</span><span style="width:12px;color:${mc};flex-shrink:0">${mk}</span><span style="white-space:pre;color:#e6edf3">${txt}</span></div>`;
  }).join('');
  return `<div class="mono" style="background:${T.ink};border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px 10px;font-size:12.5px;line-height:1.7;overflow:auto">${rows}</div>`;
}

// ── column rows ─────────────────────────────────────────────────────────────
const COLS_GRID = '168px 66px 128px 1fr';
function columnRow(name, type, role, extra='', {grid=COLS_GRID}={}) {
  const rc = role==='measure'?[T.factSoft,T.fact]:(role==='key'||role==='fk')?[T.oceanSofter,T.ocean]:[T.softer,T.ink3];
  const rl = role==='fk'?'→ '+extra:role;
  return `<div style="display:grid;grid-template-columns:${grid};gap:10px;align-items:center;padding:7px 12px;border-top:1px solid ${T.softer};font-size:13px">
    <span class="mono" style="font-size:12.5px">${name}</span>
    <span class="mono" style="font-size:11px;color:${T.muted}">${type}</span>
    <span><span class="chip" style="background:${rc[0]};color:${rc[1]}">${rl}</span></span>
    <span style="color:${T.ink3};line-height:1.45">${role==='fk'?'':extra}</span>
  </div>`;
}
const colsHeader = (grid=COLS_GRID) => `<div style="display:grid;grid-template-columns:${grid};gap:10px;padding:6px 12px;background:${T.surface}" class="eyebrow"><span>Column</span><span>Type</span><span>Role</span><span>Meaning</span></div>`;
const teamChip = (word, {short=false}={}) => `<span class="chip" title="your team calls this ${word}" style="background:${T.oceanSofter};color:${T.ocean}">${ico('quote',10,T.ocean)} ${short?'team':'your team calls this'}: “${word}”</span>`;
// an AI-drafted meaning waiting for a yes: the review job, inline
const draft = (text) => `<span style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;line-height:1.4"><span style="display:inline-flex;align-items:center;gap:5px;background:${T.aiSoft};color:${T.aiInk};border-radius:4px;padding:2px 7px;font-size:12.5px">${ico('sparkles',11,T.ai)}${text}</span><a href="#" style="font-size:12px;font-weight:500">Keep</a><a href="#" style="font-size:12px;color:${T.muted}">Discard</a></span>`;

function lineageNode(label, sub, {kind='src', current=false, markId=null}={}) {
  const col = kind==='fact'?T.fact:kind==='dim'?T.ocean:kind==='grid'?T.grid:T.muted;
  return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid ${current?T.ocean:T.line};border-left:3px solid ${col};background:${current?T.oceanSofter:T.raised};border-radius:6px">
    ${markId?mark(markId,12,{tile:false}):''}<div style="flex:1;min-width:0"><div class="mono" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${current?'font-weight:500':''}">${label}</div>${sub?`<div style="font-size:11px;color:${T.muted}">${sub}</div>`:''}</div></div>`;
}
const vline = `<div style="width:1px;height:10px;background:${T.lineStrong};margin:0 auto"></div>`;
const ctxCol = (inner) => `<div style="width:300px;flex-shrink:0;box-sizing:border-box;border-left:1px solid ${T.line};background:${T.surface};overflow:auto;padding:16px 16px 24px;display:flex;flex-direction:column;gap:22px">${inner}</div>`;
const kv = (k, v) => `<div class="row" style="justify-content:space-between;font-size:12.5px;gap:10px"><span>${k}</span><span style="text-align:right">${v}</span></div>`;
const hist = (who, what, when, sub='') => `<div><span style="color:${T.ink}">${who}</span> ${what} <span class="mono" style="font-size:11px;color:${T.muted}">· ${when}</span>${sub?`<div style="color:${T.muted}">${sub}</div>`:''}</div>`;

function contextCol() {
  return ctxCol(`
  <div>
    <div class="eyebrow" style="margin-bottom:8px">Lineage</div>
    <div style="display:flex;flex-direction:column">
      ${lineageNode('TransactionLines','Exact Online · 8 columns read',{markId:'exactonline'})}
      <div style="height:6px"></div>
      ${lineageNode('GLAccounts','Exact Online · joined for the account type',{markId:'exactonline'})}
      ${vline}
      ${lineageNode('fact_transaction_lines','this table',{kind:'fact',current:true})}
      ${vline}
      ${lineageNode('dim_gl_account','joins on gl_account_code',{kind:'dim'})}
      <div style="height:6px"></div>
      ${lineageNode('dim_account · dim_journal · dim_date','3 more joins',{kind:'dim'})}
      <div style="height:6px"></div>
      ${lineageNode('budget_2026','your table · linked on gl_account_code',{kind:'grid'})}
    </div>
    <div style="margin-top:10px;font-size:12.5px;color:${T.ink3};line-height:1.5"><span style="color:${T.ink};font-weight:500">Used by</span> 2 dashboards · 6 saved questions · the Finance topic page</div>
  </div>
  <div>
    <div class="eyebrow" style="margin-bottom:8px">Health</div>
    <div class="card" style="padding:10px 12px;display:flex;flex-direction:column;gap:8px">
      ${kv('Built 3 min ago',`<span class="mono" style="font-size:11px;color:${T.muted}">12,480 rows</span>`)}
      <svg width="266" height="34" viewBox="0 0 266 34"><polyline fill="none" stroke="${T.ok}" stroke-width="1.5" points="0,26 30,25 60,25 90,24 120,25 150,23 180,24 210,22 240,21 266,20"/><polyline fill="none" stroke="${T.warn}" stroke-width="1.5" points="0,31 30,31 60,30 90,31 120,30 150,31 180,29 210,31 240,30 266,30"/></svg>
      <div class="row" style="gap:12px;font-size:11.5px;color:${T.ink3}"><span>${dot(T.ok)} +36 inserted</span><span>${dot(T.warn)} 2 updated</span><span>0 deleted</span></div>
      <div style="border-top:1px solid ${T.softer};padding-top:8px;display:flex;flex-direction:column;gap:6px">
        ${kv('Checks',`<span style="color:${T.ok};font-weight:500">4 of 4 passing</span>`)}
        ${kv('Refresh schedule','<a href="#" style="font-size:12px">nightly 02:00 · on Refresh</a>')}
      </div>
    </div>
  </div>
  <div>
    <div class="eyebrow" style="margin-bottom:8px">History</div>
    <div style="display:flex;flex-direction:column;gap:9px;font-size:12.5px;color:${T.ink3};line-height:1.45">
      ${hist('You','kept the assistant’s change','3 min ago','excluded the closing journal')}
      ${hist('Ines','rewrote the description','12 Sep')}
      ${hist('Clarion','built it from the Exact Online template','11 Sep')}
    </div>
  </div>`);
}

function assistantPill(label='Ask or change this table') {
  return `<div style="position:absolute;bottom:20px;right:20px;display:flex;align-items:center;gap:8px;padding:10px 16px 10px 12px;border-radius:999px;border:1px solid ${T.line};background:${T.raised};box-shadow:0 6px 24px -8px rgba(15,32,45,0.30);font-size:13px;color:${T.ink2}">${ico('sparkles',15,T.ocean)}${label}</div>`;
}

// ── a subject table's declaration ──────────────────────────────────────────
function tableDeclaration({diff=false, saveEnabled=false}={}) {
  const lines = diff
    ? [...SQL_LINES.slice(0,10), [SQL_LINES[10][0],'del'], ['<span class="k">WHERE</span> tl.Status = <span class="s">50</span>               <span class="c">-- processed entries only</span>','add'], ['  <span class="k">AND</span> tl.JournalCode &lt;&gt; <span class="s">\'90\'</span>      <span class="c">-- year-end closing journal</span>','add']]
    : SQL_LINES;
  return `<div style="flex:1;min-width:0;overflow:auto;padding:22px 32px 40px;position:relative">
  <div class="row" style="gap:8px;margin-bottom:4px">
    <span class="eyebrow">Finance</span><span class="eyebrow">›</span><span class="eyebrow" style="color:${T.fact}">Measures table</span>
  </div>
  <div class="row" style="gap:14px;margin-bottom:6px">
    <h1 class="mono" style="margin:0;font-size:22px;font-weight:500;letter-spacing:-0.01em">fact_transaction_lines</h1>
    <span style="flex:1"></span>
    <button class="btn btn-ghost">${ico('play',13,T.ink3)}Preview 12 rows</button>
    ${diff
      ? `<button class="btn btn-primary" disabled>Save</button>`
      : `<button class="btn btn-primary" ${saveEnabled?'':'disabled'}>Save</button>`}
    <button class="btn btn-ghost" aria-label="More" style="padding:7px 8px">${ico('more',15,T.ink3)}</button>
  </div>
  <div class="row" style="gap:14px;font-size:12.5px;color:${T.ink3};margin-bottom:22px">
    <span class="row" style="gap:6px">${dot(T.ok)} Built 3 min ago</span><span>·</span><span>12,480 rows</span><span>·</span><span>checks 4 of 4</span><span>·</span><span>declared by you</span>
  </div>

  <div style="display:grid;grid-template-columns:150px 1fr;gap:10px 20px;align-items:baseline;margin-bottom:22px;max-width:820px">
    <div class="eyebrow">What one row is</div>
    <div style="font-size:14.5px;line-height:1.5;border-bottom:1px dashed ${T.line};padding-bottom:4px">One processed general-ledger transaction line, in the division currency.</div>
    <div class="eyebrow">Description</div>
    <div style="font-size:14.5px;line-height:1.55;color:${T.ink2};border-bottom:1px dashed ${T.line};padding-bottom:4px">Every posted journal entry line from Exact Online, with the amount in EUR and the GL account, customer/supplier account and journal it was posted to. Credit notes arrive natively negative — no sign is flipped here.</div>
  </div>

  <div class="row" style="gap:10px;margin-bottom:8px">
    <div class="eyebrow">SQL — the declaration</div>
    <span style="flex:1"></span>
    <span style="font-size:11.5px;color:${T.muted}">DuckDB · source tables by their Exact Online names</span>
  </div>
  ${diff ? `
  <div style="border:1px solid ${T.aiSoft};border-radius:8px;overflow:hidden;box-shadow:0 0 0 3px ${T.aiSoft}">
    <div class="row" style="gap:10px;padding:8px 12px;background:${T.aiSoft};font-size:12.5px">
      ${ico('sparkles',14,T.ai)}<span style="font-weight:500;color:${T.aiInk}">Suggested change</span><span class="mono" style="font-size:11px;color:${T.aiInk}">+2 −1</span>
      <span style="color:${T.aiInk}">— exclude journal 90, the year-end closing journal, so month totals stop double-counting the close.</span>
      <span style="flex:1"></span>
      <button class="btn" style="padding:5px 10px;font-size:12.5px">Discard</button>
      <button class="btn btn-primary" style="padding:5px 12px;font-size:12.5px;background:${T.ai};border-color:${T.ai}">${ico('check',13,'#fff')}Keep</button>
    </div>
    ${sqlEditor(lines,{diff:true})}
  </div>` : sqlEditor(lines)}
  <div style="font-size:12px;color:${T.muted};margin:8px 0 26px">Saving validates the SQL against your warehouse, then rebuilds this table and the 4 tables that read from it. Nothing else to press.</div>

  <div class="row" style="gap:10px;margin-bottom:8px">
    <div class="eyebrow">Columns — derived by Clarion</div>
    <span style="flex:1"></span><span style="font-size:11.5px;color:${T.muted}">8 columns + 1 technical · meanings editable</span>
  </div>
  <div class="card" style="overflow:hidden">
    ${colsHeader()}
    ${columnRow('transaction_line_id','VARCHAR','key','The line’s own id in Exact Online.')}
    ${columnRow('transaction_date','DATE','fk','dim_date')}
    ${columnRow('gl_account_code','VARCHAR','fk','dim_gl_account')}
    ${columnRow('account_code','VARCHAR','fk','dim_account')}
    ${columnRow('journal_code','VARCHAR','fk','dim_journal')}
    ${columnRow('amount_dc','DOUBLE','measure',`Amount in EUR, additive. ${teamChip('net booking')}`)}
    ${columnRow('vat_amount_dc','DOUBLE','measure','VAT part of the amount, additive.')}
    ${columnRow('description','VARCHAR','attribute','Free text from the booking.')}
    <div style="padding:7px 12px;border-top:1px solid ${T.softer};font-size:12px;color:${T.muted}">+ 1 technical column, hidden from answers</div>
  </div>
  ${diff ? '' : assistantPill()}
</div>`;
}

// ── Board 1: Catalog — a subject table selected ────────────────────────────
writeFileSync('project/Main.dc.html', page('Catalog — a table’s declaration', 1440, 900,
  shell('catalog', `${tree({selected:'fact_transaction_lines'})}${tableDeclaration()}${contextCol()}`)));

// ── Board 2: Catalog — the assistant proposes a diff ───────────────────────
function assistantOpen() {
  return `<div style="position:absolute;bottom:20px;right:20px;width:380px;max-height:560px;display:flex;flex-direction:column;border-radius:14px;border:1px solid ${T.line};background:${T.raised};box-shadow:0 16px 48px -16px rgba(15,32,45,0.38);overflow:hidden">
  <div class="row" style="padding:10px 16px;border-bottom:1px solid ${T.line};background:${T.soft};gap:10px"><span class="eyebrow">Assistant</span><span style="flex:1"></span>${ico('x',14,T.muted)}</div>
  <div class="row" style="padding:8px 16px;background:${T.oceanSofter};gap:8px;font-size:12px;color:${T.ocean}">${ico('branch',13,T.ocean)}About: <span class="mono">fact_transaction_lines</span> <span style="flex:1"></span><span style="color:${T.muted}">change ▾</span></div>
  <div style="padding:14px 16px;display:flex;flex-direction:column;gap:14px;overflow:auto">
    <div class="serif" style="font-style:italic;font-size:13.5px;text-align:right;color:${T.ink2}">Month totals include the year-end close. Leave those out.</div>
    <div style="font-size:13px;line-height:1.55;color:${T.ink2}">
      <p style="margin:0 0 8px">Exact Online books the year-end close on journal <span class="mono">90</span> (Exact’s docs call it the <em>closing journal</em>; it is referenced by <span class="mono">Code</span>). I checked: 1,148 of your 12,480 lines are on it, all dated 31 Dec.</p>
      <p style="margin:0 0 8px">I’ve put the change on the SQL — one extra condition, nothing else moves. Keep it and I’ll rebuild this table and the four that read from it.</p>
      <div class="row" style="gap:6px;font-size:12px;color:${T.muted}">${ico('check',12,T.ok)} Previewed: 11,332 rows, same columns</div>
    </div>
    <div style="border-top:1px solid ${T.softer};padding-top:10px;font-size:12px;color:${T.muted}">Earlier · <span style="color:${T.ink3}">“What does AmountDC mean?”</span> · answered from the vendor docs</div>
  </div>
  <div style="padding:10px 12px;border-top:1px solid ${T.line}">
    <div class="row" style="gap:8px;border:1px solid ${T.line};border-radius:8px;padding:8px 10px;font-size:13px;color:${T.muted2}"><span style="flex:1">Ask, or say what to change…</span><span style="width:26px;height:26px;border-radius:6px;background:${T.ocean};display:flex;align-items:center;justify-content:center">${ico('arrowR',13,'#fff')}</span></div>
  </div>
</div>`;
}
writeFileSync('project/Catalog-Diff.dc.html', page('Catalog — the assistant proposes a change', 1440, 900,
  shell('catalog', `${tree({selected:'fact_transaction_lines'})}<div style="flex:1;min-width:0;display:flex;position:relative">${tableDeclaration({diff:true})}${contextCol()}${assistantOpen()}</div>`)));

// ── Board 3: Catalog — nothing selected: what needs you ───────────────────
function landing() {
  const tile = (n, label, sub, color, glyph) => `<div class="card" style="padding:14px 16px;display:flex;flex-direction:column;gap:4px;min-width:0">
    <div class="row" style="gap:8px"><span class="serif" style="font-size:28px;font-weight:400;letter-spacing:-0.02em;line-height:1">${n}</span>${glyph}</div>
    <div style="font-size:13.5px;font-weight:500;color:${color}">${label}</div>
    <div style="font-size:12px;color:${T.muted};line-height:1.45">${sub}</div></div>`;
  const attn = (tbl, kind, text) => `<a href="#" style="display:flex;gap:12px;padding:11px 14px;border-top:1px solid ${T.softer};color:${T.ink};align-items:flex-start">
    <span style="padding-top:2px">${ico('alert',15,T.warn,1.8)}</span><div style="flex:1;min-width:0;font-size:13.5px;line-height:1.5"><span class="mono" style="font-size:12.5px;font-weight:500">${tbl}</span> <span class="chip" style="background:${kind==='fact'?T.factSoft:T.oceanSofter};color:${kind==='fact'?T.fact:T.ocean}">${kind==='fact'?'measures':'lookup'}</span><div style="color:${T.ink3}">${text}</div></div><span style="font-size:12.5px;color:${T.ocean};white-space:nowrap;padding-top:2px">Open →</span></a>`;
  const rev = (tbl, n) => `<a href="#" class="row" style="gap:10px;padding:10px 14px;border-top:1px solid ${T.softer};color:${T.ink}">${mark('exactonline',12,{tile:false})}<span class="mono" style="font-size:12.5px;flex:1">${tbl}</span><span style="font-size:12.5px;color:${T.ink3}">${n} meanings drafted</span><span style="font-size:12.5px;color:${T.ocean};white-space:nowrap">Review →</span></a>`;
  const chg = (who, what, when) => `<div style="display:flex;gap:10px;padding:9px 0;border-top:1px solid ${T.softer};font-size:13px;line-height:1.45"><span style="flex:1;color:${T.ink3}"><span style="color:${T.ink};font-weight:500">${who}</span> ${what}</span><span class="mono" style="font-size:11px;color:${T.muted};white-space:nowrap">${when}</span></div>`;
  return `<div style="flex:1;min-width:0;overflow:auto;padding:26px 40px 40px;position:relative">
  <div style="max-width:980px">
    <div class="eyebrow" style="margin-bottom:6px">Catalog</div>
    <div class="row" style="gap:16px;margin-bottom:4px"><h1 class="serif" style="margin:0;font-size:28px;font-weight:400;letter-spacing:-0.02em">Your data, at a glance</h1><span style="flex:1"></span><span class="row" style="gap:6px;font-size:12.5px;color:${T.ink3}">${dot(T.ok)} Refreshed last night at 02:04 · next tonight</span></div>
    <p style="margin:0 0 20px;font-size:14px;color:${T.ink3};line-height:1.55;max-width:720px">2 sources · 3 subjects · 7 shared lookups · 1 of your tables. Pick anything on the left to read its declaration and change it. What needs you is below.</p>
    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:24px">
      ${tile('11','tables built and healthy','Everything Ask AI and the dashboards read from.',T.ok,dot(T.ok))}
      ${tile('2','need attention','Built with something missing. Answers still work, narrower.',T.warn,ico('alert',15,T.warn,1.8))}
      ${tile('1','building','Purchasing, started 02:04 — a few minutes.',T.ocean,stBuild)}
      ${tile('28','to review','Meanings Clarion drafted, waiting for a yes.',T.aiInk,ico('sparkles',15,T.ai))}
    </div>

    <div class="row" style="gap:10px;margin-bottom:8px"><div class="eyebrow">Needs attention</div><span class="chip" style="background:${T.warnSoft};color:${T.warn}">2</span></div>
    <div class="card" style="overflow:hidden;margin-bottom:22px">
      ${attn('fact_receivables','fact','Exact Online stopped providing <span class="mono">DueDate</span> on 18 Sep. Clarion built the table without it, so “who is overdue” cannot be answered until the column is back or the SQL changes.')}
      ${attn('dim_item','dim','14 rows share the key <span class="mono">ItemCode</span>. The key was dropped for this refresh; the duplicates are in Exact Online, not here.')}
    </div>

    <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:20px">
      <div>
        <div class="row" style="gap:10px;margin-bottom:8px"><div class="eyebrow">To review</div><span class="chip" style="background:${T.aiSoft};color:${T.aiInk}">28</span><span style="flex:1"></span><a href="#" style="font-size:12px">Review everything →</a></div>
        <div class="card" style="overflow:hidden">
          ${rev('TransactionLines','12')}${rev('Accounts','9')}${rev('GLAccounts','7')}
          <div style="padding:8px 14px;border-top:1px solid ${T.softer};font-size:12px;color:${T.muted}">Each one is a Keep or Discard on the table itself — nothing is used until you say yes.</div>
        </div>
      </div>
      <div>
        <div class="eyebrow" style="margin-bottom:8px">What changed</div>
        <div class="card" style="padding:0 14px">
          ${chg('You','kept the assistant’s change on <span class="mono">fact_transaction_lines</span>','3 min ago')}
          ${chg('Clarion','rebuilt Finance — 3 tables, 4 of 4 checks','02:04')}
          ${chg('Ines','rewrote the description of <span class="mono">dim_account</span>','12 Sep')}
          ${chg('Clarion','drafted 28 meanings after the re-analyse','12 Sep')}
        </div>
      </div>
    </div>
  </div>
  ${assistantPill('Ask about your data')}
</div>`;
}
writeFileSync('project/Catalog-Health.dc.html', page('Catalog — nothing selected: what needs you', 1440, 900,
  shell('catalog', `${tree()}${landing()}`)));

// ── Board 4: Catalog — a subject selected ─────────────────────────────────
function subjectCard(name, q, status, rows) {
  const [fg, txt, glyph] = status==='ok'?[T.ok,'built 3 min ago',dot(T.ok)]:status==='warn'?[T.warn,'needs attention',ico('alert',13,T.warn,1.8)]:[T.ocean,'building…',''];
  return `<a href="#" class="card" style="padding:12px 14px;display:flex;flex-direction:column;gap:6px;color:${T.ink};border-left:3px solid ${T.fact};min-width:0">
    <div class="row" style="gap:8px;min-width:0"><span class="mono" style="font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${name}</span>${glyph}</div>
    <div style="font-size:12.5px;color:${T.ink3};line-height:1.45">${q}</div>
    <div class="mono" style="font-size:11px;color:${T.muted};line-height:1.5"><span style="color:${fg}">${txt}</span> · ${rows}</div>
  </a>`;
}
function starMini() {
  const n = (x,y,label,kind) => `<g transform="translate(${x},${y})"><rect x="-78" y="-13" width="156" height="26" rx="5" fill="${T.raised}" stroke="${kind==='fact'?T.fact:T.ocean}" stroke-width="${kind==='fact'?1.8:1.2}"/><text x="0" y="4" text-anchor="middle" font-family="Geist Mono, monospace" font-size="10.5" fill="${T.ink}">${label}</text></g>`;
  const e = (x,y) => `<line x1="300" y1="120" x2="${x}" y2="${y}" stroke="${T.ocean}" stroke-width="1.4"/>`;
  return `<svg width="600" height="240" viewBox="0 0 600 240" style="display:block">
    ${e(120,44)}${e(480,44)}${e(120,200)}${e(480,200)}${e(300,30)}
    ${n(120,44,'dim_gl_account','dim')}${n(480,44,'dim_account','dim')}${n(120,200,'dim_journal','dim')}${n(480,200,'dim_date','dim')}${n(300,30,'dim_payment_condition','dim')}
    ${n(300,120,'fact_transaction_lines','fact')}
    <text x="300" y="228" text-anchor="middle" font-family="Inter, sans-serif" font-size="11" fill="${T.muted}">fact_receivables and fact_payables join the same lookups</text>
  </svg>`;
}
function subjectDeclaration() {
  return `<div style="flex:1;min-width:0;overflow:auto;padding:22px 32px 40px;position:relative">
  <div class="row" style="gap:8px;margin-bottom:4px"><span class="eyebrow">Subject</span><span class="eyebrow">›</span><span class="eyebrow">built from Exact Online</span></div>
  <div class="row" style="gap:14px;margin-bottom:6px">
    <div style="width:34px;height:34px;border-radius:8px;background:${T.oceanSofter};display:flex;align-items:center;justify-content:center">${ico('landmark',18,T.ocean)}</div>
    <h1 class="serif" style="margin:0;font-size:26px;font-weight:400;letter-spacing:-0.02em">Finance</h1>
    <span style="flex:1"></span>
    <button class="btn btn-ghost">${ico('eye',14,T.ink3)}Shown on Subjects</button>
    <button class="btn btn-ghost">Rebuild AI-owned tables…</button>
    <button class="btn btn-ghost" aria-label="More" style="padding:7px 8px">${ico('more',15,T.ink3)}</button>
  </div>
  <div class="row" style="gap:14px;font-size:12.5px;color:${T.ink3};margin-bottom:22px"><span class="row" style="gap:6px">${dot(T.ok)} 3 tables built</span><span>·</span><span>1 needs attention</span><span>·</span><span>7 shared lookups</span><span>·</span><span>2 tables declared by you, 1 by the template</span></div>

  <div style="display:grid;grid-template-columns:150px 1fr;gap:10px 20px;align-items:baseline;margin-bottom:24px;max-width:820px">
    <div class="eyebrow">What it answers</div>
    <div style="font-size:14.5px;line-height:1.55;color:${T.ink2};border-bottom:1px dashed ${T.line};padding-bottom:4px">Accounting analytics: general-ledger detail, open receivables and payables. Who owes me money right now? What did we book on each GL account this month? Which suppliers are we late paying?</div>
  </div>

  <div class="eyebrow" style="margin-bottom:8px">Tables</div>
  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:24px">
    ${subjectCard('fact_transaction_lines','Every posted GL line, in EUR.','ok','12,480 rows · 8 columns')}
    ${subjectCard('fact_receivables','Open customer invoices with days overdue.','warn','DueDate vanished · built without it')}
    ${subjectCard('fact_payables','Open supplier invoices with days overdue.','ok','412 rows · 9 columns')}
  </div>
  <div class="row" style="gap:8px;margin:-14px 0 24px;font-size:12.5px;color:${T.muted}"><a href="#" class="row" style="gap:6px">${ico('plus',13,T.ocean)}Add a table</a><span>·</span><span>or ask the assistant for it</span></div>

  <div class="row" style="gap:10px;margin-bottom:8px"><div class="eyebrow">How it fits together</div><span style="flex:1"></span><span style="font-size:11.5px;color:${T.muted}">derived from the foreign keys · nothing to draw</span></div>
  <div class="card" style="padding:8px 12px;margin-bottom:24px">${starMini()}</div>

  <div class="row" style="gap:10px;margin-bottom:8px"><div class="eyebrow">Metrics on this subject</div><span style="flex:1"></span><a href="#" style="font-size:12.5px">Open in Definitions →</a></div>
  <div class="card" style="overflow:hidden">
    ${[['Outstanding receivables','Who owes me money right now?'],['Invoiced sales revenue','How much did I invoice this month?'],['Overdue payables','Which suppliers are we late paying?'],['Gross margin %','What margin did we make on what we sold?']].map(([n,q])=>`<div style="display:grid;grid-template-columns:220px 1fr auto;gap:12px;padding:9px 12px;border-top:1px solid ${T.softer};font-size:13px;align-items:center"><span style="font-weight:500">${n}</span><span style="color:${T.ink3}">${q}</span><span class="chip" style="background:${T.oceanSofter};color:${T.ocean}">metric</span></div>`).join('')}
  </div>
  ${assistantPill('Ask or change this subject')}
</div>`;
}
function subjectContext() {
  return ctxCol(`
  <div><div class="eyebrow" style="margin-bottom:8px">Lineage</div>
    ${lineageNode('Exact Online','TransactionLines · Receivables · Payables · 6 more',{markId:'exactonline'})}
    ${vline}
    ${lineageNode('Finance','3 measures tables',{kind:'fact',current:true})}
    ${vline}
    ${lineageNode('7 shared lookups','owned by Shared data',{kind:'dim'})}
    <div style="margin-top:10px;font-size:12.5px;color:${T.ink3};line-height:1.5"><span style="color:${T.ink};font-weight:500">Used by</span> 4 dashboards · 21 saved questions · the morning brief</div></div>
  <div><div class="eyebrow" style="margin-bottom:8px">Needs attention</div>
    <div class="card" style="padding:10px 12px;border-left:3px solid ${T.warn};font-size:12.5px;line-height:1.5"><span class="mono">fact_receivables</span> — Exact Online stopped providing <span class="mono">DueDate</span>. Clarion built it without that column so answers keep working, narrower. <a href="#">Open the table →</a></div></div>
  <div><div class="eyebrow" style="margin-bottom:8px">Health</div>
    <div class="card" style="padding:10px 12px;display:flex;flex-direction:column;gap:6px;font-size:12.5px">
      ${kv('Last refresh','3 min ago')}
      ${kv('Checks',`<span style="color:${T.ok};font-weight:500">11 of 12 passing</span>`)}
      ${kv('Schedule','<a href="#" style="font-size:12px">nightly 02:00 · on Refresh</a>')}</div></div>
  <div><div class="eyebrow" style="margin-bottom:8px">History</div>
    <div style="display:flex;flex-direction:column;gap:9px;font-size:12.5px;color:${T.ink3};line-height:1.45">
      ${hist('You','changed <span class="mono">fact_transaction_lines</span>','3 min ago')}
      ${hist('Clarion','flagged <span class="mono">fact_receivables</span>','today 02:04')}
      ${hist('Ines','added the metric “Gross margin %”','14 Sep')}</div></div>`);
}
writeFileSync('project/Catalog-Subject.dc.html', page('Catalog — a subject', 1440, 900,
  shell('catalog', `${tree({subjectSel:'finance'})}${subjectDeclaration()}${subjectContext()}`)));

// ── Board 5: Catalog — a source selected (by its mark) ────────────────────
function sourceDeclaration() {
  const tRow = (name, rows, feeds, review=0) => `<div style="display:grid;grid-template-columns:190px 84px minmax(0,1fr) auto;gap:12px;align-items:center;padding:8px 12px;border-top:1px solid ${T.softer};font-size:13px">
    <a href="#" class="mono" style="font-size:12.5px;color:${T.ink}">${name}</a>
    <span class="mono" style="font-size:11.5px;color:${T.muted};text-align:right">${rows}</span>
    <span style="color:${T.ink3}">${feeds}</span>
    <span>${review?`<span class="chip" style="background:${T.aiSoft};color:${T.aiInk}">${ico('sparkles',10,T.ai)} ${review} to review</span>`:''}</span></div>`;
  const note = (t) => `<li style="margin:0 0 5px">${t}</li>`;
  return `<div style="flex:1;min-width:0;overflow:auto;padding:22px 32px 40px;position:relative">
  <div class="row" style="gap:8px;margin-bottom:4px"><span class="eyebrow">Source</span><span class="eyebrow">›</span><span class="eyebrow">read-only input</span></div>
  <div class="row" style="gap:14px;margin-bottom:6px">
    ${mark('exactonline',20)}
    <h1 class="serif" style="margin:0;font-size:26px;font-weight:400;letter-spacing:-0.02em">Exact Online</h1>
    <span style="flex:1"></span>
    <a href="#" class="btn btn-ghost">${ico('external',13,T.ink3)}Sync, analyse and pick tables on Sources</a>
  </div>
  <div class="row" style="gap:14px;font-size:12.5px;color:${T.ink3};margin-bottom:24px"><span class="row" style="gap:6px">${dot(T.ok)} synced 40 min ago</span><span>·</span><span>7 of 61 tables synced</span><span>·</span><span>documented by Exact Online</span></div>

  <div style="display:grid;grid-template-columns:150px 1fr;gap:10px 20px;align-items:baseline;margin-bottom:24px;max-width:860px">
    <div class="eyebrow">What it is</div>
    <div style="font-size:14.5px;line-height:1.55;color:${T.ink2}">Your accounting system. Every subject in Finance, Sales and Purchasing reads from it; the shared lookups (customers, items, GL accounts, journals, payment terms) come from here too.</div>
    <div class="eyebrow" style="padding-top:2px">Read this first</div>
    <div style="font-size:13.5px;line-height:1.5;color:${T.ink2}">
      <ul style="margin:0;padding-left:18px">
        ${note('<span class="mono">…DC</span> amounts are in the division currency and additive; <span class="mono">…FC</span> amounts are in the transaction currency and are not.')}
        ${note('Credit notes are natively negative. Never add a sign flip.')}
        ${note('Journals and payment conditions are referenced by <span class="mono">Code</span>, not by <span class="mono">ID</span>.')}
      </ul>
      <div style="font-size:11.5px;color:${T.muted};margin-top:6px">From the Exact Online source package. Clarion reads these notes before every analysis; you cannot edit them here.</div>
    </div>
  </div>

  <div class="row" style="gap:10px;margin-bottom:8px"><div class="eyebrow">Tables you synced</div><span style="flex:1"></span><span style="font-size:11.5px;color:${T.muted}">click one to read its columns and what it feeds</span></div>
  <div class="card" style="overflow:hidden;margin-bottom:10px">
    <div style="display:grid;grid-template-columns:190px 84px minmax(0,1fr) auto;gap:12px;padding:6px 12px;background:${T.surface}" class="eyebrow"><span>Table</span><span style="text-align:right">Rows</span><span>Feeds</span><span></span></div>
    ${tRow('TransactionLines','12,480','<span class="mono">fact_transaction_lines</span> · <span class="mono">fact_receivables</span>',12)}
    ${tRow('SalesInvoiceLines','8,102','<span class="mono">fact_sales_invoice_lines</span>')}
    ${tRow('Receivables','611','<span class="mono">fact_receivables</span>')}
    ${tRow('Accounts','1,289','<span class="mono">dim_account</span>',9)}
    ${tRow('GLAccounts','412','<span class="mono">dim_gl_account</span>',7)}
    ${tRow('Journals','18','<span class="mono">dim_journal</span>')}
    ${tRow('PaymentConditions','12','<span class="mono">dim_payment_condition</span>')}
  </div>
  <div style="font-size:12.5px;color:${T.muted};margin-bottom:26px">54 more tables exist in Exact Online and are not synced — Quotations, Projects, BankEntries, … <a href="#">Pick them on Sources →</a></div>
  ${assistantPill('Ask what this source contains')}
</div>`;
}
function sourceContext() {
  return ctxCol(`
  <div><div class="eyebrow" style="margin-bottom:8px">Feeds</div>
    ${lineageNode('Exact Online','7 tables synced',{markId:'exactonline',current:true})}
    ${vline}
    ${lineageNode('Finance · Sales','4 measures tables',{kind:'fact'})}
    <div style="height:6px"></div>
    ${lineageNode('Shared data','5 lookups',{kind:'dim'})}
    <div style="margin-top:10px;font-size:12.5px;color:${T.ink3};line-height:1.5"><span style="color:${T.ink};font-weight:500">Purchasing</span> is building from it now.</div></div>
  <div><div class="eyebrow" style="margin-bottom:8px">Health</div>
    <div class="card" style="padding:10px 12px;display:flex;flex-direction:column;gap:6px;font-size:12.5px">
      ${kv('Last sync',`<span class="row" style="gap:6px">${dot(T.ok)} 40 min ago</span>`)}
      ${kv('Entities failed','0 of 7')}
      ${kv('Rows changed','+212 · 0 deleted')}
      ${kv('Next sync','<a href="#" style="font-size:12px">every 4 h · on Refresh</a>')}</div></div>
  <div><div class="eyebrow" style="margin-bottom:8px">Relations</div>
    <div class="card" style="padding:10px 12px;display:flex;flex-direction:column;gap:6px;font-size:12.5px">
      ${kv('Laid by Exact Online','245')}
      ${kv('Settled by the data','35')}
      ${kv('To review',`<a href="#" style="font-size:12px">3 · on Relations</a>`)}</div></div>
  <div><div class="eyebrow" style="margin-bottom:8px">History</div>
    <div style="display:flex;flex-direction:column;gap:9px;font-size:12.5px;color:${T.ink3};line-height:1.45">
      ${hist('Clarion','synced 7 tables','40 min ago')}
      ${hist('Clarion','drafted 28 meanings after the re-analyse','12 Sep')}
      ${hist('You','added the source','11 Sep')}</div></div>`);
}
writeFileSync('project/Catalog-Source.dc.html', page('Catalog — a source, by its mark', 1440, 900,
  shell('catalog', `${tree({sourceSel:'eo', eoOpen:true, financeOpen:false, sharedOpen:false})}${sourceDeclaration()}${sourceContext()}`)));

// ── Board 6: Catalog — a source table (the review job, inline) ────────────
function sourceTableDeclaration() {
  const G = '128px 84px 112px minmax(0,1fr)';
  const cell = (v, right=false) => `<td style="padding:6px 10px;border-top:1px solid ${T.softer};font-size:12.5px;${right?'text-align:right;font-family:'+MONO+';font-size:12px':''}">${v}</td>`;
  const rows = [['2026-09-03','8000','Van Damme BVBA','70','1,240.00','50'],['2026-09-03','7000','Peeters NV','70','−310.00','50'],['2026-09-04','440000','Colruyt Group','60','5,900.00','50']].map(r=>`<tr>${cell(r[0])}${cell('<span class="mono">'+r[1]+'</span>')}${cell(r[2])}${cell('<span class="mono">'+r[3]+'</span>')}${cell(r[4],true)}${cell('<span class="mono">'+r[5]+'</span>')}</tr>`).join('');
  return `<div style="flex:1;min-width:0;overflow:auto;padding:22px 32px 40px;position:relative">
  <div class="row" style="gap:8px;margin-bottom:4px"><span class="eyebrow">Exact Online</span><span class="eyebrow">›</span><span class="eyebrow">source table · read-only input</span></div>
  <div class="row" style="gap:12px;margin-bottom:6px">
    ${mark('exactonline',16)}
    <h1 class="mono" style="margin:0;font-size:22px;font-weight:500;letter-spacing:-0.01em">TransactionLines</h1>
    <span style="flex:1"></span>
    <button class="btn btn-ghost">${ico('play',13,T.ink3)}Preview 12 rows</button>
    <button class="btn btn-primary" disabled>Save</button>
    <button class="btn btn-ghost" aria-label="More" style="padding:7px 8px">${ico('more',15,T.ink3)}</button>
  </div>
  <div class="row" style="gap:14px;font-size:12.5px;color:${T.ink3};margin-bottom:22px"><span class="row" style="gap:6px">${dot(T.ok)} synced 40 min ago</span><span>·</span><span>12,480 rows</span><span>·</span><span>documented by Exact Online</span><span>·</span><span style="color:${T.aiInk}">12 meanings to review</span></div>

  <div style="display:grid;grid-template-columns:150px 1fr;gap:10px 20px;align-items:baseline;margin-bottom:22px;max-width:820px">
    <div class="eyebrow">What one row is</div>
    <div style="font-size:14.5px;line-height:1.5;color:${T.ink2}">GL ledger detail — every booked accounting line. <span style="font-size:11.5px;color:${T.muted}">Exact Online’s own words</span></div>
    <div class="eyebrow">Your note</div>
    <div style="font-size:14.5px;line-height:1.5;color:${T.muted2};border-bottom:1px dashed ${T.line};padding-bottom:4px">Add what your team knows — which journals matter, what Status 20 means for you…</div>
    <div class="eyebrow">Feeds</div>
    <div class="row" style="gap:8px;flex-wrap:wrap;font-size:13px"><a href="#" class="chip" style="background:${T.factSoft};color:${T.fact};padding:3px 10px">fact_transaction_lines · 8 columns</a><a href="#" class="chip" style="background:${T.factSoft};color:${T.fact};padding:3px 10px">fact_receivables · join</a></div>
  </div>

  <div class="row" style="gap:10px;margin-bottom:8px"><div class="eyebrow">Columns</div><span style="flex:1"></span><span style="font-size:11.5px;color:${T.muted}">61 · meanings from Exact Online where it documents them, drafted by Clarion where it does not</span></div>
  <div class="card" style="overflow:hidden;margin-bottom:22px">
    ${colsHeader(G)}
    ${columnRow('ID','Edm.Guid','key','Primary key',{grid:G})}
    ${columnRow('Date','Edm.DateTime','dimension','Entry date',{grid:G})}
    ${columnRow('AmountDC','Edm.Double','measure',`<div>Amount in the default currency of the company.</div><div style="margin-top:4px">${teamChip('net booking',{short:true})}</div>`,{grid:G})}
    ${columnRow('AccountCode','Edm.String','dimension','Code of the Account',{grid:G})}
    ${columnRow('JournalCode','Edm.String','fk','Journals.Code',{grid:G})}
    ${columnRow('Status','Edm.Int16','attribute','20 = Open, 50 = Processed',{grid:G})}
    ${columnRow('CostCenter','Edm.String','dimension',draft('The cost centre this line was booked against — empty on 92% of your lines.'),{grid:G})}
    ${columnRow('Notes','Edm.String','attribute',draft('Free text a bookkeeper typed on the line; not the invoice description.'),{grid:G})}
    <div style="padding:7px 12px;border-top:1px solid ${T.softer};font-size:12px;color:${T.muted}">+ 53 more columns · <a href="#">show all</a> · 10 more drafts to review</div>
  </div>

  <div class="eyebrow" style="margin-bottom:8px">Sample rows</div>
  <div class="card" style="overflow:hidden"><table style="border-collapse:collapse;width:100%"><thead><tr>${['Date','GLAccountCode','AccountName','JournalCode','AmountDC','Status'].map(h=>`<th class="mono" style="text-align:left;padding:6px 10px;background:${T.surface};font-weight:500;font-size:11px;color:${T.muted}">${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
  ${assistantPill('Ask about this table')}
</div>`;
}
function sourceTableContext() {
  const rel = (from, to, state, note) => `<div style="padding:8px 0;border-top:1px solid ${T.softer};font-size:12px;line-height:1.5"><div class="mono" style="font-size:11.5px">${from} → ${to}</div><div class="row" style="gap:6px;color:${T.ink3}">${state}${note}</div></div>`;
  return ctxCol(`
  <div><div class="eyebrow" style="margin-bottom:8px">Lineage</div>
    ${lineageNode('TransactionLines','this table · Exact Online',{markId:'exactonline',current:true})}
    ${vline}
    ${lineageNode('fact_transaction_lines','8 columns read',{kind:'fact'})}
    <div style="height:6px"></div>
    ${lineageNode('fact_receivables','joined on EntryNumber',{kind:'fact'})}
    <div style="margin-top:10px;font-size:12.5px;color:${T.ink3};line-height:1.5"><span style="color:${T.ink};font-weight:500">Used by</span> nothing directly — answers read the subject tables above</div></div>
  <div><div class="eyebrow" style="margin-bottom:8px">Relations</div>
    <div class="card" style="padding:2px 12px 4px">
      ${rel('JournalCode','Journals.Code',dot(T.ok),'holds · laid by Exact Online, column settled by the data')}
      ${rel('AccountCode','Accounts.Code',dot(T.ok),'holds · laid by Exact Online')}
      ${rel('Project','Projects.ID',`<span style="width:7px;height:7px;border-radius:999px;border:1.5px solid ${T.muted2};display:inline-block"></span>`,'not enough data to check')}
      <div style="padding:8px 0 4px;font-size:12px"><a href="#">Draw or check on Relations →</a></div></div></div>
  <div><div class="eyebrow" style="margin-bottom:8px">Health</div>
    <div class="card" style="padding:10px 12px;display:flex;flex-direction:column;gap:6px;font-size:12.5px">
      ${kv('Last sync',`<span class="row" style="gap:6px">${dot(T.ok)} 40 min ago</span>`)}
      ${kv('Rows changed','+212 · 0 deleted')}
      ${kv('Cursor','Modified, 08:14')}</div></div>
  <div><div class="eyebrow" style="margin-bottom:8px">History</div>
    <div style="display:flex;flex-direction:column;gap:9px;font-size:12.5px;color:${T.ink3};line-height:1.45">
      ${hist('Ines','kept 3 drafted meanings','14 Sep')}
      ${hist('Clarion','drafted 15 meanings for undocumented columns','12 Sep')}
      ${hist('Clarion','took 46 meanings from Exact Online’s docs','11 Sep')}</div></div>`);
}
writeFileSync('project/Catalog-SourceTable.dc.html', page('Catalog — a source table, drafts to review', 1440, 900,
  shell('catalog', `${tree({srcTableSel:'TransactionLines', eoOpen:true, financeOpen:false, sharedOpen:false})}${sourceTableDeclaration()}${sourceTableContext()}`)));

// ── Board 7: Catalog — a source with no subjects yet (Build folded in) ─────
function planPanel() {
  const plan = (glyph, name, desc, kpis) => `<div class="card" style="padding:14px 16px;display:flex;gap:12px">
    <div style="width:32px;height:32px;border-radius:8px;background:${T.oceanSofter};display:flex;align-items:center;justify-content:center;flex-shrink:0">${ico(glyph,17,T.ocean)}</div>
    <div style="flex:1;min-width:0"><div style="font-weight:500;font-size:14px">${name}</div><div style="font-size:13px;color:${T.ink3};line-height:1.5;margin:2px 0 6px">${desc}</div><div style="font-size:12px;color:${T.muted}">You’ll see: ${kpis}</div></div></div>`;
  return `<div style="flex:1;min-width:0;overflow:auto;padding:22px 32px 40px;position:relative">
  <div class="row" style="gap:8px;margin-bottom:4px"><span class="eyebrow">Source</span><span class="eyebrow">›</span><span class="eyebrow">read-only input</span></div>
  <div class="row" style="gap:14px;margin-bottom:6px">
    ${mark('odoo',20)}
    <h1 class="serif" style="margin:0;font-size:26px;font-weight:400;letter-spacing:-0.02em">Odoo (staging)</h1>
    <span style="flex:1"></span><a href="#" class="btn btn-ghost">${ico('external',13,T.ink3)}Sync, analyse and pick tables on Sources</a>
  </div>
  <div class="row" style="gap:14px;font-size:12.5px;color:${T.ink3};margin-bottom:26px"><span class="row" style="gap:6px">${dot(T.ok)} synced 40 min ago</span><span>·</span><span>21 tables</span><span>·</span><span>analysed</span><span>·</span><span style="color:${T.warn}">no subjects yet</span></div>

  <div style="max-width:760px">
    <h2 class="serif" style="margin:0 0 6px;font-size:22px;font-weight:400;letter-spacing:-0.01em">Turn this source into subjects</h2>
    <p style="margin:0 0 18px;font-size:14px;color:${T.ink3};line-height:1.55">Clarion knows Odoo. From the 21 tables you synced it will declare these subjects — every table with its SQL, its columns and its lineage, ready to edit here afterwards.</p>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
      ${plan('landmark','Finance','General-ledger lines, customer and supplier invoices, payments.','Outstanding receivables · Invoiced revenue · Overdue payables')}
      ${plan('receipt','Sales','Sales orders and invoice lines by customer, product and salesperson.','Revenue by customer · Order book · Average order value')}
      ${plan('cart','Purchasing','Purchase order lines and supplier invoices.','Spend by supplier · Open purchase orders')}
      ${plan('layers','Inventory','Stock moves and valuation by product and warehouse.','Stock on hand · Stock turnover')}
    </div>
    <div style="font-size:13px;color:${T.ink3};margin-bottom:18px"><span style="font-weight:500;color:${T.ink}">Shared data</span> gets 9 lookups: partner, product, product category, account, journal, company, currency, payment terms, unit of measure — reused across all four subjects.</div>
    <div class="card" style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
      <label class="eyebrow" for="intent">What do you most want to see? <span style="text-transform:none;letter-spacing:0;font-family:${SANS};font-weight:400">(optional — it becomes your first question)</span></label>
      <input id="intent" placeholder="e.g. which products we lose money on" style="border:1px solid ${T.line};border-radius:6px;padding:9px 12px;font:14px ${SANS};color:${T.ink};background:${T.raised}">
    </div>
    <div class="row" style="gap:12px"><button class="btn btn-primary" style="padding:10px 18px;font-size:14px">Create my subjects</button><span style="font-size:12.5px;color:${T.muted}">Takes a few minutes. You can keep working; the tree fills in as tables are built.</span></div>
  </div>
  ${assistantPill('Ask what this source contains')}
</div>`;
}
writeFileSync('project/Catalog-NewSubject.dc.html', page('Catalog — new subjects from a source', 1440, 900,
  shell('catalog', `${tree({sourceSel:'odoo', financeOpen:false, sharedOpen:false})}${planPanel()}`)));

// ── Boards 8–9: Definitions (a separate pane) ─────────────────────────────
function defCard({kind, name, q='', body, addr='', meta=''}) {
  const [bg,fg,lbl] = kind==='term'?[T.oceanSofter,T.ocean,'term']:kind==='metric'?[T.factSoft,T.fact,'metric']:[T.okSoft,T.ok,'verified answer'];
  return `<div class="card" style="padding:14px 16px;display:flex;flex-direction:column;gap:6px">
    <div class="row" style="gap:10px"><span class="serif" style="font-size:17px;font-weight:500;letter-spacing:-0.01em">${name}</span><span class="chip" style="background:${bg};color:${fg}">${lbl}</span><span style="flex:1"></span>${ico('pencil',13,T.muted2)}</div>
    ${q?`<div class="serif" style="font-style:italic;font-size:14px;color:${T.ink2}">“${q}”</div>`:''}
    <div style="font-size:13.5px;line-height:1.55;color:${T.ink2}">${body}</div>
    ${addr?`<div class="row" style="gap:6px;font-size:12px;color:${T.ink3};margin-top:2px">${ico('link',12,T.muted)}In the data: ${addr}</div>`:''}
    ${meta?`<div style="font-size:11.5px;color:${T.muted}">${meta}</div>`:''}
  </div>`;
}
function definitionsPage({editing=false}={}) {
  const chips = ['All 23','Terms 9','Metrics 11','Verified answers 3'].map((c,i)=>`<span class="chip" style="padding:4px 11px;font-family:${SANS};font-size:12.5px;letter-spacing:0;${i===0?`background:${T.oceanSofter};color:${T.ocean};border:1px solid ${T.oceanSoft}`:`background:${T.raised};color:${T.ink3};border:1px solid ${T.line}`}">${c}</span>`).join('');
  return `<div style="flex:1;min-width:0;overflow:auto;padding:28px 40px 40px;position:relative">
  <div style="max-width:880px;margin:0 auto">
    <div class="row" style="gap:16px;margin-bottom:4px"><h1 class="serif" style="margin:0;font-size:30px;font-weight:400;letter-spacing:-0.02em">Definitions</h1><span style="flex:1"></span><button class="btn">${ico('sparkles',14,T.ai)}Draft with AI</button><button class="btn btn-primary">${ico('plus',14,'#fff')}Add a definition</button></div>
    <p style="margin:0 0 20px;font-size:14.5px;color:${T.ink3};line-height:1.55;max-width:640px">The words your team uses, written down once. Clarion reads them every time it answers a question or builds a dashboard.</p>
    <div class="row" style="gap:10px;margin-bottom:22px">
      <div class="row" style="flex:1;gap:8px;height:38px;border:1px solid ${T.line};background:${T.raised};border-radius:8px;padding:0 12px;color:${T.muted2};font-size:13.5px">${ico('search',14,T.muted2)}Search definitions…</div>
      ${chips}
    </div>

    ${editing ? editCard() : ''}

    <div class="eyebrow" style="margin:6px 0 10px">Everywhere</div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:26px">
      ${editing ? '' : defCard({kind:'term',name:'Active customer',body:'A customer with at least one invoice in the last 12 months. Not: a customer with an open quote.',addr:'<span class="mono">dim_account.last_invoice_date</span> <span style="color:'+T.muted+'">(Finance)</span>',meta:'Used in 14 answers this month · edited by Ines, 12 Sep'})}
      ${defCard({kind:'term',name:'Net booking',body:'The amount of a GL line in EUR after VAT, as Exact posts it. Credit notes are negative; never flip the sign.',addr:'<span class="mono">fact_transaction_lines.amount_dc</span> <span style="color:'+T.muted+'">(Finance)</span>',meta:'Used in 31 answers this month'})}
      ${defCard({kind:'term',name:'Closing journal',body:'Journal 90. Year-end closing entries — excluded from every month view.',addr:'<span class="mono">dim_journal</span> where <span class="mono">journal_code = \'90\'</span>',meta:'Added today from the assistant'})}
    </div>

    <div class="row" style="gap:10px;margin:0 0 10px"><span class="eyebrow">Finance</span><a href="#" style="font-size:12px">open in the Catalog →</a></div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:26px">
      ${defCard({kind:'metric',name:'Outstanding receivables',q:'Who owes me money right now?',body:'Sum of the open amount on unpaid sales invoices, today. <span style="color:'+T.muted+'">Formula ▸</span>',addr:'<span class="mono">fact_receivables.open_amount</span>',meta:'On the Finance topic page · watched by 2 people'})}
      ${defCard({kind:'metric',name:'Invoiced sales revenue',q:'How much did I invoice this month?',body:'Net amount of sales invoice lines, credit notes included. <span style="color:'+T.muted+'">Formula ▸</span>',addr:'<span class="mono">fact_sales_invoice_lines.net_amount</span>'})}
      ${defCard({kind:'verified',name:'How much is overdue by more than 60 days?',body:'Answered from <span class="mono">fact_receivables</span> · verified by Arno, 9 Sep · 11 uses',meta:'Anyone asking exactly this gets the verified answer, no model call.'})}
    </div>

    <div class="row" style="gap:10px;margin:0 0 10px"><span class="eyebrow">Sales</span><a href="#" style="font-size:12px">open in the Catalog →</a></div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:26px">
      ${defCard({kind:'metric',name:'Gross margin %',q:'What margin did we make on what we sold?',body:'(Net revenue − cost of goods) ÷ net revenue, per invoice line. <span style="color:'+T.muted+'">Formula ▸</span>',addr:'<span class="mono">fact_sales_invoice_lines</span>'})}
    </div>
    <div class="eyebrow" style="margin:0 0 10px;color:${T.muted2}">Legacy · 2 source-level KPIs still read by reports</div>
  </div>
  ${editing?'':assistantPill('Ask what a word means here')}
</div>`;
}
function editCard() {
  const field = (label, val, {mono=false, area=false}={}) => `<div style="display:grid;grid-template-columns:150px 1fr;gap:8px 16px;align-items:start">
    <div class="eyebrow" style="padding-top:9px">${label}</div>
    ${area?`<textarea style="border:1px solid ${T.line};border-radius:6px;padding:8px 10px;font:14px/1.55 ${SANS};color:${T.ink};min-height:64px;resize:vertical;background:${T.raised}">${val}</textarea>`:`<input value="${val}" style="border:1px solid ${T.line};border-radius:6px;padding:8px 10px;font:${mono?'13px '+MONO:'14px '+SANS};color:${T.ink};background:${T.raised}">`}
  </div>`;
  return `<div class="card" style="padding:18px 20px;display:flex;flex-direction:column;gap:12px;margin-bottom:26px;border-color:${T.ocean};box-shadow:0 0 0 3px ${T.oceanSoft}">
    <div class="row" style="gap:10px"><span class="eyebrow">Editing</span><span class="chip" style="background:${T.oceanSofter};color:${T.ocean}">term</span><span style="flex:1"></span><span style="font-size:12px;color:${T.muted}">Kind: <a href="#">term</a> · metric · verified answer</span></div>
    ${field('Name','Active customer')}
    ${field('What it means','A customer with at least one invoice in the last 12 months. Not: a customer with an open quote.',{area:true})}
    ${field('Examples','Van Damme BVBA (invoiced 3 Sep) · not Peeters NV (last invoice 2024)')}
    <div style="display:grid;grid-template-columns:150px 1fr;gap:8px 16px;align-items:start">
      <div class="eyebrow" style="padding-top:9px">In the data</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <span class="chip" style="background:${T.oceanSofter};color:${T.ocean};padding:4px 10px;font-size:12px">${ico('link',11,T.ocean)} dim_account.last_invoice_date <span style="color:${T.muted}">· Finance</span> ${ico('x',11,T.muted)}</span>
          <span class="chip" style="background:${T.raised};color:${T.ink3};padding:4px 10px;font-size:12px;border:1px dashed ${T.lineStrong}">${ico('plus',11,T.muted)} link a column, table or metric</span>
        </div>
        <div class="card" style="border-color:${T.line};overflow:hidden;max-width:520px">
          <div class="row" style="gap:8px;padding:8px 10px;border-bottom:1px solid ${T.softer};font-size:13px;color:${T.muted2}">${ico('search',13,T.muted2)}<span>last_inv<span style="color:${T.ink}">|</span></span></div>
          <div class="eyebrow" style="padding:8px 10px 2px">Finance · dim_account</div>
          <div style="padding:6px 10px;font-size:13px;background:${T.oceanSofter}" class="row"><span class="mono" style="font-size:12.5px">last_invoice_date</span><span style="flex:1"></span><span style="font-size:11.5px;color:${T.muted}">DATE · last sales invoice for this account</span></div>
          <div style="padding:6px 10px;font-size:13px" class="row"><span class="mono" style="font-size:12.5px">last_invoice_amount</span><span style="flex:1"></span><span style="font-size:11.5px;color:${T.muted}">DOUBLE</span></div>
          <div class="eyebrow" style="padding:8px 10px 2px">Metrics</div>
          <div style="padding:6px 10px 10px;font-size:13px" class="row"><span>Invoiced sales revenue</span><span style="flex:1"></span><span style="font-size:11.5px;color:${T.muted}">Finance</span></div>
        </div>
        <div style="font-size:12px;color:${T.muted};line-height:1.5">A link tells the AI exactly which column carries this — it will use that one and never a similarly named one. If the column ever disappears, you’ll be asked to pick again.</div>
      </div>
    </div>
    <div class="row" style="gap:10px;justify-content:flex-end;border-top:1px solid ${T.softer};padding-top:12px"><button class="btn">Cancel</button><button class="btn btn-primary">Save definition</button></div>
  </div>`;
}
writeFileSync('project/Definitions.dc.html', page('Definitions', 1440, 900, shell('definitions', definitionsPage())));
writeFileSync('project/Definitions-Edit.dc.html', page('Definitions — editing a term', 1440, 900, shell('definitions', definitionsPage({editing:true}))));

// ── Board 10: Topic page (Manage mode retired) ────────────────────────────
function topicPage() {
  const q = (t) => `<a href="#" class="row" style="background:${T.raised};border:1px solid ${T.line};border-radius:8px;padding:15px 18px;font-size:15.5px;color:${T.ink};gap:12px"><span style="flex:1">${t}</span>${ico('arrowR',15,T.muted2)}</a>`;
  return `<div style="flex:1;min-width:0;overflow:auto;position:relative">
  <div style="max-width:720px;margin:0 auto;padding:60px 40px 40px;display:flex;flex-direction:column;gap:30px">
    <div style="display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center">
      <div style="width:44px;height:44px;border-radius:10px;background:${T.oceanSofter};display:flex;align-items:center;justify-content:center">${ico('landmark',22,T.ocean,1.6)}</div>
      <h1 class="serif" style="margin:0;font-size:38px;font-weight:400;letter-spacing:-0.02em;line-height:1.15">Finance</h1>
      <p style="margin:0;font-size:15px;color:${T.ink3};line-height:1.6;max-width:520px">Accounting analytics: general-ledger detail, open receivables and payables.</p>
    </div>
    <div class="row" style="background:${T.raised};border:1px solid ${T.line};border-radius:10px;padding:14px 18px;gap:10px">${ico('message',16,T.muted2)}<span style="flex:1;font-size:15px;color:${T.muted2}">Ask anything about Finance…</span><button class="btn btn-primary">Ask</button></div>
    <div style="display:flex;flex-direction:column;gap:8px"><div class="eyebrow">Try asking</div>
      ${q('Who owes me money right now?')}${q('How much did I invoice this month?')}${q('Which suppliers are we late paying?')}${q('What did we book on each GL account this month?')}</div>
    <p style="margin:0;text-align:center;font-size:14px;color:${T.ink3};line-height:1.6">Break any of this down by customer, GL account, journal, payment terms or date.</p>
    <div style="display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;font-size:13px;color:${T.ink3}">
      <div class="row" style="gap:6px">${dot(T.ok)} Data through this morning 02:04 · checked against Exact Online</div>
      <div class="row" style="gap:6px;color:${T.warn}">${ico('alert',13,T.warn)} Overdue receivables are missing a due date Exact Online stopped providing</div>
    </div>
    <div style="display:flex;justify-content:center;gap:18px;font-size:12.5px;padding-top:6px;border-top:1px solid ${T.line}">
      <a href="#" class="row" style="gap:6px">${ico('book',13,T.ocean)}Open in the Catalog →</a>
      <a href="#" class="row" style="gap:6px">${ico('quote',13,T.ocean)}Definitions →</a>
      <span style="color:${T.muted}">visible to you as an analyst</span>
    </div>
  </div>
</div>`;
}
writeFileSync('project/Topic.dc.html', page('Topic page — Manage mode retired', 1440, 900, shell('subjects', topicPage())));

// ── Board 11: Rail before / after ─────────────────────────────────────────
function railCompare() {
  const col = (title, note, r) => `<div style="display:flex;flex-direction:column;gap:10px"><div><div class="eyebrow">${title}</div><div style="font-size:12.5px;color:${T.ink3};line-height:1.5;max-width:220px">${note}</div></div><div style="height:640px;display:flex;border:1px solid ${T.line};border-radius:10px;overflow:hidden">${r}</div></div>`;
  return `<div style="width:760px;height:780px;box-sizing:border-box;background:${T.bg};padding:28px;display:flex;gap:40px;font-family:${SANS}">
    ${col('Studio today','Catalog is a reading room. The work sits on Build, the workshop, Manage mode and Suggestions — four doors, none of them here.', rail('catalog',{before:true}))}
    ${col('Studio proposed','Catalog is the workspace: review, health, adapt. Build and Suggestions fold into it (the badge is what needs you). Definitions is the glossary as its own pane. Six entries, one job each.', rail('catalog'))}
  </div>`;
}
writeFileSync('project/Rail.dc.html', page('Rail — before and after', 760, 780, railCompare()));

// ── Board 12: What goes where ─────────────────────────────────────────────
function mapBoard() {
  const rows = [
    ['Catalog chrome: Browse / Trust / Glossary tabs · All / Sources / Products · Grid / List / Structure · hero · New product','<b>Gone.</b> One tree, one declaration, one assistant'],
    ['Catalog cards: CatalogSplitView (451) · ProductCardGrid (396) · Analytics/Reference cards (242) · GlossaryMatchCards (102)','Retired · no cards view'],
    ['Catalog: ProductFullView (661) · ProductPreviewPanel (561)','Retired · the subject declaration'],
    ['Catalog: ProductTableDetailPanel (1,002) · TableDetailPanel (691) · SourceRootPanel (1,061)','<b>Rebuilt</b> as one declaration with three flavours: subject table · source table · source'],
    ['Catalog: Trust facet (QualityOverview 222)','The landing board — what needs you'],
    ['Catalog: Glossary facet (GlossaryPanel 475)','<b>Definitions</b>, its own pane'],
    ['Suggestions · /review (252)','Catalog: “To review” on the landing + Keep / Discard on each source table'],
    ['/build (883) + AskPanel (207)','Catalog → source with no subjects (plan panel, run panel)'],
    ['/products workshop (915) · /products/[id] (ProductRootPanel 1,053 · TableNotebook 681 · CellOutput 205)','Retired · the declaration + Preview'],
    ['RefineChat (986) · AskAIPanel · KpiManager (506)','One floating assistant (Catalog, Definitions); proposals as diffs'],
    ['Topic page → Manage mode (ManageLayer 453 · ManageTables 670)','Retired · “Open in the Catalog →” for curators'],
    ['/relationships → Topics toggle (TopicsCanvas 600)','Retired · joins drawn on the subject. The sources canvas stays'],
    ['/shared-data · /pipelines · /notebooks · Ask · Dashboards · Topic page (viewers)','Unchanged (shared-data cards link into the Catalog)'],
  ];
  return `<div style="width:1100px;height:800px;box-sizing:border-box;background:${T.bg};padding:32px 36px;font-family:${SANS};display:flex;flex-direction:column;gap:14px">
    <div><h1 class="serif" style="margin:0 0 4px;font-size:24px;font-weight:400;letter-spacing:-0.02em">What goes where</h1><div style="font-size:13.5px;color:${T.ink3}">Every surface that touched a table’s SQL, lineage, metrics or definitions, and where it lands. Line counts are today’s.</div></div>
    <div class="card" style="overflow:hidden">
      <div style="display:grid;grid-template-columns:1.15fr 1fr;gap:16px;padding:8px 16px;background:${T.surface}" class="eyebrow"><span>Today</span><span>Target</span></div>
      ${rows.map(([a,b])=>`<div style="display:grid;grid-template-columns:1.15fr 1fr;gap:16px;padding:9px 16px;border-top:1px solid ${T.softer};font-size:13px;line-height:1.45"><span style="color:${T.ink2}">${a}</span><span style="${/Retired|Unchanged/.test(b)?'':'font-weight:500'}">${b}</span></div>`).join('')}
    </div>
    <div style="font-size:12.5px;color:${T.muted};line-height:1.5">About 11,000 lines retired outright, 2,750 rebuilt into roughly 2,600 new (tree, declaration in three flavours, landing, assistant reuse, Definitions). The engine — runner, checks, lineage derivation, refresh — is untouched; the backend change is one PUT that validates, stores once and rebuilds, plus one read for the landing.</div>
  </div>`;
}
writeFileSync('project/Map.dc.html', page('What goes where', 1100, 800, mapBoard()));

// ── canvas.json ───────────────────────────────────────────────────────────
const now = new Date().toISOString();
const boards = {
  'Main.dc.html':                {x:0,    y:0,    w:1440,h:900, title:'Catalog — a table’s declaration'},
  'Catalog-Diff.dc.html':        {x:1520, y:0,    w:1440,h:900, title:'Catalog — the assistant proposes a change'},
  'Catalog-Health.dc.html':      {x:3040, y:0,    w:1440,h:900, title:'Catalog — nothing selected: what needs you'},
  'Catalog-Subject.dc.html':     {x:4560, y:0,    w:1440,h:900, title:'Catalog — a subject'},
  'Catalog-Source.dc.html':      {x:0,    y:1220, w:1440,h:900, title:'Catalog — a source, by its mark'},
  'Catalog-SourceTable.dc.html': {x:1520, y:1220, w:1440,h:900, title:'Catalog — a source table: review the drafts'},
  'Catalog-NewSubject.dc.html':  {x:3040, y:1220, w:1440,h:900, title:'Catalog — a source with no subjects yet (Build folded in)'},
  'Definitions.dc.html':         {x:0,    y:2440, w:1440,h:900, title:'Definitions'},
  'Definitions-Edit.dc.html':    {x:1520, y:2440, w:1440,h:900, title:'Definitions — editing “Active customer”'},
  'Topic.dc.html':               {x:0,    y:3660, w:1440,h:900, title:'Topic page — unchanged for viewers, Manage mode gone'},
  'Rail.dc.html':                {x:1520, y:3660, w:760, h:780, title:'Studio rail — before / after'},
  'Map.dc.html':                 {x:2360, y:3660, w:1100,h:800, title:'What goes where'},
};
const canvas = {
  v:3, attachments:{}, createdOnFiles:{v:1, at:now}, title:'Clarion Declarative Workspace',
  launch:{view:'canvas'}, pages:[], boards, order:Object.keys(boards),
  notes:{
    n1:{x:0,y:-300,text:'Catalog — one tree, one declaration, one assistant',kind:'title1',maxW:6000,w:240},
    n2:{x:0,y:920,text:'Sources in the catalog — read-only inputs, by their mark',kind:'title1',maxW:4480,w:240},
    n3:{x:0,y:2140,text:'Definitions — a separate pane: the words your team uses, written once',kind:'title1',maxW:2960,w:240},
    n4:{x:0,y:3360,text:'Affected pages — what stays, what goes',kind:'title1',maxW:3460,w:240},
    s1:{x:6080,y:0,w:360,text:'Reading order: left to right. Board 1 is the everyday screen: tree · declaration · context, with the assistant folded into a pill. Board 2 is the same screen while the assistant proposes a diff (Keep = Save). Board 3 is the catalog with nothing selected: what needs you — this replaces the Trust tab and the Suggestions queue. Board 4 selects a subject.',fill:'blue'},
    s2:{x:4560,y:1220,w:360,text:'Sources are inputs. Nothing here edits the source: what you do on a source table is REVIEW — keep or discard a drafted meaning, add your team’s note — and see what it feeds. Sync, analyse and picking tables stay on Sources. Board 7 is today’s Build page, inside the catalog.',fill:'blue'},
    s3:{x:3040,y:2440,w:360,text:'Three kinds, one card: term (glossary), metric (product KPI), verified answer (saved question). Documented, not executed. “In the data” is the existing glossary link — the AI is told to use exactly that column.',fill:'blue'},
  },
  designSystems:[],
};
writeFileSync('project/canvas.json', JSON.stringify(canvas, null, 2));
console.log('ok', Object.keys(boards).length, 'boards');
