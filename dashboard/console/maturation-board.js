// Maturation board — view (docs/specs/maturation-board.md §7–§8).
// Shared by the console page (#/work/maturation) and the standalone page
// (/dashboard/maturation/). Every value is written with textContent via el().

import { el, cantTell } from './ui.js';
import {
  verdictOf, verdictInfo, fmtDate, headline, subline, tiles, verdictCounts, parseState, stateQuery,
  tableOpen, filterRows, sortRows, machines, followUpText, deadlineText, timeline,
} from './maturation-board-model.js';

const POOL_TIMEOUT_MS = 12_000;
let lastBoard = null;
let openId = null;

/**
 * @param main   container element
 * @param api    { get(path, timeoutMs) → {ok,data}|{ok:false,reason} }
 * @param nav    { read() → query string, write(query) } — where filter state lives in the URL
 */
export async function renderMaturation(main, api, nav = consoleNav()) {
  if (!lastBoard) main.replaceChildren(el('p', { class: 'mb-loading', text: 'Reading every machine…' }));
  const r = await api.get('/maturation/board?scope=pool', POOL_TIMEOUT_MS);
  if (!r.ok) {
    if (r.reason === 'switched off on this agent') {
      main.replaceChildren(el('section', { class: 'hero page-hero', 'data-tone': 'unknown' },
        el('div', { class: 'eyebrow', text: 'Feature maturation' }),
        el('h1', { class: 'page-title', text: 'The maturation board is not switched on for this agent.' })));
      return;
    }
    if (!lastBoard) { main.replaceChildren(cantTell(r.reason)); return; }
  } else {
    lastBoard = r.data;
  }
  draw(main, lastBoard, nav);
}

export function consoleNav() {
  return {
    read() { const h = location.hash; const i = h.indexOf('?'); return i >= 0 ? h.slice(i) : ''; },
    write(q) { const base = location.hash.split('?')[0] || '#/work/maturation'; history.replaceState(null, '', base + q); },
  };
}

function draw(main, board, nav) {
  const st = parseState(nav.read());
  const set = (patch) => {
    const next = { ...st, ...patch };
    for (const k of Object.keys(next)) if (!next[k]) delete next[k];
    nav.write(stateQuery(next));
    draw(main, board, nav);
  };

  const head = el('section', { class: 'hero page-hero', 'data-tone': (board.counts.stalledRegressedBlindNoFollowUp ? 'attn' : 'ok') },
    el('div', { class: 'eyebrow', text: 'Feature maturation' }),
    el('h1', { class: 'page-title', text: headline(board) }),
    el('p', { text: subline(board) }),
  );

  const tileRow = el('div', { class: 'mb-tiles' }, tiles(board).map((t) => el('button', {
    class: 'mb-tile', type: 'button', 'data-tone': t.tone,
    onclick: () => set({ v: '', fu: '', past: '', conflict: '', flag: '', all: '', ...t.filter }),
  }, el('span', { class: 'mb-tile-n', text: String(t.n) }), el('span', { class: 'mb-tile-label', text: t.label }))));

  const parts = [head, tileRow];

  if (!tableOpen(st)) {
    parts.push(el('button', { class: 'mb-btn mb-all', type: 'button', text: `All ${board.counts.features} features`, onclick: () => set({ all: '1' }) }));
    parts.push(sourcesNote(board));
    main.replaceChildren(...parts);
    return;
  }

  // Verdict bar: one segment per verdict; tapping filters.
  const vc = verdictCounts(board);
  const total = vc.reduce((a, b) => a + b.n, 0) || 1;
  parts.push(el('div', { class: 'mb-bar', role: 'group', 'aria-label': 'Features by review verdict' }, vc.map((v) => el('button', {
    type: 'button', class: 'mb-seg', 'data-tone': v.tone, style: `flex:${v.n}`,
    title: `${v.label}: ${v.n}`, 'aria-label': `${v.label}: ${v.n}`,
    onclick: () => set({ v: st.v === v.id ? '' : v.id }),
  }, v.n / total > 0.12 ? el('span', { text: `${v.label} ${v.n}` }) : null))));

  // Controls.
  const search = el('input', { type: 'search', class: 'mb-search', placeholder: 'Search features, evidence, decisions…', value: st.q || '', 'aria-label': 'Search' });
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => set({ q: search.value.trim() }), 250); });
  const select = (label, key, options) => {
    const s = el('select', { 'aria-label': label, class: 'mb-select' }, options.map(([val, text]) => el('option', { value: val, text, selected: (st[key] || '') === val })));
    s.addEventListener('change', () => set({ [key]: s.value }));
    return s;
  };
  parts.push(el('div', { class: 'mb-controls' },
    search,
    select('Verdict', 'v', [['', 'Every verdict'], ...verdictCounts(board).map((v) => [v.id, `${v.label} (${v.n})`]), ['stalled,regressed,blind', 'Stalled / regressed / blind']]),
    select('Follow-up', 'fu', [['', 'Any follow-up'], ['none-linked', 'No linked follow-up'], ['unknown', "Can't tell"], ['linked', 'Has a follow-up']]),
    select('Dates', 'past', [['', 'Any date'], ['1', 'Past a recorded date']]),
    select('Flags', 'flag', [['', 'Any flag'], ['carried-evidence', 'Evidence carried, not re-read'], ['no-evidence', 'Positive verdict with no evidence'], ['not-in-latest-review', 'Not in the latest review'], ['ambiguous-join', 'Ambiguous match']]),
    select('Machine', 'm', [['', 'Every machine'], ...machines(board).map((m) => [m, m])]),
    select('Sort', 'sort', [['', 'Sort: verdict'], ['feature', 'Sort: name'], ['followup', 'Sort: follow-up'], ['due', 'Sort: next date'], ['unchanged', 'Sort: unchanged longest']]),
    el('button', { type: 'button', class: 'mb-btn', text: 'Clear', onclick: () => { nav.write(''); draw(main, board, nav); } }),
  ));

  const rows = sortRows(filterRows(board.features, st), st.sort || 'verdict', st.dir || 'asc');
  parts.push(el('p', { class: 'mb-count', text: `Showing ${rows.length} of ${board.features.length}` }));
  parts.push(el('div', { class: 'mb-colhead', 'aria-hidden': 'true' },
    el('span', { text: 'Feature' }), el('span', { text: 'Review verdict' }), el('span', { text: 'What is being done' }), el('span', { text: 'Next date' })));
  parts.push(el('div', { class: 'mb-list', role: 'list' }, rows.slice(0, 400).map((f) => featureRow(f, board, () => {
    openId = openId === f.id ? null : f.id; draw(main, board, nav);
  }))));
  if (rows.length > 400) parts.push(el('p', { class: 'mb-count', text: 'Narrow the filters to see the rest.' }));
  parts.push(sourcesNote(board));
  main.replaceChildren(...parts);
}

