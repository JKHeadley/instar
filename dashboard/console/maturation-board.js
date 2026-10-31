// Maturation board — view (docs/specs/maturation-board.md §7–§8).
// Shared by the console page (#/work/maturation) and the standalone page
// (/dashboard/maturation/). Every value is written with textContent via el().
//
// Layout, top to bottom: one answer sentence · a square per feature (the glance) ·
// plain groups (Broken, Stuck, …) with one plain line per feature · details on tap.

import { el, cantTell } from './ui.js';
import {
  GROUPS, groupOf, groupCounts, headline, subline, parseState, stateQuery, openGroups,
  filterRows, orderInGroup, sortRows, SORTS, squares, humanName, humanArea, ownerChip, statusLine, timeline, fmtDate, card, isNobody,
} from './maturation-board-model.js';

const POOL_TIMEOUT_MS = 12_000;
let lastBoard = null;

/**
 * @param main   container element
 * @param api    { get(path, timeoutMs) → {ok,data}|{ok:false,reason} }
 * @param nav    { read() → query string, write(query) } — where view state lives in the URL
 */
export async function renderMaturation(main, api, nav = consoleNav()) {
  if (!lastBoard) main.replaceChildren(el('p', { class: 'mb-loading', text: 'Reading every machine…' }));
  const r = await api.get('/maturation/board?scope=pool', POOL_TIMEOUT_MS);
  if (!r.ok) {
    if (r.reason === 'switched off on this agent') {
      main.replaceChildren(el('section', { class: 'mb-hero' },
        el('div', { class: 'eyebrow', text: 'Feature maturation' }),
        el('h1', { class: 'mb-answer', text: 'The maturation board is not switched on for this agent.' })));
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
  const features = board.features || [];
  const counts = groupCounts(features);

  // 1. The answer.
  const hero = el('section', { class: 'mb-hero' },
    el('div', { class: 'eyebrow', text: 'Feature maturation' }),
    el('h1', { class: 'mb-answer', text: headline(board) }),
    el('p', { class: 'mb-sub', text: subline(board) }));

  // 2. The glance: one square per feature, coloured by group; a dot marks "no fix planned".
  const legend = el('div', { class: 'mb-legend' }, GROUPS.filter((g) => counts[g.id]).map((g) => el('button', {
    type: 'button', class: `mb-key${st.g === g.id ? ' on' : ''}`, 'data-tone': g.tone,
    onclick: () => set({ g: st.g === g.id ? '' : g.id, open: '' }),
  }, el('span', { class: 'mb-swatch' }), el('span', { class: 'mb-key-label', text: g.label }), el('span', { class: 'mb-key-n', text: String(counts[g.id]) }))));
  const map = el('div', { class: 'mb-map', role: 'img', 'aria-label': GROUPS.filter((g) => counts[g.id]).map((g) => `${counts[g.id]} ${g.label.toLowerCase()}`).join(', ') },
    squares(features).map((s) => el('button', {
      type: 'button', class: `mb-sq${s.nobody ? ' nobody' : ''}`, 'data-tone': s.tone, title: s.title, 'aria-label': s.title,
      onclick: () => set({ f: s.id, open: s.group }),
    })));
  const glance = el('section', { class: 'mb-glance' }, map, legend,
    el('p', { class: 'mb-hint', text: 'Each square is one feature. A white dot means no fix is planned. Tap a colour to show only that group.' }));

  // 3. Tools: one search box, one switch and a sort choice.
  const search = el('input', { type: 'search', class: 'mb-search', placeholder: 'Find a feature', value: st.q || '', 'aria-label': 'Find a feature' });
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => set({ q: search.value.trim() }), 250); });
  const nobody = el('button', { type: 'button', class: `mb-toggle${st.nobody ? ' on' : ''}`, text: 'Only “no fix planned”', 'aria-pressed': st.nobody ? 'true' : 'false', onclick: () => set({ nobody: st.nobody ? '' : '1' }) });
  const sort = el('select', { class: 'mb-sort', 'aria-label': 'Sort features' },
    SORTS.map((o) => el('option', { value: o.id, text: `Sort: ${o.label}`, selected: (st.sort || 'worst') === o.id ? 'selected' : null })));
  sort.addEventListener('change', () => set({ sort: sort.value === 'worst' ? '' : sort.value }));
  const tools = el('div', { class: 'mb-tools' }, search, nobody, sort,
    (st.g || st.q || st.nobody || st.sort) ? el('button', { type: 'button', class: 'mb-link', text: 'Show everything', onclick: () => { nav.write(''); draw(main, board, nav); } }) : null);

  // 4. Plain groups.
  const rows = filterRows(features, st);
  const open = openGroups(st);
  const sections = GROUPS.map((g) => {
    const inGroup = sortRows(rows.filter((f) => groupOf(f).id === g.id), st.sort);
    if (!inGroup.length) return null;
    const isOpen = open.has(g.id) || Boolean(st.q) || Boolean(st.nobody);
    const nobodyN = inGroup.filter(isNobody).length;
    const head = el('button', {
      type: 'button', class: 'mb-group-head', 'data-tone': g.tone, 'aria-expanded': isOpen ? 'true' : 'false',
      onclick: () => {
        const next = new Set(open);
        if (next.has(g.id)) next.delete(g.id); else next.add(g.id);
        set({ open: [...next].join(',') || 'none', g: '' });
      },
    },
    el('span', { class: 'mb-group-name', text: `${g.label} · ${inGroup.length}` }),
    el('span', { class: 'mb-group-blurb', text: g.blurb + (nobodyN && g.tone !== 'ok' ? ` ${nobodyN} with no fix planned.` : '') }),
    el('span', { class: 'mb-chev', text: isOpen ? '−' : '+' }));
    const body = isOpen ? el('div', { class: 'mb-rows' }, inGroup.map((f) => row(f, st.f === f.id, () => set({ f: st.f === f.id ? '' : f.id })))) : null;
    return el('section', { class: 'mb-group' }, head, body);
  }).filter(Boolean);

  main.replaceChildren(hero, glance, tools,
    sections.length ? el('div', { class: 'mb-groups' }, sections) : el('p', { class: 'mb-sub', text: 'Nothing matches.' }),
    sourcesNote(board));

  if (st.f) {
    const target = main.querySelector('.mb-row[aria-expanded="true"]');
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
  }
}

