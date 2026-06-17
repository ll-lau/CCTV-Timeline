/* =====================================================================
 * "Who Held the Ball": handoff & turnaround timeline
 *
 * Reads timeline_data.json and builds the delay story: a line zig-zags
 * between YCH (top) and CPMM (bottom) on every handoff; long waits become
 * coloured ribbons; CPMM comment rounds are numbered so the "endless
 * comments" are countable.
 *
 * All metrics are computed symmetrically from the dated events and shown
 * honestly (see the audit footnote).
 * ===================================================================== */
(() => {
  'use strict';

  /* ---------- Config ---------- */
  const TODAY_ISO = '2026-06-16';
  const STALL_DAYS = 30;          // handoff gap at/above this becomes a "stall" ribbon
  const FUND_STALL_DAYS = 60;     // funding gap threshold
  const DAY = 86400000;

  const PALETTE = {
    YCH:  { color: 'var(--ych)',  label: 'YCH action',  desc: 'TMS / FMD / Security / Supplies' },
    MEET: { color: 'var(--meet)', label: 'Meeting',     desc: 'User meetings (YCH-side)' },
    CPMM: { color: 'var(--cpmm)', label: 'CPMM action', desc: 'CPMM' },
    FUND: { color: 'var(--fund)', label: 'Funding',     desc: 'Funding approval chain' },
  };
  const LEGEND_ORDER = ['YCH', 'MEET', 'CPMM', 'FUND'];

  // Hex literals for fills set as SVG attributes (var() does not resolve in presentation attributes).
  const BAND = { ych: '#eef4ff', cpmm: '#fff3ea', fund: '#f1f5f9' };

  // Milestone ring stroke hex (attributes) + the key milestones to highlight, keyed by lane + primary date.
  const CAT_HEX = { YCH: '#2563eb', MEET: '#14b8a6', CPMM: '#ea580c', FUND: '#64748b' };
  const KEY = {
    'Funding Approval':  new Set(['2022-12-21', '2023-12-13', '2024-03-28', '2024-04-15', '2024-04-16', '2024-08-13', '2025-08-12']),
    'Former Tendering':  new Set(['2022-07-21', '2023-03-01', '2023-04-11', '2023-08-07', '2025-04-29']),
    'Current Tendering': new Set(['2025-03-01', '2025-07-31', '2026-04-17']),
  };
  const isKey = (name, pIso) => !!KEY[name] && KEY[name].has(pIso);

  const GEO = {
    marginLeft: 150, marginRight: 26, marginTop: 40,
    fundStripH: 24, fundGap: 12,
    tenderRowH: 96, rowGap: 18,
    ychOffset: 28,        // center of YCH sub-band within a tender row
    cpmmOffset: 70,       // center of CPMM sub-band
    axisH: 30,
    dotR: 4.5, hitR: 10,
    stackRow: 9, cluster: 11, minGap: 10,
  };

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const ms = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const fmtDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
  const shortDate = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const sideOf = (cat) => (cat === 'CPMM' ? 'CPMM' : (cat === 'FUND' ? null : 'YCH'));
  const isComment = (e) => e.cat === 'CPMM' && (
    /comment/i.test(e.text) || (/clarification/i.test(e.text) && /request|requir/i.test(e.text))
  );

  const summary = (arr) => {
    if (!arr.length) return { n: 0, avg: 0, med: 0, max: 0, total: 0 };
    const s = [...arr].sort((a, b) => a - b);
    const avg = arr.reduce((x, y) => x + y, 0) / arr.length;
    const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    return { n: arr.length, avg: Math.round(avg), med: Math.round(med), max: s[s.length - 1], total: arr.reduce((x, y) => x + y, 0) };
  };

  /* ---------- State ---------- */
  let PROC = null, layout = null, data = null;
  const focusedCats = new Set();
  let pinnedEl = null;            // pinned node OR stall element

  const chartHost = document.getElementById('chart-host');
  const tooltip = document.getElementById('tooltip');
  const legendEl = document.getElementById('legend');
  const headlineEl = document.getElementById('headline');
  const footnoteBody = document.querySelector('.footnote-body');
  const fsToggle = document.getElementById('fs-toggle');

  /* ---------- Fullscreen presentation toggle ---------- */
  function setupFullscreen() {
    if (!fsToggle) return;
    const sync = () => {
      const on = !!document.fullscreenElement;
      fsToggle.classList.toggle('is-fs', on);
      fsToggle.title = on ? 'Exit fullscreen (Esc)' : 'Fullscreen presentation';
    };
    fsToggle.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.();
    });
    document.addEventListener('fullscreenchange', sync);
    sync();
  }

  /* ---------- Init ---------- */
  async function init() {
    setupFullscreen();
    try {
      const res = await fetch('timeline_data.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (e) {
      chartHost.innerHTML =
        `<div class="error">Could not load <code>timeline_data.json</code>.<br>${escapeHtml(e.message)}<br><br>`
        + `Serve the project over HTTP (e.g. <code>python3 -m http.server</code> in this folder) `
        + `and open the page. Direct <code>file://</code> open is blocked by CORS.`;
      return;
    }
    processData();
    buildLegend();
    render();
    window.addEventListener('resize', debounce(render, 150));
    document.addEventListener('click', onDocClick);
  }

  const byName = (n) => data.lanes.find((l) => l.name === n);

  /* ---------- Process data (width-independent; compute once) ---------- */
  function processData() {
    const evList = (lane, name) => lane.events.map((e) => ({
      cat: e.cat, text: e.text, allDates: e.dates, displayDate: e.date,
      ms: ms(e.primary), side: sideOf(e.cat), pIso: e.primary, keyMs: isKey(name, e.primary),
    })).sort((a, b) => a.ms - b.ms);

    const former  = evList(byName('Former Tendering'), 'Former Tendering');
    const current = evList(byName('Current Tendering'), 'Current Tendering');
    const funding = byName('Funding Approval').events.map((e) => ({
      cat: 'FUND', text: e.text, allDates: e.dates, displayDate: e.date,
      ms: ms(e.primary), side: null, pIso: e.primary, keyMs: isKey('Funding Approval', e.primary),
    })).sort((a, b) => a.ms - b.ms);

    // Number every CPMM comment round chronologically across both tendering phases.
    [...former, ...current].filter(isComment).sort((a, b) => a.ms - b.ms)
      .forEach((e, i) => { e.commentNo = i + 1; });
    const commentRounds = [...former, ...current].filter(isComment).length;

    // Segments between consecutive events.
    const tenderSegs = (evs) => {
      const out = [];
      for (let i = 0; i < evs.length - 1; i++) {
        const a = evs[i], b = evs[i + 1];
        const gap = Math.round((b.ms - a.ms) / DAY);
        const handoff = a.side !== b.side;
        out.push({ a, b, gap, handoff, responder: b.side, stall: handoff && gap >= STALL_DAYS });
      }
      return out;
    };
    const formerSegs = tenderSegs(former);
    const currentSegs = tenderSegs(current);

    const fundSegs = [];
    for (let i = 0; i < funding.length - 1; i++) {
      const a = funding[i], b = funding[i + 1];
      const gap = Math.round((b.ms - a.ms) / DAY);
      fundSegs.push({ a, b, gap, stall: gap >= FUND_STALL_DAYS });
    }

    // Headline metrics.
    const ychAct  = [...former, ...current].filter((e) => e.side === 'YCH').length;
    const cpmmAct = [...former, ...current].filter((e) => e.side === 'CPMM').length;
    const turn = { YCH: [], CPMM: [] };
    [formerSegs, currentSegs].forEach((ss) => ss.forEach((s) => { if (s.handoff) turn[s.responder].push(s.gap); }));
    const ychT = summary(turn.YCH), cpmmT = summary(turn.CPMM);

    let fundMax = 0, fundMaxSeg = null;
    fundSegs.forEach((s) => { if (s.gap > fundMax) { fundMax = s.gap; fundMaxSeg = s; } });
    let bigStall = null;
    [...formerSegs, ...currentSegs].forEach((s) => { if (s.stall && (!bigStall || s.gap > bigStall.gap)) bigStall = s; });

    // Domain across everything + today.
    let minMs = Infinity, maxMs = -Infinity;
    [...former, ...current, ...funding].forEach((e) => { if (e.ms < minMs) minMs = e.ms; if (e.ms > maxMs) maxMs = e.ms; });
    const todayMs = ms(TODAY_ISO);
    const rawMin = minMs, rawMax = Math.max(maxMs, todayMs);
    if (todayMs > maxMs) maxMs = todayMs;
    const span = maxMs - minMs, pad = Math.max(span * 0.012, 6 * DAY);
    minMs -= pad; maxMs += pad;
    const spanYears = (rawMax - rawMin) / DAY / 365;

    PROC = {
      former, formerSegs, current, currentSegs, funding, fundSegs,
      commentRounds, ychAct, cpmmAct, ychT, cpmmT, fundMax, fundMaxSeg, bigStall,
      minMs, maxMs, todayMs, spanYears,
    };
    fillHeadline();
    fillFootnote();
  }

  /* ---------- Headline + footnote ---------- */
  function fillHeadline() {
    const P = PROC;
    const yrs = P.spanYears.toFixed(1);
    const cards = [
      { k: 'cpmm', num: `${P.commentRounds}`, lbl: `CPMM comment rounds — feedback in ${P.commentRounds} separate rounds, each requiring a YCH revision` },
      { k: 'ych',  num: `${P.ychAct}<small> vs ${P.cpmmAct}</small>`, lbl: `YCH vs CPMM recorded actions across tendering` },
      { k: 'meet', num: `~${P.ychT.med}<small> d</small>`, lbl: `YCH median turnaround on CPMM comments` },
      { k: 'fund', num: `${P.fundMax}<small> d</small>`, lbl: `Longest single stall — HHB funding approval (Aug 2024 → Aug 2025)` },
      { k: 'neutral', num: `${yrs}<small> yrs</small>`, lbl: `Project elapsed, May 2022 → Jun 2026` },
    ];
    headlineEl.innerHTML = cards.map((c) =>
      `<div class="stat ${c.k}"><div class="num">${c.num}</div><span class="lbl">${c.lbl}</span></div>`
    ).join('');
  }

  function fillFootnote() {
    const P = PROC;
    footnoteBody.innerHTML = `
      <p><b>Side mapping.</b> Each event's actor side comes straight from the data's <code>cat</code> field:
      <code>CPMM</code> → CPMM; <code>YCH</code> &amp; <code>MEET</code> → YCH; <code>FUND</code> → its own funding track.</p>
      <p><b>Turnaround (symmetric).</b> Within each tendering phase, events are ordered by date; for every
      consecutive pair where the side <i>changes</i>, the elapsed days are attributed to the <i>responding</i>
      side (the 2nd event). Identical rule for both sides — no asymmetry.</p>
      <p><b>Result.</b> YCH responded in ${P.ychT.n} handoffs (avg ${P.ychT.avg} d, median ${P.ychT.med} d, max ${P.ychT.max} d, total ${P.ychT.total} d);
      CPMM responded in ${P.cpmmT.n} handoffs (avg ${P.cpmmT.avg} d, median ${P.cpmmT.med} d, max ${P.cpmmT.max} d, total ${P.cpmmT.total} d).
      Per-response speed is comparable — the drag is the <i>number</i> of rounds (${P.commentRounds}), not slow replies.</p>
      <p><b>Stall ribbon.</b> Any handoff gap ≥ ${STALL_DAYS} days is drawn as a ribbon tinted by the responding side;
      funding gaps ≥ ${FUND_STALL_DAYS} days are ribboned on the funding track. Every ribbon is hoverable for its details.</p>
      <p><b>Comment-round count.</b> CPMM feedback events are numbered chronologically — text matching
      <code>/comment/i</code>, or a clarification <i>requested/required</i> by CPMM. EOI issue/close are
      treated as CPMM actions (per the agreed categorisation).</p>`;
  }

  /* ---------- Legend ---------- */
  function buildLegend() {
    legendEl.innerHTML = '';
    LEGEND_ORDER.forEach((cat) => {
      const p = PALETTE[cat];
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'legend-item';
      item.dataset.cat = cat;
      item.innerHTML =
        `<span class="swatch" style="background:${p.color}"></span>`
        + `<span class="legend-text"><span class="legend-label">${escapeHtml(p.label)}</span>`
        + `<span class="legend-desc">${escapeHtml(p.desc)}</span></span>`;
      item.addEventListener('click', () => {
        if (focusedCats.has(cat)) focusedCats.delete(cat); else focusedCats.add(cat);
        item.classList.toggle('active', focusedCats.has(cat));
        legendEl.querySelectorAll('.legend-item').forEach((li) =>
          li.classList.toggle('dim', focusedCats.size > 0 && !focusedCats.has(li.dataset.cat)));
        applyFocus();
      });
      legendEl.appendChild(item);
    });
    // Static (non-filter) legend entry for key milestones.
    const note = document.createElement('span');
    note.className = 'legend-note';
    note.innerHTML = '<span class="ring-swatch"></span>'
      + '<span class="legend-text"><span class="legend-label">Key milestone</span>'
      + '<span class="legend-desc">ringed marker + date</span></span>';
    legendEl.appendChild(note);
  }

  function applyFocus() {
    const dots = chartHost.querySelectorAll('.dot');
    if (focusedCats.size === 0) dots.forEach((d) => d.classList.remove('dimmed'));
    else dots.forEach((d) => d.classList.toggle('dimmed', !focusedCats.has(d.dataset.cat)));
  }

  /* ---------- Stacking helpers (within a sub-band) ---------- */
  function buildClusters(nodes) {
    const clusters = []; let cur = null;
    for (const n of nodes) {
      if (!cur || n.x - cur.lastX > GEO.cluster) { cur = { dots: [], lastX: n.x }; clusters.push(cur); }
      cur.dots.push(n); cur.lastX = n.x;
    }
    return clusters;
  }
  function placeCluster(cl) {
    const rows = [];
    for (const d of cl.dots) {
      let placed = false;
      for (let r = 0; r < rows.length; r++) {
        if (rows[r] + GEO.minGap <= d.x) { d.row = r; rows[r] = d.x; placed = true; break; }
      }
      if (!placed) { d.row = rows.length; rows.push(d.x); }
    }
    cl.maxRow = rows.length - 1;
    for (const d of cl.dots) d.rowOffset = (d.row - cl.maxRow / 2) * GEO.stackRow;
  }
  function stackAt(nodes, baseY) {
    nodes.forEach((n) => (n.x = layout.xOf(n.ms)));
    buildClusters(nodes).forEach(placeCluster);
    nodes.forEach((n) => (n.y = baseY + n.rowOffset));
  }

  /* ---------- Render ---------- */
  function render() {
    pinnedEl = null;
    tooltip.classList.remove('visible', 'pinned');

    const width = Math.max(760, chartHost.clientWidth);
    const plotLeft = GEO.marginLeft, plotRight = width - GEO.marginRight;
    const plotW = Math.max(50, plotRight - plotLeft);
    const xOf = (m) => plotLeft + (m - PROC.minMs) / (PROC.maxMs - PROC.minMs) * plotW;

    // Vertical layout.
    let y = GEO.marginTop;
    const fundTop = y; const fundCenter = fundTop + GEO.fundStripH / 2;
    y += GEO.fundStripH + GEO.fundGap;
    const formerTop = y; y += GEO.tenderRowH + GEO.rowGap;
    const currentTop = y; y += GEO.tenderRowH + GEO.rowGap;
    const axisTop = y; const height = axisTop + GEO.axisH;

    const rowGeom = (top) => ({ top, ych: top + GEO.ychOffset, cpmm: top + GEO.cpmmOffset, mid: top + (GEO.ychOffset + GEO.cpmmOffset) / 2 });
    const formerG = rowGeom(formerTop), currentG = rowGeom(currentTop);

    layout = { width, height, plotLeft, plotRight, xOf, fundCenter, formerG, currentG, axisTop };

    // Assign coordinates.
    PROC.funding.forEach((e) => { e.x = xOf(e.ms); e.y = fundCenter; });
    layoutTender(PROC.former, formerG);
    layoutTender(PROC.current, currentG);

    drawSvg();
    applyFocus();
  }

  function layoutTender(evs, g) {
    stackAt(evs.filter((e) => e.side === 'YCH'), g.ych);
    stackAt(evs.filter((e) => e.side === 'CPMM'), g.cpmm);
  }

  /* ---------- SVG ---------- */
  const SVGNS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs = {}, parent = null) => {
    const node = document.createElementNS(SVGNS, name);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  };

  function drawSvg() {
    chartHost.innerHTML = '';
    chartHost.appendChild(tooltip);
    const L = layout, P = PROC;

    const svg = el('svg', { width: L.width, height: L.height, class: 'chart',
      role: 'img', 'aria-label': 'Handoff and turnaround timeline of the CCTV project delay, 2022 to 2026' }, chartHost);

    const chartTop = GEO.marginTop;
    const chartBottom = L.axisTop;

    // Year gridlines.
    const y0 = new Date(P.minMs).getUTCFullYear(), y1 = new Date(P.maxMs).getUTCFullYear();
    for (let yr = y0; yr <= y1; yr++) {
      const m = Date.UTC(yr, 0, 1);
      if (m < P.minMs || m > P.maxMs) continue;
      const x = L.xOf(m);
      el('line', { x1: x, y1: chartTop, x2: x, y2: chartBottom, class: 'year-line' }, svg);
    }

    // Funding strip.
    drawFunding(svg);

    // Tender rows.
    drawTender(svg, P.former, P.formerSegs, L.formerG, 'Former Tendering');
    drawTender(svg, P.current, P.currentSegs, L.currentG, 'Current Tendering');

    // Today line + badge.
    if (P.todayMs >= P.minMs && P.todayMs <= P.maxMs) {
      const x = L.xOf(P.todayMs);
      el('line', { x1: x, y1: chartTop, x2: x, y2: chartBottom, class: 'today-line' }, svg);
      const bg = el('g', { transform: `translate(${x}, ${chartTop - 8})` }, svg);
      el('rect', { x: -24, y: -15, width: 48, height: 15, rx: 3, class: 'today-badge-bg' }, bg);
      const t = el('text', { x: 0, y: -4, class: 'today-badge-text', 'text-anchor': 'middle' }, bg);
      t.textContent = 'Today';
    }

    // Axis.
    el('line', { x1: L.plotLeft, y1: L.axisTop, x2: L.plotRight, y2: L.axisTop, class: 'axis-line' }, svg);
    for (let m = startOfMonth(P.minMs); m <= P.maxMs; m = addMonth(m)) {
      const x = L.xOf(m), d = new Date(m), jan = d.getUTCMonth() === 0;
      el('line', { x1: x, y1: L.axisTop, x2: x, y2: L.axisTop + (jan ? 7 : 4), class: 'axis-tick' + (jan ? ' major' : '') }, svg);
      if (jan) { const t = el('text', { x, y: L.axisTop + 20, class: 'axis-year-label', 'text-anchor': 'middle' }, svg); t.textContent = d.getUTCFullYear(); }
    }

    attachInteractions(svg);
  }

  const startOfMonth = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  const addMonth = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

  function drawFunding(svg) {
    const L = layout, P = PROC;
    const top = L.fundCenter - GEO.fundStripH / 2;
    el('rect', { x: 0, y: top, width: L.width, height: GEO.fundStripH, fill: BAND.fund }, svg);
    const lab = el('text', { x: GEO.marginLeft - 14, y: L.fundCenter, class: 'lane-label', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, svg);
    lab.textContent = 'Funding Approval';

    // connectors + stall ribbons
    P.fundSegs.forEach((s) => {
      el('line', { x1: s.a.x, y1: L.fundCenter, x2: s.b.x, y2: L.fundCenter, class: 'fund-connector' }, svg);
      if (s.stall) {
        const g = el('g', { class: 'stall', 'data-side': 'fund' }, svg); g._seg = { ...s, sideLabel: 'Funding approval chain' };
        el('line', { x1: s.a.x, y1: L.fundCenter, x2: s.b.x, y2: L.fundCenter, class: 'fund-stall' }, g);
        el('line', { x1: s.a.x, y1: L.fundCenter, x2: s.b.x, y2: L.fundCenter, class: 'hit' }, g);
        if (s === P.fundMaxSeg && (s.b.x - s.a.x) > 40) {
          const t = el('text', { x: (s.a.x + s.b.x) / 2, y: L.fundCenter - 6, class: 'fund-stall-label', 'text-anchor': 'middle' }, svg);
          t.textContent = `${s.gap} d`;
        }
      }
    });
    // nodes
    P.funding.forEach((e) => drawNode(svg, e, 'FUND'));
  }

  function drawTender(svg, evs, segs, g, name) {
    const top = g.top;
    // bands (YCH upper half, CPMM lower half)
    el('rect', { x: 0, y: top, width: layout.width, height: g.mid - top, fill: BAND.ych }, svg);
    el('rect', { x: 0, y: g.mid, width: layout.width, height: (top + GEO.tenderRowH) - g.mid, fill: BAND.cpmm }, svg);
    el('line', { x1: 0, y1: g.mid, x2: layout.width, y2: g.mid, class: 'band-line' }, svg);
    // labels
    const lab = el('text', { x: GEO.marginLeft - 14, y: g.mid, class: 'lane-label', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, svg);
    lab.textContent = name;
    el('text', { x: GEO.marginLeft - 14, y: g.ych - 12, class: 'lane-sub', 'text-anchor': 'end' }, svg).textContent = 'YCH ↑';
    el('text', { x: GEO.marginLeft - 14, y: g.cpmm + 16, class: 'lane-sub', 'text-anchor': 'end' }, svg).textContent = 'CPMM ↓';

    // handoff path (thin) through all events in date order
    const pts = evs.map((e) => `${e.x},${e.y}`).join(' ');
    el('polyline', { points: pts, class: 'path' }, svg);

    // stall ribbons on cross-side gaps
    segs.filter((s) => s.stall).forEach((s) => {
      const sg = el('g', { class: 'stall ' + s.responder.toLowerCase() }, svg);
      sg._seg = s;
      el('line', { x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y, class: 'vis' }, sg);
      el('line', { x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y, class: 'hit' }, sg);
      if (s.b.x - s.a.x > 34) {
        const mx = (s.a.x + s.b.x) / 2, my = (s.a.y + s.b.y) / 2;
        const t = el('text', { x: mx, y: my - 1, class: 'stall-label', 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, sg);
        t.textContent = `${s.gap}d`;
      }
    });

    // nodes
    evs.forEach((e) => drawNode(svg, e, e.cat));
    // CPMM comment badges (drawn last, on top)
    evs.filter((e) => e.commentNo).forEach((e) => {
      const bg = el('g', { class: 'badge', transform: `translate(${e.x + 8}, ${e.y + 8})` }, svg);
      el('circle', { r: 7 }, bg);
      const t = el('text', { x: 0, y: 1 }, bg);
      t.textContent = e.commentNo;
    });
  }

  function drawNode(svg, e, cat) {
    // Name the node via aria-label, not an SVG <title>: a <title> also fires the
    // browser's native hover tooltip, which would double up with #tooltip.
    const g = el('g', { class: 'dot' + (e.keyMs ? ' key' : ''), transform: `translate(${e.x}, ${e.y})`, 'data-cat': cat, tabindex: '0', role: 'button', 'aria-label': `${fmtDate(e.allDates[0])} — ${e.text}` }, svg);
    g._d = e;
    if (e.keyMs) {
      el('circle', { r: GEO.dotR + 4.5, fill: 'none', stroke: CAT_HEX[cat], 'stroke-width': 2, opacity: 0.9, class: 'key-ring' }, g);
      el('circle', { r: GEO.dotR + 1.5, class: `dot-vis cat-${cat}` }, g);
    } else {
      el('circle', { r: GEO.dotR, class: `dot-vis cat-${cat}` }, g);
    }
    el('circle', { r: GEO.hitR, class: 'dot-hit' }, g);
    if (e.keyMs) {
      const upper = e.side !== 'CPMM';   // YCH/FUND → label above; CPMM → below (clear of the zig-zag)
      const ly = upper ? -(GEO.dotR + 12) : (GEO.dotR + 13);
      const t = el('text', { x: 0, y: ly, class: 'key-label', 'text-anchor': 'middle' }, g);
      t.textContent = shortDate(e.pIso);
    }
  }

  /* ---------- Interaction ---------- */
  function attachInteractions(svg) {
    svg.addEventListener('pointerover', (e) => {
      const dot = e.target.closest('.dot');
      if (dot) return onNodeEnter(dot);
      const st = e.target.closest('.stall');
      if (st) return onStallEnter(st);
    });
    svg.addEventListener('pointerout', (e) => {
      const dot = e.target.closest('.dot');
      if (dot) {
        if (e.relatedTarget && dot.contains(e.relatedTarget)) return;
        return onNodeLeave(dot);
      }
      const st = e.target.closest('.stall');
      if (st) { if (e.relatedTarget && st.contains(e.relatedTarget)) return; if (!pinnedEl) hideTooltip(); }
    });
    svg.addEventListener('click', (e) => {
      const dot = e.target.closest('.dot');
      if (dot) { onNodeClick(dot); e.stopPropagation(); return; }
      const st = e.target.closest('.stall');
      if (st) { onStallClick(st); e.stopPropagation(); return; }
      unpin();
    });
  }

  function onNodeEnter(dot) {
    highlightSiblings(dot, true);
    if (!pinnedEl) showNodeTooltip(dot, false);
  }
  function onNodeLeave(dot) {
    highlightSiblings(dot, false);
    if (!pinnedEl) hideTooltip();
  }
  function onNodeClick(dot) {
    if (pinnedEl === dot) return unpin();
    pinnedEl = dot; showNodeTooltip(dot, true);
  }
  function onStallEnter(st) {
    if (!pinnedEl) showStallTooltip(st, false);
  }
  function onStallClick(st) {
    if (pinnedEl === st) return unpin();
    pinnedEl = st; showStallTooltip(st, true);
  }
  function onDocClick(e) { if (!chartHost.contains(e.target)) unpin(); }

  function highlightSiblings(dot, on) {
    // dim non-sibling dots on hover so the volley reads
    const all = chartHost.querySelectorAll('.dot');
    const me = dot._d;
    if (!on) { all.forEach((d) => d.classList.remove('hl', 'dimmed')); applyFocus(); return; }
    all.forEach((d) => {
      const same = d._d === me || (d._d.allDates === me.allDates && d._d.text === me.text);
      d.classList.toggle('hl', same);
    });
  }

  /* ---------- Tooltips ---------- */
  function showNodeTooltip(dot, pinned) {
    const d = dot._d;
    const p = PALETTE[d.cat] || { color: '#000', label: d.cat, desc: '' };
    const datesLine = d.allDates.length > 1
      ? `<div class="tt-dates">Event dates: ${escapeHtml(d.allDates.map(fmtDate).join(', '))}</div>` : '';
    const closeBtn = pinned ? `<button class="tt-close" type="button" aria-label="Close">✕</button>` : '';
    const round = (d.cat === 'CPMM' && d.commentNo)
      ? `<span class="tt-cat" style="--c:${p.color}"><span class="tt-dot"></span>${escapeHtml(p.label)} · comment round ${d.commentNo}</span>`
      : `<span class="tt-cat" style="--c:${p.color}"><span class="tt-dot"></span>${escapeHtml(p.label)}</span>`;
    tooltip.innerHTML =
      `<div class="tt-head"><span class="tt-date">${escapeHtml(fmtDate(d.allDates[0]))}</span>${closeBtn}</div>`
      + round + `<div class="tt-text">${escapeHtml(d.text)}</div>` + datesLine;
    tooltip.classList.add('visible');
    tooltip.classList.toggle('pinned', !!pinned);
    tooltip.setAttribute('aria-hidden', 'false');
    positionTooltip(dot);
    if (pinned) tooltip.querySelector('.tt-close')?.addEventListener('click', (e) => { e.stopPropagation(); unpin(); });
  }

  function showStallTooltip(st, pinned) {
    const s = st._seg;
    const side = s.responder || s.sideLabel || '—';
    const label = s.responder ? `Waiting on ${s.responder}` : (s.sideLabel || 'Gap with no recorded action');
    const closeBtn = pinned ? `<button class="tt-close" type="button" aria-label="Close">✕</button>` : '';
    const row = (who, e) => `<div class="row"><span class="who">${who}</span><span>${escapeHtml(e.text)}</span></div>`;
    tooltip.innerHTML =
      `<div class="tt-head"><span class="tt-gap">${s.gap} days</span>${closeBtn}</div>`
      + `<div class="tt-cat"><span class="tt-dot" style="background:${s.responder === 'YCH' ? 'var(--ych)' : s.responder === 'CPMM' ? 'var(--cpmm)' : 'var(--fund)'}"></span>${escapeHtml(label)}</div>`
      + `<div class="tt-flow">${row('from', s.a)}${row('→ ' + side, s.b)}</div>`
      + `<div class="tt-dates">${escapeHtml(fmtDate(s.a.allDates ? s.a.allDates[0] : s.a.ms))} → ${escapeHtml(fmtDate(s.b.allDates ? s.b.allDates[0] : s.b.ms))}</div>`;
    tooltip.classList.add('visible');
    tooltip.classList.toggle('pinned', !!pinned);
    tooltip.setAttribute('aria-hidden', 'false');
    positionTooltip(st);
    if (pinned) tooltip.querySelector('.tt-close')?.addEventListener('click', (e) => { e.stopPropagation(); unpin(); });
  }

  function positionTooltip(target) {
    const hostRect = chartHost.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2 - hostRect.left;
    const cy = r.top + r.height / 2 - hostRect.top;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    const placeAbove = cy - th - 12 > 0;
    const top = placeAbove ? (cy - th - 8) : (cy + r.height / 2 + 8);
    let left = cx - tw / 2;
    left = Math.max(6, Math.min(left, hostRect.width - tw - 6));
    tooltip.style.left = left + 'px';
    tooltip.style.top = Math.max(6, top) + 'px';
  }

  function hideTooltip() { tooltip.classList.remove('visible', 'pinned'); tooltip.setAttribute('aria-hidden', 'true'); }
  function unpin() { pinnedEl = null; hideTooltip(); }

  /* ---------- Go ---------- */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