function chip(text, tone) { return el('span', { class: 'mb-chip', 'data-tone': tone, text }); }

function featureRow(f, board, toggle) {
  const v = verdictInfo(verdictOf(f));
  const fu = followUpText(f);
  const dl = deadlineText(f);
  const hist = el('span', { class: 'mb-hist', 'aria-label': 'Verdict at each review' }, (f.history || []).map((h) => el('span', {
    class: 'mb-dot', 'data-tone': verdictInfo(h.verdict).tone, title: `${fmtDate(h.date)}: ${verdictInfo(h.verdict).label}${h.carried ? ' (carried)' : ''}`,
  })));
  const flags = [
    ...(f.conflicts || []).map((c) => chip(`Disagree (${c.machine})`, 'attn')),
    ...(f.flags || []).filter((x) => x !== 'not-in-latest-review').map((x) => chip({ 'carried-evidence': 'Carried', 'no-evidence': 'No evidence', 'ambiguous-join': 'Ambiguous match' }[x] || x, 'muted')),
    ...((f.flags || []).includes('not-in-latest-review') ? [chip('Not in latest review', 'muted')] : []),
  ];
  const head = el('button', { type: 'button', class: 'mb-row', 'aria-expanded': openId === f.id ? 'true' : 'false', onclick: toggle },
    el('span', { class: 'mb-name' }, el('span', { class: 'mb-title', text: f.title || f.id }), f.title ? el('span', { class: 'mb-id', text: f.id }) : null),
    el('span', { class: 'mb-verdict' }, chip(v.label, v.tone), hist,
      f.unchangedReviews > 1 ? el('span', { class: 'mb-sub', text: `same for ${f.unchangedReviews} reviews` }) : null),
    el('span', { class: 'mb-fu', 'data-tone': fu.tone, text: fu.text }),
    el('span', { class: 'mb-due', 'data-tone': dl.tone, text: dl.text }),
    flags.length ? el('span', { class: 'mb-flags' }, flags) : null,
  );
  const item = el('div', { class: 'mb-item', role: 'listitem' }, head);
  if (openId === f.id) item.append(detail(f, board));
  return item;
}

function kv(k, v) { return v ? [el('dt', { text: k }), el('dd', { text: v })] : []; }