function row(f, isOpen, toggle) {
  const chip = ownerChip(f);
  const area = humanArea(f);
  const head = el('button', { type: 'button', class: 'mb-row', 'aria-expanded': isOpen ? 'true' : 'false', onclick: toggle },
    el('span', { class: 'mb-row-main' },
      el('span', { class: 'mb-name', text: humanName(f) }),
      area ? el('span', { class: 'mb-area', text: area }) : null,
      statusLine(f) ? el('span', { class: 'mb-line', text: statusLine(f) }) : null),
    chip ? el('span', { class: 'mb-chip', 'data-tone': chip.tone, text: chip.text }) : null);
  const item = el('div', { class: 'mb-item' }, head);
  if (isOpen) item.append(detail(f));
  return item;
}

function detail(f) {
  const r = f.review;
  const steps = timeline(f, Date.now());
  const fus = (f.followUp && f.followUp.items) || [];
  const rows = card(f);
  return el('div', { class: 'mb-detail' },
    rows.length ? el('dl', { class: 'mb-card' }, rows.flatMap((x) => [
      el('dt', { text: x.label }),
      el('dd', { text: x.text, 'data-tone': x.tone || null }),
    ])) : el('p', { class: 'mb-detail-line', text: 'The review hasn’t described this one in plain words yet.' }),
    steps.length ? el('ol', { class: 'mb-steps', 'aria-label': 'What happened, by date' },
      steps.map((p) => el('li', { class: `${p.overdue ? 'overdue' : ''}${p.future ? ' future' : ''}` },
        el('span', { class: 'mb-when', text: p.when }), el('span', { text: p.label })))) : null,
    r ? el('p', { class: 'mb-fine', text: `From the ${fmtDate(r.date)} review (an AI model’s assessment)${r.evidenceReadToday === false ? ', carried over, not re-checked' : ''}.` }) : el('p', { class: 'mb-fine', text: 'Not in the latest review.' }),
    el('details', { class: 'mb-tech' },
      el('summary', { text: 'Technical details' }),
      el('dl', {},
        ...kv('Setting', f.id),
        ...kv('Review verdict', r && r.verdictRaw),
        ...kv('Evidence', r && r.evidence),
        ...kv('Decision', r && r.decision),
        ...kv('Action', r && r.action),
        ...kv('Tasks', fus.map((i) => `${i.ref} (${i.label})`).join(', ')),
        ...kv('Live records', (f.owners || []).map((o) => `${o.machine} · ${o.source}: ${Object.entries(o.facts).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${k} ${v}`).join(', ')}`).join('\n')),
        ...kv('Sources disagree', (f.conflicts || []).map((c) => `${c.machine}: ${c.a} vs ${c.b}`).join('\n')),
      )));
}

function kv(k, v) { return v ? [el('dt', { text: k }), el('dd', { text: v })] : []; }

function sourcesNote(board) {
  const bad = (board.sources || []).filter((s) => !s.ok);
  const peers = (board.sources || []).filter((s) => s.name === 'peer');
  const answered = peers.filter((s) => s.ok).length + 1;
  return el('details', { class: 'mb-sources' },
    el('summary', { text: `Where this comes from · ${answered} of ${peers.length + 1} machines answered${bad.length ? ` · ${bad.length} source${bad.length === 1 ? '' : 's'} unreadable` : ''}` }),
    el('p', { class: 'mb-fine', text: 'This page only reads what other parts of the system record. It changes nothing. Groups are the review’s judgement, put in plain words.' }),
    el('ul', {}, (board.sources || []).map((s) => el('li', { text: `${s.ok ? 'OK' : 'Not read'} · ${s.name}${s.machine ? ` · ${s.machine}` : ''}${s.reason ? ` · ${s.reason}` : ''}` }))));
}

let probeResult = null; // checked once per page load
/** The Work-group tile: shown only when the board answers (hidden on 503 or any failure). */
export function maturationTile(get) {
  const a = el('a', { class: 'tile', href: '#/work/maturation' },
    el('span', { class: 't-icon', icon: 'layers' }),
    el('span', {}, el('span', { class: 't-name', text: 'Feature maturation' }),
      el('span', { class: 't-desc', text: 'How every feature on its way to being switched on is doing, and which stuck ones have a fix planned.' })));
  const host = el('div', { class: 'tiles tiles-maturation', hidden: true }, a);
  if (!probeResult) probeResult = get('/maturation/board?part=probe').then((r) => r.ok).catch(() => false);
  probeResult.then((ok) => { host.hidden = !ok; });
  return host;
}
