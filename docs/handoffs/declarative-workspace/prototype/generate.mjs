import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('project', { recursive: true });

// ── Observatory tokens (frontend/app/globals.css) ─────────────────────────
const T = {
  bg:'#eef0f2', surface:'#f8f9fa', raised:'#ffffff', soft:'#e3e6ea', softer:'#edeff2',
  line:'#d0d5da', lineStrong:'#b8bec5', ink:'#0f1a22', ink2:'#334049', ink3:'#4a5660',
  muted:'#6b7680', muted2:'#8891a0', ocean:'#164e63', oceanHover:'#103d4f',
  oceanSoft:'#d0e1e6', oceanSofter:'#e8f0f3', ai:'#c08a5e', aiSoft:'#f1e4d6',
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
  arrowL:'<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  branch:'<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6"/><path d="M18 15V9a3 3 0 0 0-3-3H9"/>',
  play:'<path d="m6 4 14 8-14 8z"/>',
  landmark:'<path d="M3 22h18"/><path d="M6 18v-7M10 18v-7M14 18v-7M18 18v-7"/><path d="M12 2 2 8h20z"/>',
  receipt:'<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M8 7h8M8 11h8M12 15h4"/>',
  cart:'<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2 2h3l2.7 12.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
  library:'<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  history:'<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 3"/>',
  heart:'<path d="M22 12h-4l-3 8-6-16-3 8H2"/>',
  link:'<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19.5"/>',
  quote:'<path d="M3 21c3 0 7-1 7-8V5H3v8h4c0 4-2 6-4 6z"/><path d="M15 21c3 0 7-1 7-8V5h-7v8h4c0 4-2 6-4 6z"/>',
  hash:'<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  bell:'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  sliders:'<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
  pencil:'<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  alert:'<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  more:'<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
};
const ico = (n, s=16, c='currentColor', sw=1.5) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;display:block">${P[n]}</svg>`;

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
.btn{display:inline-flex;align-items:center;gap:6px;border:1px solid ${T.line};background:${T.raised};color:${T.ink};font:500 13px ${SANS};padding:7px 12px;border-radius:6px;cursor:pointer;line-height:1.3}
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
function eyebrowRow(label, open=true) {
  return `<div class="eyebrow row" style="gap:6px;padding:14px 16px 6px;margin-top:4px">${label}<span style="flex:1"></span>${ico('chevron',12,T.muted2)}</div>`;
}
function rail(active, {before=false}={}) {
  const studio = before
    ? [['plug','Sources','sources','1'],['table','Your tables','grids'],['blocks','Build','build'],['share','Relations','relations'],['book','Catalog','catalog'],['workflow','Refresh','refresh'],['inbox','Suggestions','review','28']]
    : [['plug','Sources','sources','1'],['branch','Model','model'],['quote','Definitions','definitions'],['table','Your tables','grids'],['share','Relations','relations'],['workflow','Refresh','refresh'],['inbox','Suggestions','review','28'],['book','Catalog','catalog']];
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

// ── Model page pieces ──────────────────────────────────────────────────────
const dot = (c) => `<span style="width:7px;height:7px;border-radius:999px;background:${c};display:inline-block;flex-shrink:0"></span>`;
function treeRow(label, {kind='fact', sel=false, status='', indent=1, glyph='', muted=false}={}) {
  const color = kind==='fact'?T.fact:kind==='dim'?T.ocean:kind==='grid'?T.grid:T.muted2;
  const pad = 14 + indent*14;
  return `<div style="display:flex;align-items:center;gap:8px;padding:6px 12px 6px ${pad}px;font-size:13px;border-left:2px solid ${sel?T.ocean:'transparent'};background:${sel?T.raised:'transparent'};color:${muted?T.muted:T.ink2};${sel?'font-weight:500;color:'+T.ink:''}">
    ${glyph ? ico(glyph,14,sel?T.ocean:T.muted) : `<span class="mono" style="font-size:12.5px;color:${color};flex-shrink:0">${kind==='fact'?'▣':kind==='dim'?'◇':kind==='grid'?'▤':'·'}</span>`}
    <span class="mono" style="font-size:12.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${glyph?'font-family:'+SANS+';font-size:13px':''}">${label}</span>
    ${status}
  </div>`;
}
function subjectRow(label, glyph, {open=false, sel=false, status=''}={}) {
  return `<div style="display:flex;align-items:center;gap:8px;padding:7px 12px 7px 14px;font-size:13.5px;border-left:2px solid ${sel?T.ocean:'transparent'};background:${sel?T.raised:'transparent'};color:${T.ink};${sel?'font-weight:500':''}">
    ${ico(open?'chevron':'chevronR',12,T.muted2)}${ico(glyph,15,sel?T.ocean:T.ink3)}<span style="flex:1">${label}</span>${status}</div>`;
}
const stOk = `<span title="built">${dot(T.ok)}</span>`;
const stWarn = `<span title="needs attention" style="display:inline-flex">${ico('alert',13,T.warn,1.8)}</span>`;
const stBuild = `<span title="building" style="width:9px;height:9px;border-radius:999px;border:1.5px dashed ${T.ocean};display:inline-block;flex-shrink:0"></span>`;

function tree({selected='fact_transaction_lines', subjectSel=null, sourceSel=null}={}) {
  return `<div style="width:260px;flex-shrink:0;box-sizing:border-box;background:${T.surface};border-right:1px solid ${T.line};display:flex;flex-direction:column;overflow:hidden">
  <div style="padding:12px 12px 8px">
    <div class="row" style="gap:8px;height:32px;border:1px solid ${T.line};background:${T.raised};border-radius:6px;padding:0 10px;color:${T.muted2};font-size:12.5px">${ico('search',13,T.muted2)}Find a table or subject…</div>
  </div>
  <div style="flex:1;overflow:auto;padding-bottom:12px">
    <div class="eyebrow" style="padding:8px 16px 4px">Subjects</div>
    ${subjectRow('Finance','landmark',{open:true, sel:subjectSel==='finance', status: subjectSel==='finance'?'':stOk})}
    ${treeRow('fact_transaction_lines',{sel:selected==='fact_transaction_lines', status: selected==='fact_transaction_lines'?'':stOk, indent:2})}
    ${treeRow('fact_receivables',{indent:2, status:stWarn})}
    ${treeRow('fact_payables',{indent:2, status:stOk})}
    ${subjectRow('Sales','receipt',{status:stOk})}
    ${subjectRow('Purchasing','cart',{status:stBuild})}
    <div class="eyebrow" style="padding:14px 16px 4px">Shared data</div>
    ${treeRow('dim_account',{kind:'dim',status:stOk})}
    ${treeRow('dim_item',{kind:'dim',status:stOk})}
    ${treeRow('dim_item_group',{kind:'dim',status:stOk})}
    ${treeRow('dim_gl_account',{kind:'dim',status:stOk})}
    ${treeRow('dim_journal',{kind:'dim',status:stOk})}
    ${treeRow('dim_payment_condition',{kind:'dim',status:stOk})}
    ${treeRow('dim_date',{kind:'dim',status:stOk})}
    <div class="eyebrow" style="padding:14px 16px 4px">Your tables</div>
    ${treeRow('budget_2026',{kind:'grid',status:`<span title="linked to Finance" style="display:inline-flex">${ico('link',12,T.grid)}</span>`})}
    <div class="eyebrow row" style="padding:14px 16px 4px;gap:6px">Sources <span style="font-weight:400;letter-spacing:0;text-transform:none;font-family:${SANS};font-size:11px">· read-only inputs</span></div>
    ${treeRow('Exact Online',{kind:'src',glyph:'database',status:`<span class="mono" style="font-size:10.5px;color:${T.muted2}">61</span>`, sel:sourceSel==='eo'})}
    ${treeRow('Odoo (staging)',{kind:'src',glyph:'database',status:`<span class="mono" style="font-size:10.5px;color:${T.muted2}">21</span>`, sel:sourceSel==='odoo'})}
    ${treeRow('Budget 2026.xlsx',{kind:'src',glyph:'sheet',status:`<span class="mono" style="font-size:10.5px;color:${T.muted2}">3</span>`})}
  </div>
  <div style="border-top:1px solid ${T.line};padding:10px 12px">
    <button class="btn" style="width:100%;justify-content:center">${ico('plus',14,T.ink3)}New subject</button>
  </div>
</div>`;
}

// SQL rendering — lines as [text, kind]; kind '' | 'add' | 'del'
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
    let bg='transparent', mark='&nbsp;', mc=T.muted2;
    if (kind==='add') { bg='rgba(63,122,92,0.22)'; mark='+'; mc='#86efac'; }
    if (kind==='del') { bg='rgba(164,58,58,0.25)'; mark='−'; mc='#fca5a5'; }
    return `<div style="display:flex;background:${bg}"><span style="width:34px;text-align:right;padding-right:10px;color:rgba(255,255,255,0.28);user-select:none;flex-shrink:0">${kind==='add'?'':i+1}</span><span style="width:12px;color:${mc};flex-shrink:0">${mark}</span><span style="white-space:pre;color:#e6edf3">${txt}</span></div>`;
  }).join('');
  return `<div class="mono" style="background:${T.ink};border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px 10px;font-size:12.5px;line-height:1.7;overflow:auto">${rows}</div>`;
}