function detail(f, board) {
  const r = f.review;
  const tl = timeline(f, Date.now());
  const strip = tl.empty
    ? el('p', { class: 'mb-sub', text: 'No recorded dates for this feature yet.' })
    : el('div', { class: 'mb-timeline', 'aria-label': 'Timeline' },
      el('div', { class: 'mb-today', style: `left:${tl.todayPct}%`, title: 'Today' }),
      tl.points.map((p) => el('div', {
        class: `mb-pt mb-pt-${p.kind}`, style: `left:${p.pct}%`,
        'data-tone': p.kind === 'review' ? verdictInfo(p.verdict).tone : p.kind === 'deadline' && p.overdue ? 'bad' : 'muted',
        title: `${fmtDate(p.at)}: ${p.label}`,
      })));
  const owners = (f.owners || []).map((o) => el('li', {
    text: `${o.machine} · ${o.source}: ${Object.entries(o.facts).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${k} ${v}`).join(', ')}`,
  }));
  const deadlines = (f.deadlines || []).map((d) => el('li', {
    text: `${fmtDate(d.date)} · ${d.milestone} (${d.source}${d.source === 'review' ? ', model-assessed' : ''})${d.open ? '' : ' · closed'}${d.overdueDays != null ? ` · ${d.overdueDays} d past` : ''}`,
  }));
  const fus = (f.followUp && f.followUp.items || []).map((i) => el('li', {
    text: `${i.ref} · ${i.label}${i.due ? ` · promised ${fmtDate(i.due)}` : ''}${i.nextCheckIn ? ` · next check-in ${fmtDate(i.nextCheckIn)}` : ''}`,
  }));
  return el('div', { class: 'mb-detail' },
    strip,
    r ? el('p', { class: 'mb-sub', text: `Per review ${fmtDate(r.date)} (model-assessed)${r.evidenceReadToday === false ? ' · evidence carried, not re-read' : ''}` }) : el('p', { class: 'mb-sub', text: 'Not in the latest review.' }),
    el('dl', { class: 'mb-dl' },
      ...kv('Stage (review)', r && r.stage), ...kv('Verdict', r && r.verdictRaw), ...kv('Evidence', r && r.evidence),
      ...kv('Measured by', r && r.measures), ...kv('Its rule', r && r.rule), ...kv('Decision', r && r.decision), ...kv('Action', r && r.action),
    ),
    fus.length ? el('div', {}, el('h3', { text: 'Follow-up' }), el('ul', {}, fus)) : null,
    deadlines.length ? el('div', {}, el('h3', { text: 'Dates' }), el('ul', {}, deadlines)) : null,
    (f.conflicts || []).length ? el('div', {}, el('h3', { text: 'Sources disagree' }), el('ul', {}, f.conflicts.map((c) => el('li', { text: `${c.machine}: ${c.a} vs ${c.b}` })))) : null,
    owners.length ? el('div', {}, el('h3', { text: 'Live records' }), el('ul', { class: 'mb-owners' }, owners)) : null,
  );
}

function sourcesNote(board) {
  const bad = (board.sources || []).filter((s) => !s.ok);
  const answered = (board.sources || []).filter((s) => s.name === 'peer' && s.ok).length + 1;
  const peers = (board.sources || []).filter((s) => s.name === 'peer').length + 1;
  return el('details', { class: 'mb-sources' },
    el('summary', { text: `${answered} of ${peers} machines answered · ${bad.length} source${bad.length === 1 ? '' : 's'} could not be read` }),
    el('ul', {}, (board.sources || []).map((s) => el('li', { text: `${s.ok ? 'OK' : 'Not read'} · ${s.name}${s.machine ? ` · ${s.machine}` : ''}${s.reason ? ` · ${s.reason}` : ''}` }))),
    el('p', { class: 'mb-sub', text: 'Advisory only: this page changes nothing. Verdicts are the review job’s written assessment.' }),
  );
}

let probeResult = null; // checked once per page load
/** The Work-group tile: shown only when the board answers (hidden on 503 or any failure). */
export function maturationTile(get) {
  const a = el('a', { class: 'tile', href: '#/work/maturation' },
    el('span', { class: 't-icon', icon: 'layers' }),
    el('span', {}, el('span', { class: 't-name', text: 'Feature maturation' }),
      el('span', { class: 't-desc', text: 'Every feature on its way to switched-on: the latest review’s verdict, what measures it, what is being done, and its dates.' })));
  const host = el('div', { class: 'tiles tiles-maturation', hidden: true }, a);
  if (!probeResult) probeResult = get('/maturation/board?part=probe').then((r) => r.ok).catch(() => false);
  probeResult.then((ok) => { host.hidden = !ok; });
  return host;
}
