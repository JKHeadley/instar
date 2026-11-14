// Agent token usage section of "What thinking costs" (docs/specs/unified-usage-ledger.md, Slice 5).
// View only: usage-model.js decides every word and number; values reach the DOM through
// textContent (el()) and SVG text nodes. Charts follow the console's light/dark tokens
// (--series-1..6 in console.css) and fit phone width (the SVG scales to its container).

import { el, sheet, note } from './ui.js';
import { fmtTokens, fmtUsd } from './costs-model.js';
import { SPLITS, bucketWord, buildDrill, drillQuery, DRILL_ORDER } from './usage-model.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, text) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
};
const seriesVar = (slot) => `var(--series-${(slot % 6) + 1})`;

/** The whole usage section, or null when the ledger is switched off on this agent. */
export function usageSection(model, { get, sinceMs, state, repaint, onPath }) {
  if (!model || model.off) return null;
  const h = model.headline;
  return el('section', { class: 'usage-section', 'aria-label': 'Token usage' },
    el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Token usage' }), el('span', { class: 'list-source', text: 'Every model request by this agent, on every machine' })),
    h.ok ? headlineBlock(h) : note(`I could not read the usage totals: ${h.why}.`),
    seriesBlock(model.series, state, repaint),
    drillBlock(model.drill, { get, sinceMs, state, onPath }),
    el('div', { class: 'usage-tops' }, ...model.top.map(topBlock)),
    el('div', { class: 'usage-pair' }, cacheBlock(model.cache), machinesBlock(model.machines)),
    coverageBlock(model.coverage),
  );
}

function headlineBlock(h) {
  return el('div', { class: 'usage-headline' },
    el('p', { class: 'usage-line', text: h.line }),
    el('div', { class: 'facts' }, ...h.facts.map((f) => el('div', { class: 'fact' }, el('span', { class: 'fact-value', text: f.value }), el('span', { class: 'fact-label', text: f.label })))),
    h.caveats.length ? el('ul', { class: 'usage-caveats' }, ...h.caveats.map((c) => el('li', { text: c }))) : null,
    el('p', { class: 'card-note', text: h.basis }),
  );
}

// ── 2. usage over time: stacked bars, legend, per-bar hover, table view ──