function columnRow(name, type, role, extra='') {
  const rc = role==='measure'?[T.factSoft,T.fact]:role==='key'?[T.oceanSofter,T.ocean]:role==='fk'?[T.oceanSofter,T.ocean]:[T.softer,T.ink3];
  const rl = role==='fk'?'→ '+extra:role;
  return `<div style="display:grid;grid-template-columns:168px 66px 128px 1fr;gap:10px;align-items:center;padding:7px 12px;border-top:1px solid ${T.softer};font-size:13px">
    <span class="mono" style="font-size:12.5px">${name}</span>
    <span class="mono" style="font-size:11px;color:${T.muted}">${type}</span>
    <span><span class="chip" style="background:${rc[0]};color:${rc[1]}">${rl}</span></span>
    <span style="color:${T.ink3}">${role==='fk'?'':extra}</span>
  </div>`;
}

function lineageNode(label, sub, {kind='src', current=false}={}) {
  const col = kind==='fact'?T.fact:kind==='dim'?T.ocean:kind==='grid'?T.grid:T.muted;
  return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid ${current?T.ocean:T.line};border-left:3px solid ${col};background:${current?T.oceanSofter:T.raised};border-radius:6px">
    <div style="flex:1;min-width:0"><div class="mono" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${current?'font-weight:500':''}">${label}</div>${sub?`<div style="font-size:11px;color:${T.muted}">${sub}</div>`:''}</div></div>`;
}
const vline = `<div style="width:1px;height:10px;background:${T.lineStrong};margin:0 auto"></div>`;

