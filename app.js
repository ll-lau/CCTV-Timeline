/* =====================================================================
 * CCTV Replacement Project — Delay Timeline
 * Vanilla JS + SVG. Reads _timeline_data.json (fetched at runtime).
 *
 * Layout: 3 horizontal "lanes" share ONE linear time axis (fit-all, no zoom).
 * Each event = a dot; multi-date events become one dot per date.
 * Dense regions are stacked vertically (cluster + greedy first-fit rows).
 * ===================================================================== */
(() => {
  'use strict';

  /* ---------- Config ---------- */

  // Snapshot date for the "Today" marker. Change to a live `new Date()` if preferred,
  // but a fixed value keeps the narrative stable as a presentation snapshot.
  const TODAY_ISO = '2026-06-16';

  const PALETTE = {
    YCH:  { color: 'var(--ych)',  label: 'YCH action', desc: 'TMS / FMD / Security / Supplies' },
    CPMM: { color: 'var(--cpmm)', label: 'CPMM action', desc: 'CPMM' },
    MEET: { color: 'var(--meet)', label: 'Meeting', desc: 'Meeting held' },
    FUND: { color: 'var(--fund)', label: 'Funding', desc: 'Funding milestone' },
  };
  const LEGEND_ORDER = ['YCH', 'CPMM', 'MEET', 'FUND'];

  const CFG = {
    marginLeft: 150,        // left gutter for lane labels
    marginRight: 26,
    marginTop: 32,
    laneGap: 16,            // vertical gap between lane bands
    lanePadY: 12,           // padding inside a lane band
    dotR: 5,                // visible dot radius
    hitR: 11,               // invisible hit area radius
    rowSpacing: 14,         // vertical px between stacked rows
    clusterThreshold: 12,   // dots within this horizontal px join a cluster
    minGap: 12,             // min horizontal px for two dots to share a row
    axisHeight: 30,
  };

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY = 86400000;

  const fmtDate = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  };
  const parseMs = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /* ---------- State ---------- */

  let data = null;
  let layout = null;
  const focusedCats = new Set();   // legend click-to-filter
  let pinnedDot = null;            // currently pinned dot element (or null)

  const chartHost = document.getElementById('chart-host');
  const tooltip = document.getElementById('tooltip');
  const legendEl = document.getElementById('legend');

  /* ---------- Init ---------- */

  async function init() {
    try {
      const res = await fetch('_timeline_data.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (e) {
      chartHost.innerHTML =
        `<div class="error">Could not load <code>_timeline_data.json</code>.<br>${escapeHtml(e.message)}<br><br>`
        + `If you opened this file directly, the browser blocks <code>fetch</code> on <code>file://</code>. `
        + `Serve the folder over HTTP, e.g. run <code>python3 -m http.server</code> in the project directory `
        + `and open the printed URL. On GitHub/Cloudflare Pages it works without any of this.</div>`;
      return;
    }
    buildLegend();
    render();
    window.addEventListener('resize', debounce(render, 150));
    document.addEventListener('click', onDocClick);
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
        + `<span class="legend-text">`
        + `<span class="legend-label">${escapeHtml(p.label)}</span>`
        + `<span class="legend-desc">${escapeHtml(p.desc)}</span>`
        + `</span>`;
      item.addEventListener('click', () => {
        if (focusedCats.has(cat)) focusedCats.delete(cat); else focusedCats.add(cat);
        item.classList.toggle('active', focusedCats.has(cat));
        // dim the other legend items so the active set is obvious
        legendEl.querySelectorAll('.legend-item').forEach((li) => {
          li.classList.toggle('dim', focusedCats.size > 0 && !focusedCats.has(li.dataset.cat));
        });
        applyFocus();
      });
      legendEl.appendChild(item);
    });
  }

  function applyFocus() {
    const dots = chartHost.querySelectorAll('.dot');
    if (focusedCats.size === 0) {
      dots.forEach((d) => d.classList.remove('dimmed'));
    } else {
      dots.forEach((d) => d.classList.toggle('dimmed', !focusedCats.has(d.dataset.cat)));
    }
  }

  /* ---------- Layout ---------- */

  function render() {
    pinnedDot = null;
    tooltip.classList.remove('visible', 'pinned');

    const width = Math.max(640, chartHost.clientWidth);

    // Gather domain + per-lane dots (expand multi-date events into one dot per date).
    let minMs = Infinity, maxMs = -Infinity;
    const lanes = data.lanes.map((lane, li) => {
      const dots = [];
      lane.events.forEach((ev, ei) => {
        const eventId = `${li}-${ei}`;
        ev.dates.forEach((iso) => {
          const ms = parseMs(iso);
          if (ms < minMs) minMs = ms;
          if (ms > maxMs) maxMs = ms;
          dots.push({ eventId, cat: ev.cat, text: ev.text, iso, ms, allDates: ev.dates });
        });
      });
      dots.sort((a, b) => a.ms - b.ms);
      return { name: lane.name, dots };
    });

    // Make sure the "Today" marker is inside the domain, then pad both ends.
    const todayMs = parseMs(TODAY_ISO);
    if (todayMs > maxMs) maxMs = todayMs;

    const span = maxMs - minMs;
    const pad = Math.max(span * 0.012, 6 * DAY);
    minMs -= pad; maxMs += pad;

    const plotLeft = CFG.marginLeft;
    const plotRight = width - CFG.marginRight;
    const plotW = Math.max(50, plotRight - plotLeft);
    const xOf = (ms) => plotLeft + (ms - minMs) / (maxMs - minMs) * plotW;

    // Position dots + stack dense regions.
    lanes.forEach((lane) => {
      lane.dots.forEach((d) => (d.x = xOf(d.ms)));
      let maxRows = 1;
      buildClusters(lane.dots).forEach((cl) => {
        placeCluster(cl);
        if (cl.maxRow + 1 > maxRows) maxRows = cl.maxRow + 1;
      });
      lane.contentH = maxRows * CFG.rowSpacing;
    });

    // Vertical layout of lanes.
    let y = CFG.marginTop;
    lanes.forEach((lane, i) => {
      lane.index = i;
      lane.top = y;
      lane.h = CFG.lanePadY * 2 + lane.contentH;
      lane.center = lane.top + CFG.lanePadY + lane.contentH / 2;
      lane.bottom = lane.top + lane.h;
      y = lane.bottom + CFG.laneGap;
    });
    const axisTop = y;
    const height = axisTop + CFG.axisHeight;

    layout = { width, height, plotLeft, plotRight, xOf, lanes, axisTop, minMs, maxMs, todayMs };
    drawSvg(layout);
    applyFocus();
  }

  // Group dots into clusters: consecutive dots (by x) closer than `clusterThreshold`.
  function buildClusters(dots) {
    const clusters = [];
    let cur = null;
    for (const d of dots) {
      if (!cur || d.x - cur.lastX > CFG.clusterThreshold) {
        cur = { dots: [], lastX: d.x };
        clusters.push(cur);
      }
      cur.dots.push(d);
      cur.lastX = d.x;
    }
    return clusters;
  }

  // Greedy first-fit rows within a cluster, then center the rows around 0.
  function placeCluster(cl) {
    const rows = []; // each entry = rightmost x used in that row
    for (const d of cl.dots) {
      let placed = false;
      for (let r = 0; r < rows.length; r++) {
        if (rows[r] + CFG.minGap <= d.x) { d.row = r; rows[r] = d.x; placed = true; break; }
      }
      if (!placed) { d.row = rows.length; rows.push(d.x); }
    }
    cl.maxRow = rows.length - 1;
    for (const d of cl.dots) d.rowOffset = (d.row - cl.maxRow / 2) * CFG.rowSpacing;
  }

  /* ---------- SVG drawing ---------- */

  const SVGNS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs = {}, parent = null) => {
    const node = document.createElementNS(SVGNS, name);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  };

  function drawSvg(L) {
    chartHost.innerHTML = '';
    chartHost.appendChild(tooltip); // keep tooltip inside host for relative positioning

    const svg = el('svg', {
      width: L.width, height: L.height, class: 'chart',
      role: 'img', 'aria-label': 'Timeline of CCTV replacement project delay events, 2022 to 2026',
    }, chartHost);

    const chartTop = L.lanes[0].top;
    const chartBottom = L.lanes[L.lanes.length - 1].bottom;

    // Lane bands + labels.
    L.lanes.forEach((lane) => {
      el('rect', {
        x: 0, y: lane.top, width: L.width, height: lane.h,
        fill: lane.index % 2 ? 'var(--lane-b)' : 'var(--lane-a)',
      }, svg);
      const label = el('text', {
        x: CFG.marginLeft - 14, y: lane.center, class: 'lane-label',
        'text-anchor': 'end', 'dominant-baseline': 'middle',
      }, svg);
      label.textContent = lane.name;
    });

    // Year gridlines (faint, full height).
    const firstYear = new Date(L.minMs).getUTCFullYear();
    const lastYear = new Date(L.maxMs).getUTCFullYear();
    for (let yr = firstYear; yr <= lastYear; yr++) {
      const ms = Date.UTC(yr, 0, 1);
      if (ms < L.minMs || ms > L.maxMs) continue;
      const x = L.xOf(ms);
      el('line', { x1: x, y1: chartTop, x2: x, y2: chartBottom, class: 'year-line' }, svg);
    }

    // Axis baseline + month ticks + year labels.
    el('line', { x1: L.plotLeft, y1: L.axisTop, x2: L.plotRight, y2: L.axisTop, class: 'axis-line' }, svg);
    for (let ms = startOfMonth(L.minMs); ms <= L.maxMs; ms = addMonth(ms)) {
      const x = L.xOf(ms);
      const d = new Date(ms);
      const isJan = d.getUTCMonth() === 0;
      el('line', {
        x1: x, y1: L.axisTop, x2: x, y2: L.axisTop + (isJan ? 7 : 4),
        class: 'axis-tick' + (isJan ? ' major' : ''),
      }, svg);
      if (isJan) {
        const t = el('text', { x, y: L.axisTop + 20, class: 'axis-year-label', 'text-anchor': 'middle' }, svg);
        t.textContent = d.getUTCFullYear();
      }
    }

    // Today line + badge.
    if (L.todayMs >= L.minMs && L.todayMs <= L.maxMs) {
      const x = L.xOf(L.todayMs);
      el('line', { x1: x, y1: chartTop, x2: x, y2: chartBottom, class: 'today-line' }, svg);
      const badge = el('g', { transform: `translate(${x}, ${chartTop - 8})`, class: 'today-badge' }, svg);
      el('rect', { x: -24, y: -15, width: 48, height: 15, rx: 3, class: 'today-badge-bg' }, badge);
      const t = el('text', { x: 0, y: -4, class: 'today-badge-text', 'text-anchor': 'middle' }, badge);
      t.textContent = 'Today';
    }

    // Dots.
    const dotsG = el('g', { class: 'dots' }, svg);
    L.lanes.forEach((lane) => {
      lane.dots.forEach((d) => {
        const cy = lane.center + d.rowOffset;
        const g = el('g', {
          class: 'dot', transform: `translate(${d.x}, ${cy})`,
          'data-event-id': d.eventId, 'data-cat': d.cat, tabindex: '0',
        }, dotsG);
        g._d = d;
        const title = el('title', {}, g);
        title.textContent = `${fmtDate(d.iso)} — ${d.text}`;
        el('circle', { r: CFG.dotR, class: `dot-vis cat-${d.cat}` }, g);
        el('circle', { r: CFG.hitR, class: 'dot-hit' }, g);
      });
    });

    attachInteractions(svg);
  }

  const startOfMonth = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  const addMonth = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

  /* ---------- Interaction ---------- */

  function attachInteractions(svg) {
    svg.addEventListener('pointerover', (e) => {
      const dot = e.target.closest('.dot');
      if (dot) onDotEnter(dot);
    });
    svg.addEventListener('pointerout', (e) => {
      const dot = e.target.closest('.dot');
      if (!dot) return;
      // Ignore movement between a dot's own children (vis circle <-> hit circle).
      const to = e.relatedTarget;
      if (to && dot.contains(to)) return;
      onDotLeave(dot);
    });
    svg.addEventListener('click', (e) => {
      const dot = e.target.closest('.dot');
      if (dot) { onDotClick(dot); e.stopPropagation(); }
      else { unpin(); }
    });
    svg.addEventListener('keydown', (e) => {
      const dot = e.target.closest('.dot');
      if (dot && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onDotClick(dot); }
    });
  }

  function onDotEnter(dot) {
    highlightSiblings(dot, true);
    if (!pinnedDot) showTooltip(dot, false);
  }

  function onDotLeave(dot) {
    highlightSiblings(dot, false);
    if (!pinnedDot) hideTooltip();
  }

  function onDotClick(dot) {
    if (pinnedDot === dot) { unpin(); return; }
    pinnedDot = dot;
    showTooltip(dot, true);
  }

  function onDocClick(e) {
    // Click outside the chart & tooltip closes a pinned tooltip.
    if (!chartHost.contains(e.target)) unpin();
  }

  function highlightSiblings(dot, on) {
    const id = dot.dataset.eventId;
    chartHost.querySelectorAll('.dot').forEach((d) => {
      if (d.dataset.eventId === id) d.classList.toggle('hl', on);
    });
  }

  function showTooltip(dot, pinned) {
    const d = dot._d;
    const p = PALETTE[d.cat] || { color: '#000', label: d.cat, desc: '' };
    const datesLine = d.allDates.length > 1
      ? `<div class="tt-dates">Event dates: ${escapeHtml(d.allDates.map(fmtDate).join(', '))}</div>`
      : '';
    const closeBtn = pinned ? `<button class="tt-close" type="button" aria-label="Close">✕</button>` : '';
    tooltip.innerHTML =
      `<div class="tt-head"><span class="tt-date">${escapeHtml(fmtDate(d.iso))}</span>${closeBtn}</div>`
      + `<span class="tt-cat" style="--c:${p.color}"><span class="tt-dot"></span>${escapeHtml(p.label)}`
      + (p.desc && p.desc !== p.label ? ` · ${escapeHtml(p.desc)}` : '') + `</span>`
      + `<div class="tt-text">${escapeHtml(d.text)}</div>`
      + datesLine;
    tooltip.classList.add('visible');
    tooltip.classList.toggle('pinned', !!pinned);
    tooltip.setAttribute('aria-hidden', 'false');
    positionTooltip(dot);
    if (pinned) {
      const btn = tooltip.querySelector('.tt-close');
      if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); unpin(); });
    }
  }

  function positionTooltip(dot) {
    const hostRect = chartHost.getBoundingClientRect();
    const r = dot.getBoundingClientRect();
    const cx = r.left + r.width / 2 - hostRect.left;
    const cy = r.top + r.height / 2 - hostRect.top;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;

    const placeAbove = cy - th - 12 > 0;
    const top = placeAbove ? (cy - CFG.dotR - th - 6) : (cy + CFG.dotR + 8);
    let left = cx - tw / 2;
    left = Math.max(6, Math.min(left, hostRect.width - tw - 6));
    if (top < 6) top = 6;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }

  function hideTooltip() {
    tooltip.classList.remove('visible', 'pinned');
    tooltip.setAttribute('aria-hidden', 'true');
  }

  function unpin() {
    pinnedDot = null;
    hideTooltip();
  }

  /* ---------- Go ---------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