function seriesBlock(s, state, repaint) {
  const chips = el('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Split usage by' }, ...SPLITS.map((c) => el('button', {
    class: 'fchip', type: 'button', 'aria-pressed': c.key === state.split ? 'true' : 'false',
    onclick: () => { if (c.key !== state.split) { state.split = c.key; repaint(); } },
  }, el('span', { text: c.label }))));
  if (!s.ok) return el('div', { class: 'usage-block' }, chips, note(`I could not read usage over time: ${s.why}.`));
  if (s.empty) return el('div', { class: 'usage-block' }, el('h3', { class: 'eyebrow', text: 'Usage over time' }), chips, note('No tokens recorded in this window.'));
  // A narrower drawing area on a phone keeps the axis text readable once the SVG scales down.
  const narrow = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 520px)').matches;
  const W = narrow ? 380 : 640, H = narrow ? 180 : 200, L = 40, R = 8, T = 8, B = 24;
  const n = s.bars.length;
  const slotW = (W - L - R) / n;
  const barW = Math.max(2, Math.min(28, slotW - 2));
  const y = (v) => T + (H - T - B) * (1 - v / s.max);
  const pic = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'usage-chart', role: 'img', 'aria-label': `Tokens per ${s.grain}, stacked by ${s.split === 'framework' ? 'engine' : 'model'}. A table view follows.` });
  // Recessive grid: baseline and the max tick only.
  pic.append(svg('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, stroke: 'currentColor', 'stroke-opacity': '.35' }));
  pic.append(svg('text', { x: L - 6, y: y(s.max) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor', 'fill-opacity': '.7' }, fmtTokens(s.max)));
  pic.append(svg('text', { x: L - 6, y: H - B + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor', 'fill-opacity': '.7' }, '0'));
  const tickEvery = Math.max(1, Math.ceil(n / (narrow ? 4 : 6)));
  s.bars.forEach((b, i) => {
    const x = L + i * slotW + (slotW - barW) / 2;
    const g = svg('g', { class: 'usage-bar', tabindex: 0 });
    let top = H - B;
    b.parts.forEach((p, j) => {
      if (!p.tokens) return;
      const hgt = (H - T - B) * (p.tokens / s.max);
      const yTop = top - hgt;
      // 2px surface gap between stacked segments.
      g.append(svg('rect', { x, y: yTop + (j > 0 ? 1 : 0), width: barW, height: Math.max(0, hgt - (j > 0 ? 2 : 0)), fill: seriesVar(j), rx: 1 }));
      top = yTop;
    });
    // Hit target: the full slot height, bigger than the mark.
    const hit = svg('rect', { x: L + i * slotW, y: T, width: slotW, height: H - T - B, fill: 'transparent' });
    hit.append(svg('title', {}, `${bucketWord(b.bucket, s.grain)}: ${fmtTokens(b.tokens)} tokens, ${fmtUsd(b.usd)}\n${b.parts.filter((p) => p.tokens).map((p) => `${s.legend.find((l) => l.key === p.key).label}: ${fmtTokens(p.tokens)}`).join('\n')}`));
    g.append(hit);
    pic.append(g);
    if (i % tickEvery === 0) pic.append(svg('text', { x: x + barW / 2, y: H - 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'currentColor', 'fill-opacity': '.7' }, bucketWord(b.bucket, s.grain)));
  });
  const legend = el('ul', { class: 'usage-legend' }, ...s.legend.map((l) => el('li', {}, el('span', { class: 'usage-swatch', style: `background:${seriesVar(l.slot)}` }), el('span', { text: l.label }))));
  return el('div', { class: 'usage-block' },
    el('h3', { class: 'eyebrow', text: 'Usage over time' }), chips, legend, pic,
    tableView(['When', ...s.legend.map((l) => l.label), 'Total', 'Cost'], s.bars.map((b) => [bucketWord(b.bucket, s.grain), ...b.parts.map((p) => fmtTokens(p.tokens)), fmtTokens(b.tokens), fmtUsd(b.usd)])),
  );
}

function tableView(headers, rows) {
  return el('details', { class: 'usage-table' }, el('summary', { text: 'Show as a table' }),
    el('div', { class: 'table-scroll' }, el('table', {},
      el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h })))),
      el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', { text: c }))))),
    )));
}

// ── 3. drill-down: agent → machine → engine → model → conversation → session ──

function drillBlock(d, { get, sinceMs, state, onPath }) {
  const box = el('div', { class: 'usage-block usage-drill' }, el('h3', { class: 'eyebrow', text: 'Where the tokens went' }));
  const paint = (model) => {
    while (box.childNodes.length > 1) box.removeChild(box.lastChild);
    if (!model.ok) { box.append(note(`I could not read the breakdown: ${model.why}.`)); return; }
    box.append(el('nav', { class: 'usage-crumbs', 'aria-label': 'Breakdown path' }, ...model.crumbs.map((c, i) => (i === model.crumbs.length - 1
      ? el('span', { class: 'crumb-here', text: c.label })
      : el('button', { class: 'link-btn', type: 'button', text: c.label, onclick: () => go(state.path.slice(0, c.depth)) })))));
    if (!model.children.length) { box.append(note('Nothing recorded here in this window.')); return; }
    box.append(el('ul', { class: 'usage-rows' }, ...model.children.map((c) => el('li', {},
      el('button', {
        class: 'usage-row', type: 'button', disabled: c.canOpen ? undefined : 'disabled',
        onclick: () => (c.dim === 'session' ? openSession(get, c.key) : go([...state.path, { dim: c.dim, key: c.key }])),
      },
      el('span', { class: 'usage-row-label', text: c.label }),
      el('span', { class: 'usage-row-bar' }, el('span', { class: 'usage-row-fill', style: `width:${model.max ? Math.max(1, (c.tokens / model.max) * 100) : 0}%` })),
      el('span', { class: 'usage-row-value', text: `${fmtTokens(c.tokens)} · ${fmtUsd(c.usd)}` }),
      )))));
  };
  const go = async (path) => {
    state.path = path.slice(0, DRILL_ORDER.length);
    onPath?.(state.path);
    paint(buildDrill(await get(drillQuery(state.path, sinceMs)), state.path));
  };
  paint(d);
  return box;
}

async function openSession(get, sessionId) {
  const res = await get(`/usage/events?session=${encodeURIComponent(sessionId)}`);
  const rows = res.ok ? res.data.rows : [];
  sheet({ title: 'Requests in this session' },
    res.ok ? null : note(`I could not read this session's requests: ${res.reason}.`),
    rows.length ? tableView(['When', 'Model', 'Fresh input', 'Cache read', 'Cache write', 'Output'], rows.map((r) => [
      new Date(r.ts).toLocaleString(), String(r.model || 'unknown'), fmtTokens(r.tok_input), fmtTokens(r.tok_cache_read), fmtTokens(r.tok_cache_write), fmtTokens(r.tok_output),
    ])) : note('No request rows are kept for this session (they age out after 90 days).'),
  );
}

// ── 4. top lists ──

function topBlock(t) {
  if (!t.ok) return el('div', { class: 'usage-block' }, note(`I could not read this list: ${t.why}.`));
  return el('div', { class: 'usage-block' }, el('h3', { class: 'eyebrow', text: t.title }),
    t.items.length ? el('ol', { class: 'usage-top' }, ...t.items.slice(0, 8).map((i) => el('li', {}, el('span', { class: 'usage-top-name', text: i.label }), el('span', { class: 'usage-top-line', text: i.line }))))
      : note('Nothing recorded in this window.'));
}

// ── 5. cache hit rate over time + machine comparison ──

function cacheBlock(c) {
  if (!c.ok) return el('div', { class: 'usage-block' }, note(`I could not read the cache rate: ${c.why}.`));
  const W = 320, H = 120, L = 34, R = 8, T = 8, B = 20;
  const pts = c.points;
  const x = (i) => L + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * (W - L - R));
  const y = (r) => T + (H - T - B) * (1 - r);
  const pic = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'usage-chart small', role: 'img', 'aria-label': `Share of input read from cache per ${c.grain}. ${c.line}.` });
  pic.append(svg('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, stroke: 'currentColor', 'stroke-opacity': '.35' }));
  for (const v of [0, 1]) pic.append(svg('text', { x: L - 4, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor', 'fill-opacity': '.7' }, `${v * 100}%`));
  let prev = null;
  pts.forEach((p, i) => {
    if (p.rate === null) { prev = null; return; }
    if (prev) pic.append(svg('line', { x1: x(prev.i), y1: y(prev.r), x2: x(i), y2: y(p.rate), stroke: 'var(--series-1)', 'stroke-width': 2 }));
    const dot = svg('circle', { cx: x(i), cy: y(p.rate), r: 4, fill: 'var(--series-1)', stroke: 'var(--bg)', 'stroke-width': 2 });
    dot.append(svg('title', {}, `${bucketWord(p.bucket, c.grain)}: ${Math.round(p.rate * 100)}% from cache`));
    pic.append(dot);
    prev = { i, r: p.rate };
  });
  return el('div', { class: 'usage-block' }, el('h3', { class: 'eyebrow', text: 'Cache hit rate' }), el('p', { class: 'card-note', text: c.line }), pic);
}

function machinesBlock(m) {
  if (!m.ok) return el('div', { class: 'usage-block' }, note(`I could not read the machines: ${m.why}.`));
  return el('div', { class: 'usage-block' }, el('h3', { class: 'eyebrow', text: 'By machine' }),
    el('ul', { class: 'usage-rows' }, ...m.rows.map((r) => el('li', {}, el('div', { class: 'usage-row static' },
      el('span', { class: 'usage-row-label', text: r.stateWord ? `${r.label} · ${r.stateWord}` : r.label }),
      el('span', { class: 'usage-row-bar' }, el('span', { class: 'usage-row-fill', style: `width:${m.max ? Math.max(r.tokens ? 1 : 0, (r.tokens / m.max) * 100) : 0}%` })),
      el('span', { class: 'usage-row-value', text: r.state === 'not-reached' ? 'no answer' : `${fmtTokens(r.tokens)} · ${fmtUsd(r.usd)}` }),
    )))));
}

// ── 6. coverage strip ──

function coverageBlock(c) {
  if (!c.ok) return el('div', { class: 'usage-block' }, note(`I could not read what is measured: ${c.why}.`));
  return el('div', { class: 'usage-block usage-coverage' }, el('h3', { class: 'eyebrow', text: 'What is measured' }),
    el('div', { class: 'facts' }, ...c.items.map((i) => el('div', { class: 'fact' }, el('span', { class: 'fact-value', text: i.value }), el('span', { class: 'fact-label', text: i.label })))),
    c.unknowns.length ? el('ul', { class: 'usage-caveats' }, ...c.unknowns.map((u) => el('li', { text: u }))) : null);
}