function contextCol() {
  return `<div style="width:300px;flex-shrink:0;box-sizing:border-box;border-left:1px solid ${T.line};background:${T.surface};overflow:auto;padding:16px 16px 24px;display:flex;flex-direction:column;gap:22px">
  <div>
    <div class="eyebrow" style="margin-bottom:8px">Lineage</div>
    <div style="display:flex;flex-direction:column">
      ${lineageNode('Exact Online › TransactionLines','8 columns read')}
      <div style="height:6px"></div>
      ${lineageNode('Exact Online › GLAccounts','joined for the account type')}
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
      <div class="row" style="justify-content:space-between;font-size:12.5px"><span>Built 3 min ago</span><span class="mono" style="font-size:11px;color:${T.muted}">12,480 rows</span></div>
      <svg width="266" height="34" viewBox="0 0 266 34"><polyline fill="none" stroke="${T.ok}" stroke-width="1.5" points="0,26 30,25 60,25 90,24 120,25 150,23 180,24 210,22 240,21 266,20"/><polyline fill="none" stroke="${T.warn}" stroke-width="1.5" points="0,31 30,31 60,30 90,31 120,30 150,31 180,29 210,31 240,30 266,30"/></svg>
      <div class="row" style="gap:12px;font-size:11.5px;color:${T.ink3}"><span>${dot(T.ok)} +36 inserted</span><span>${dot(T.warn)} 2 updated</span><span>0 deleted</span></div>
      <div class="row" style="justify-content:space-between;font-size:12.5px;border-top:1px solid ${T.softer};padding-top:8px"><span>Checks</span><span style="color:${T.ok};font-weight:500">4 of 4 passing</span></div>
      <div class="row" style="justify-content:space-between;font-size:12.5px"><span>Refresh schedule</span><a href="#" style="font-size:12px">nightly 02:00 · on /pipelines</a></div>
    </div>
  </div>
  <div>
    <div class="eyebrow" style="margin-bottom:8px">History</div>
    <div style="display:flex;flex-direction:column;gap:9px;font-size:12.5px;color:${T.ink3};line-height:1.45">
      <div><span style="color:${T.ink}">You</span> kept the assistant's change <span class="mono" style="font-size:11px;color:${T.muted}">· 3 min ago</span><div style="color:${T.muted}">excluded the closing journal</div></div>
      <div><span style="color:${T.ink}">Ines</span> rewrote the description <span class="mono" style="font-size:11px;color:${T.muted}">· 12 Sep</span></div>
      <div><span style="color:${T.ink}">Clarion</span> built it from the Exact Online template <span class="mono" style="font-size:11px;color:${T.muted}">· 11 Sep</span></div>
    </div>
  </div>
</div>`;
}

function assistantPill() {
  return `<div style="position:absolute;bottom:20px;right:20px;display:flex;align-items:center;gap:8px;padding:10px 16px 10px 12px;border-radius:999px;border:1px solid ${T.line};background:${T.raised};box-shadow:0 6px 24px -8px rgba(15,32,45,0.30);font-size:13px;color:${T.ink2}">${ico('sparkles',15,T.ocean)}Ask or change this table</div>`;
}

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
      ${ico('sparkles',14,T.ai)}<span style="font-weight:500;color:#7a4f2b">Suggested change</span><span class="mono" style="font-size:11px;color:#7a4f2b">+2 −1</span>
      <span style="color:#7a4f2b">— exclude journal 90, the year-end closing journal, so month totals stop double-counting the close.</span>
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
    <div style="display:grid;grid-template-columns:168px 66px 128px 1fr;gap:10px;padding:6px 12px;background:${T.surface}" class="eyebrow"><span>Column</span><span>Type</span><span>Role</span><span>Meaning</span></div>
    ${columnRow('transaction_line_id','VARCHAR','key','The line’s own id in Exact Online.')}
    ${columnRow('transaction_date','DATE','fk','dim_date')}
    ${columnRow('gl_account_code','VARCHAR','fk','dim_gl_account')}
    ${columnRow('account_code','VARCHAR','fk','dim_account')}
    ${columnRow('journal_code','VARCHAR','fk','dim_journal')}
    ${columnRow('amount_dc','DOUBLE','measure',`Amount in EUR, additive. <span class="chip" style="background:${T.oceanSofter};color:${T.ocean}">${ico('quote',10,T.ocean)} your team calls this “net booking”</span>`)}
    ${columnRow('vat_amount_dc','DOUBLE','measure','VAT part of the amount, additive.')}
    ${columnRow('description','VARCHAR','attribute','Free text from the booking.')}
    <div style="padding:7px 12px;border-top:1px solid ${T.softer};font-size:12px;color:${T.muted}">+ 1 technical column, hidden from answers</div>
  </div>
  ${diff ? '' : assistantPill()}
</div>`;
}

// ── Board 1: Model — table selected ───────────────────────────────────────
writeFileSync('project/Main.dc.html', page('Model — table', 1440, 900,
  shell('model', `${tree()}${tableDeclaration()}${contextCol()}`)));

// ── Board 2: Model — assistant proposes a diff ────────────────────────────
function assistantOpen() {
  return `<div style="position:absolute;bottom:20px;right:20px;width:380px;max-height:560px;display:flex;flex-direction:column;border-radius:14px;border:1px solid ${T.line};background:${T.raised};box-shadow:0 16px 48px -16px rgba(15,32,45,0.38);overflow:hidden">
  <div class="row" style="padding:10px 16px;border-bottom:1px solid ${T.line};background:${T.soft};gap:10px"><span class="eyebrow">Assistant</span><span style="flex:1"></span>${ico('x',14,T.muted)}</div>
  <div class="row" style="padding:8px 16px;background:${T.oceanSofter};gap:8px;font-size:12px;color:${T.ocean}">${ico('branch',13,T.ocean)}Target: <span class="mono">fact_transaction_lines</span> <span style="flex:1"></span><span style="color:${T.muted}">change scope ▾</span></div>
  <div style="padding:14px 16px;display:flex;flex-direction:column;gap:14px;overflow:auto">
    <div class="serif" style="font-style:italic;font-size:13.5px;text-align:right;color:${T.ink2}">Month totals include the year-end close. Leave those out.</div>
    <div style="font-size:13px;line-height:1.55;color:${T.ink2}">
      <p style="margin:0 0 8px">Exact Online books the year-end close on journal <span class="mono">90</span> (Exact’s docs call it the <em>closing journal</em>; it is referenced by <span class="mono">Code</span>). I checked: 1,148 of your 12,480 lines are on it, all dated 31 Dec.</p>
      <p style="margin:0 0 8px">I’ve put the change on the SQL above — one extra condition, nothing else moves. Keep it and I’ll rebuild this table and the four that read from it.</p>
      <div class="row" style="gap:6px;font-size:12px;color:${T.muted}">${ico('check',12,T.ok)} Previewed: 11,332 rows, same columns</div>
    </div>
    <div style="border-top:1px solid ${T.softer};padding-top:10px;font-size:12px;color:${T.muted}">Earlier · <span style="color:${T.ink3}">“What does AmountDC mean?”</span> · answered from the vendor docs</div>
  </div>
  <div style="padding:10px 12px;border-top:1px solid ${T.line}">
    <div class="row" style="gap:8px;border:1px solid ${T.line};border-radius:8px;padding:8px 10px;font-size:13px;color:${T.muted2}"><span style="flex:1">Ask, or say what to change…</span><span style="width:26px;height:26px;border-radius:6px;background:${T.ocean};display:flex;align-items:center;justify-content:center">${ico('arrowR',13,'#fff')}</span></div>
  </div>
</div>`;
}
writeFileSync('project/Model-Diff.dc.html', page('Model — AI proposes a change', 1440, 900,
  shell('model', `${tree()}<div style="flex:1;min-width:0;display:flex;position:relative">${tableDeclaration({diff:true})}${contextCol()}${assistantOpen()}</div>`)));

// ── Board 3: Model — subject selected ─────────────────────────────────────
function subjectCard(name, q, status, rows) {
  const [fg, txt, glyph] = status==='ok'?[T.ok,'built 3 min ago',dot(T.ok)]:status==='warn'?[T.warn,'needs attention',ico('alert',13,T.warn,1.8)]:[T.ocean,'building…',''];
  return `<a href="#" class="card" style="padding:12px 14px;display:flex;flex-direction:column;gap:6px;color:${T.ink};border-left:3px solid ${T.fact};min-width:0">
    <div class="row" style="gap:8px;min-width:0"><span class="mono" style="font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${name}</span>${glyph}</div>
    <div style="font-size:12.5px;color:${T.ink3};line-height:1.45">${q}</div>
    <div class="mono" style="font-size:11px;color:${T.muted};line-height:1.5"><span style="color:${fg}">${txt}</span> · ${rows}</div>
  </a>`;
}
function starMini() {
  // fact centre, 4 dims around
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
  <div class="row" style="gap:8px;margin-bottom:4px"><span class="eyebrow">Subject</span><span class="eyebrow">›</span><span class="eyebrow">Exact Online</span></div>
  <div class="row" style="gap:14px;margin-bottom:6px">
    <div style="width:34px;height:34px;border-radius:8px;background:${T.oceanSofter};display:flex;align-items:center;justify-content:center">${ico('landmark',18,T.ocean)}</div>
    <h1 class="serif" style="margin:0;font-size:26px;font-weight:400;letter-spacing:-0.02em">Finance</h1>
    <span style="flex:1"></span>
    <button class="btn btn-ghost">${ico('eye',14,T.ink3)}Shown on Subjects</button>
    <button class="btn btn-ghost">Rebuild AI-owned tables…</button>
    <button class="btn btn-ghost" aria-label="More" style="padding:7px 8px">${ico('more',15,T.ink3)}</button>
  </div>
  <div class="row" style="gap:14px;font-size:12.5px;color:${T.ink3};margin-bottom:22px"><span class="row" style="gap:6px">${dot(T.ok)} 3 tables built</span><span>·</span><span>1 needs attention</span><span>·</span><span>7 shared lookups</span><span>·</span><span>built from the Exact Online template, 2 tables declared by you</span></div>

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
  ${assistantPill().replace('Ask or change this table','Ask or change this subject')}
</div>`;
}
function subjectContext() {
  return `<div style="width:300px;flex-shrink:0;box-sizing:border-box;border-left:1px solid ${T.line};background:${T.surface};overflow:auto;padding:16px 16px 24px;display:flex;flex-direction:column;gap:22px">
  <div><div class="eyebrow" style="margin-bottom:8px">Lineage</div>
    ${lineageNode('Exact Online','TransactionLines · Receivables · Payables · 6 more')}
    ${vline}
    ${lineageNode('Finance','3 measures tables',{kind:'fact',current:true})}
    ${vline}
    ${lineageNode('7 shared lookups','owned by Shared data',{kind:'dim'})}
    <div style="margin-top:10px;font-size:12.5px;color:${T.ink3};line-height:1.5"><span style="color:${T.ink};font-weight:500">Used by</span> 4 dashboards · 21 saved questions · the morning brief</div></div>
  <div><div class="eyebrow" style="margin-bottom:8px">Needs attention</div>
    <div class="card" style="padding:10px 12px;border-left:3px solid ${T.warn};font-size:12.5px;line-height:1.5"><span class="mono">fact_receivables</span> — Exact Online stopped providing <span class="mono">DueDate</span>. Clarion built it without that column so answers keep working, narrower. <a href="#">Open the table →</a></div></div>
  <div><div class="eyebrow" style="margin-bottom:8px">Health</div>
    <div class="card" style="padding:10px 12px;display:flex;flex-direction:column;gap:6px;font-size:12.5px">
      <div class="row" style="justify-content:space-between"><span>Last refresh</span><span>3 min ago</span></div>
      <div class="row" style="justify-content:space-between"><span>Checks</span><span style="color:${T.ok};font-weight:500">11 of 12 passing</span></div>
      <div class="row" style="justify-content:space-between"><span>Schedule</span><a href="#" style="font-size:12px">nightly 02:00</a></div></div></div>
  <div><div class="eyebrow" style="margin-bottom:8px">History</div>
    <div style="display:flex;flex-direction:column;gap:9px;font-size:12.5px;color:${T.ink3};line-height:1.45">
      <div><span style="color:${T.ink}">You</span> changed <span class="mono">fact_transaction_lines</span> <span class="mono" style="font-size:11px;color:${T.muted}">· 3 min ago</span></div>
      <div><span style="color:${T.ink}">Clarion</span> flagged <span class="mono">fact_receivables</span> <span class="mono" style="font-size:11px;color:${T.muted}">· today 02:04</span></div>
      <div><span style="color:${T.ink}">Ines</span> added the metric “Gross margin %” <span class="mono" style="font-size:11px;color:${T.muted}">· 14 Sep</span></div></div></div>
</div>`;
}
writeFileSync('project/Model-Subject.dc.html', page('Model — subject', 1440, 900,
  shell('model', `${tree({selected:null, subjectSel:'finance'})}${subjectDeclaration()}${subjectContext()}`)));

// ── Board 4: Model — a source with no subjects yet (Build folded in) ───────
function planPanel() {
  const plan = (glyph, name, desc, kpis) => `<div class="card" style="padding:14px 16px;display:flex;gap:12px">
    <div style="width:32px;height:32px;border-radius:8px;background:${T.oceanSofter};display:flex;align-items:center;justify-content:center;flex-shrink:0">${ico(glyph,17,T.ocean)}</div>
    <div style="flex:1;min-width:0"><div style="font-weight:500;font-size:14px">${name}</div><div style="font-size:13px;color:${T.ink3};line-height:1.5;margin:2px 0 6px">${desc}</div><div style="font-size:12px;color:${T.muted}">You’ll see: ${kpis}</div></div></div>`;
  return `<div style="flex:1;min-width:0;overflow:auto;padding:22px 32px 40px;position:relative">
  <div class="row" style="gap:8px;margin-bottom:4px"><span class="eyebrow">Source</span><span class="eyebrow">›</span><span class="eyebrow">read-only inputs</span></div>
  <div class="row" style="gap:14px;margin-bottom:6px">
    <div style="width:34px;height:34px;border-radius:8px;background:${T.oceanSofter};display:flex;align-items:center;justify-content:center">${ico('database',18,T.ocean)}</div>
    <h1 class="serif" style="margin:0;font-size:26px;font-weight:400;letter-spacing:-0.02em">Odoo (staging)</h1>
    <span style="flex:1"></span><a href="#" style="font-size:12.5px">Manage the connection on Sources →</a>
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
  ${assistantPill().replace('Ask or change this table','Ask what this source contains')}
</div>`;
}
writeFileSync('project/Model-NewSubject.dc.html', page('Model — new subjects from a source', 1440, 900,
  shell('model', `${tree({selected:null, sourceSel:'odoo'})}${planPanel()}`)));

// ── Board 5: Definitions ──────────────────────────────────────────────────
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

    <div class="row" style="gap:10px;margin:0 0 10px"><span class="eyebrow">Finance</span><a href="#" style="font-size:12px">open in Model →</a></div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:26px">
      ${defCard({kind:'metric',name:'Outstanding receivables',q:'Who owes me money right now?',body:'Sum of the open amount on unpaid sales invoices, today. <span style="color:'+T.muted+'">Formula ▸</span>',addr:'<span class="mono">fact_receivables.open_amount</span>',meta:'On the Finance topic page · watched by 2 people'})}
      ${defCard({kind:'metric',name:'Invoiced sales revenue',q:'How much did I invoice this month?',body:'Net amount of sales invoice lines, credit notes included. <span style="color:'+T.muted+'">Formula ▸</span>',addr:'<span class="mono">fact_sales_invoice_lines.net_amount</span>'})}
      ${defCard({kind:'verified',name:'How much is overdue by more than 60 days?',body:'Answered from <span class="mono">fact_receivables</span> · verified by Arno, 9 Sep · 11 uses',meta:'Anyone asking exactly this gets the verified answer, no model call.'})}
    </div>

    <div class="row" style="gap:10px;margin:0 0 10px"><span class="eyebrow">Sales</span><a href="#" style="font-size:12px">open in Model →</a></div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:26px">
      ${defCard({kind:'metric',name:'Gross margin %',q:'What margin did we make on what we sold?',body:'(Net revenue − cost of goods) ÷ net revenue, per invoice line. <span style="color:'+T.muted+'">Formula ▸</span>',addr:'<span class="mono">fact_sales_invoice_lines</span>'})}
    </div>
    <div class="eyebrow" style="margin:0 0 10px;color:${T.muted2}">Legacy · 2 source-level KPIs still read by reports</div>
  </div>
  ${editing?'':assistantPill().replace('Ask or change this table','Ask what a word means here')}
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

// ── Board 7: Topic page (Manage mode retired) ─────────────────────────────
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
      <a href="#" class="row" style="gap:6px">${ico('branch',13,T.ocean)}Edit in Model →</a>
      <a href="#" class="row" style="gap:6px">${ico('quote',13,T.ocean)}Definitions →</a>
      <span style="color:${T.muted}">visible to you as an analyst</span>
    </div>
  </div>
</div>`;
}
writeFileSync('project/Topic.dc.html', page('Topic page — Manage mode retired', 1440, 900, shell('subjects', topicPage())));

// ── Board 8: Catalog table page (read-only, links to Model) ───────────────
function catalogTable() {
  const cell = (v, right=false) => `<td style="padding:7px 10px;border-top:1px solid ${T.softer};font-size:12.5px;${right?'text-align:right;font-family:'+MONO+';font-size:12px':''}">${v}</td>`;
  const rows = [['2026-09-03','8000','Van Damme BVBA','70','1,240.00','260.40'],['2026-09-03','7000','Peeters NV','70','−310.00','−65.10'],['2026-09-04','440000','Colruyt Group','60','5,900.00','0.00'],['2026-09-04','8000','Delhaize','70','812.50','170.63']].map(r=>`<tr>${cell(r[0])}${cell('<span class="mono">'+r[1]+'</span>')}${cell(r[2])}${cell('<span class="mono">'+r[3]+'</span>')}${cell(r[4],true)}${cell(r[5],true)}</tr>`).join('');
  const tab = (l,a=false)=>`<span style="padding:10px 14px;font-size:13px;position:relative;${a?`font-weight:500;color:${T.ink}`:`color:${T.muted}`}">${l}${a?`<span style="position:absolute;left:8px;right:8px;bottom:0;height:2px;border-radius:2px;background:${T.ocean}"></span>`:''}</span>`;
  return `<div style="flex:1;min-width:0;display:flex">
    <div style="width:280px;flex-shrink:0;border-right:1px solid ${T.line};background:${T.surface};padding:12px 0">
      <div class="eyebrow" style="padding:4px 16px 8px">Browse · Trust</div>
      <div style="padding:0 12px 10px"><div class="row" style="gap:8px;height:32px;border:1px solid ${T.line};background:${T.raised};border-radius:6px;padding:0 10px;color:${T.muted2};font-size:12.5px">${ico('search',13,T.muted2)}Search the catalog…</div></div>
      <div class="eyebrow" style="padding:8px 16px 4px">Subjects</div>
      ${subjectRow('Finance','landmark',{open:true})}
      ${treeRow('fact_transaction_lines',{indent:2,sel:true})}
      ${treeRow('fact_receivables',{indent:2})}
      ${treeRow('fact_payables',{indent:2})}
      ${subjectRow('Sales','receipt')}${subjectRow('Purchasing','cart')}
      <div class="eyebrow" style="padding:14px 16px 4px">Shared data</div>
      ${treeRow('dim_account',{kind:'dim'})}${treeRow('dim_gl_account',{kind:'dim'})}${treeRow('dim_journal',{kind:'dim'})}
      <div class="eyebrow" style="padding:14px 16px 4px">Sources</div>
      ${treeRow('Exact Online',{kind:'src',glyph:'database'})}
    </div>
    <div style="flex:1;min-width:0;overflow:auto">
      <div style="background:${T.raised};border-bottom:1px solid ${T.line};padding:18px 28px 0">
        <div class="row" style="gap:8px;margin-bottom:4px"><span class="eyebrow">Finance</span><span class="eyebrow">›</span><span class="eyebrow" style="color:${T.fact}">Measures table</span></div>
        <div class="row" style="gap:14px"><h1 class="serif" style="margin:0;font-size:24px;font-weight:400;letter-spacing:-0.02em">GL transaction lines</h1><span class="mono" style="font-size:12px;color:${T.muted}">fact_transaction_lines</span><span style="flex:1"></span><a href="#" class="btn" style="gap:6px">${ico('branch',14,T.ocean)}Edit in Model →</a></div>
        <div class="row" style="gap:14px;font-size:12.5px;color:${T.ink3};margin:6px 0 10px"><span class="row" style="gap:6px">${dot(T.ok)} Built 3 min ago</span><span>·</span><span>12,480 rows</span><span>·</span><span>Exact Online</span></div>
        <div class="row">${tab('Overview',true)}${tab('Columns')}${tab('Lineage')}${tab('Quality')}${tab('History')}</div>
      </div>
      <div style="padding:22px 28px;display:flex;flex-direction:column;gap:22px;max-width:900px">
        <div><div class="eyebrow" style="margin-bottom:8px">Sample rows</div>
          <div class="card" style="overflow:hidden"><table style="border-collapse:collapse;width:100%"><thead><tr>${['date','gl account','account','journal','amount','vat'].map(h=>`<th class="eyebrow" style="text-align:left;padding:7px 10px;background:${T.surface};font-weight:500">${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></div>
        <div><div class="eyebrow" style="margin-bottom:6px">What is this?</div><p style="margin:0;font-size:14.5px;line-height:1.6;color:${T.ink2}">Every posted journal entry line from Exact Online, with the amount in EUR and the GL account, customer/supplier account and journal it was posted to. Credit notes arrive natively negative. One row is one processed general-ledger transaction line.</p>
          <div style="font-size:12px;color:${T.muted};margin-top:6px">Written by you in Model · the SQL lives there too</div></div>
        <div><div class="eyebrow" style="margin-bottom:8px">Where it comes from, what it feeds</div>
          <div style="display:grid;grid-template-columns:1fr auto 1fr auto 1fr;gap:10px;align-items:center">
            <div style="display:flex;flex-direction:column;gap:6px">${lineageNode('Exact Online › TransactionLines','8 columns')}${lineageNode('Exact Online › GLAccounts','join')}</div>
            ${ico('arrowR',16,T.lineStrong)}
            ${lineageNode('fact_transaction_lines','this table',{kind:'fact',current:true})}
            ${ico('arrowR',16,T.lineStrong)}
            <div style="display:flex;flex-direction:column;gap:6px">${lineageNode('2 dashboards','Cash position · Overdue receivables',{kind:'dim'})}${lineageNode('6 saved questions','3 verified',{kind:'dim'})}</div>
          </div></div>
      </div>
    </div>
  </div>`;
}
writeFileSync('project/Catalog-Table.dc.html', page('Catalog — table page, read-only', 1440, 900, shell('catalog', catalogTable())));

// ── Board 9: Rail before / after ──────────────────────────────────────────
function railCompare() {
  const col = (title, note, r) => `<div style="display:flex;flex-direction:column;gap:10px"><div><div class="eyebrow">${title}</div><div style="font-size:12.5px;color:${T.ink3};line-height:1.5;max-width:220px">${note}</div></div><div style="height:640px;display:flex;border:1px solid ${T.line};border-radius:10px;overflow:hidden">${r}</div></div>`;
  return `<div style="width:760px;height:760px;box-sizing:border-box;background:${T.bg};padding:28px;display:flex;gap:40px;font-family:${SANS}">
    ${col('Studio today','Build, Relations (with a Topics toggle) and the off-rail workshop each hold part of the model.', rail('build',{before:true}))}
    ${col('Studio proposed','Two new entries. Build folds into Model’s empty state. Relations keeps the source canvas only. Catalog moves last: it is the reading room, not the workshop.', rail('model'))}
  </div>`;
}
writeFileSync('project/Rail.dc.html', page('Rail — before and after', 760, 760, railCompare()));

// ── Board 10: What goes where ─────────────────────────────────────────────
function mapBoard() {
  const rows = [
    ['/build · Build page (883) + AskPanel','Model → source node (plan panel, run panel, hide toggle)'],
    ['/products · workshop (915) + BuildDashboard (479)','Retired · subject view in Model'],
    ['/products/[id] · ProductRootPanel (1,053) + TableNotebook (681)','Retired · the declaration + Preview in Model'],
    ['RefineChat (986) · AskAIPanel (640) · KPI AI draft','One assistant in Model / Definitions, proposals as diffs'],
    ['Topic page → Manage mode (ManageLayer 453 + ManageTables 670)','Retired · “Edit in Model →” for curators'],
    ['Manage → Metrics (KpiManager 506)','Definitions'],
    ['Catalog → Glossary facet (GlossaryPanel 475)','Definitions (facet redirects)'],
    ['Catalog product / table pages','Stay, read-only · lose SQL viewer and edit forms · “Edit in Model →”'],
    ['/relationships → Topics toggle (TopicsCanvas 600)','Retired · joins drawn in Model. Sources canvas stays'],
    ['/shared-data','Stays · cards link to Model for curators'],
    ['/pipelines · /notebooks · Ask · Dashboards · Topic page (viewers)','Unchanged'],
  ];
  return `<div style="width:1100px;height:720px;box-sizing:border-box;background:${T.bg};padding:32px 36px;font-family:${SANS};display:flex;flex-direction:column;gap:14px">
    <div><h1 class="serif" style="margin:0 0 4px;font-size:24px;font-weight:400;letter-spacing:-0.02em">What goes where</h1><div style="font-size:13.5px;color:${T.ink3}">Every surface that touched a table’s SQL, lineage, metrics or definitions, and where it lands. Line counts are today’s.</div></div>
    <div class="card" style="overflow:hidden">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:8px 16px;background:${T.surface}" class="eyebrow"><span>Today</span><span>Target</span></div>
      ${rows.map(([a,b])=>`<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:10px 16px;border-top:1px solid ${T.softer};font-size:13.5px;line-height:1.45"><span style="color:${T.ink2}">${a}</span><span style="${/Retired|Stays|Unchanged/.test(b)?'':'font-weight:500'}">${b}</span></div>`).join('')}
    </div>
    <div style="font-size:12.5px;color:${T.muted}">About 6,900 lines retired against roughly 2,000 new. The engine (runner, checks, lineage derivation, refresh) is untouched; the backend change is one PUT that validates, stores once, and rebuilds.</div>
  </div>`;
}
writeFileSync('project/Map.dc.html', page('What goes where', 1100, 720, mapBoard()));

// ── canvas.json ───────────────────────────────────────────────────────────
const now = new Date().toISOString();
const boards = {
  'Main.dc.html':             {x:0,    y:0,    w:1440,h:900, title:'Model — a table’s declaration'},
  'Model-Diff.dc.html':       {x:1520, y:0,    w:1440,h:900, title:'Model — the assistant proposes a change'},
  'Model-Subject.dc.html':    {x:3040, y:0,    w:1440,h:900, title:'Model — a subject'},
  'Model-NewSubject.dc.html': {x:4560, y:0,    w:1440,h:900, title:'Model — a source with no subjects yet (Build folded in)'},
  'Definitions.dc.html':      {x:0,    y:1220, w:1440,h:900, title:'Definitions'},
  'Definitions-Edit.dc.html': {x:1520, y:1220, w:1440,h:900, title:'Definitions — editing “Active customer”'},
  'Topic.dc.html':            {x:0,    y:2440, w:1440,h:900, title:'Topic page — unchanged for viewers, Manage mode gone'},
  'Catalog-Table.dc.html':    {x:1520, y:2440, w:1440,h:900, title:'Catalog table page — read-only, one door to Model'},
  'Rail.dc.html':             {x:3040, y:2440, w:760, h:760, title:'Studio rail — before / after'},
  'Map.dc.html':              {x:3880, y:2440, w:1100,h:720, title:'What goes where'},
};
const canvas = {
  v:3, createdOnFiles:{v:1, at:now}, title:'Clarion Declarative Workspace',
  launch:{view:'canvas'}, pages:[], boards, order:Object.keys(boards),
  notes:{
    n1:{x:0,y:-300,text:'Model — declare a table, Clarion does the rest',kind:'title1',maxW:6000},
    n2:{x:0,y:920,text:'Definitions — the words your team uses, written once',kind:'title1',maxW:2960},
    n3:{x:0,y:2140,text:'Affected pages — what stays, what goes',kind:'title1',maxW:4980},
    s1:{x:6080,y:0,w:360,text:'Reading order: left to right. Board 1 is the everyday screen: tree · declaration · context. Board 2 is the same screen while the assistant proposes a diff (Keep = Save). Board 3 selects a subject instead of a table. Board 4 is a source with no subjects — today’s Build page, inside Model.',fill:'blue'},
    s2:{x:3040,y:1220,w:360,text:'Three kinds, one card: term (glossary), metric (product KPI), verified answer (saved question). Documented, not executed. “In the data” is the existing glossary link — the AI is told to use exactly that column.',fill:'blue'},
  },
  designSystems:[],
};
writeFileSync('project/canvas.json', JSON.stringify(canvas, null, 2));
console.log('ok', Object.keys(boards).length, 'boards');
