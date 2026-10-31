// Queue pace — the "Pace" card under Work (docs/specs/queue-pace.md §Surfaces).
// Every value is written with textContent via el(); links are built only from PR numbers.

import { el } from './ui.js';
import { paceLine, paceSummary, prLinks, toneOf, maturationPaceLine } from './pace-model.js';

const POOL_TIMEOUT_MS = 12_000;
const DOT = { attn: 'attn', ok: '', unknown: 'unknown', muted: 'unknown' };

/** The Pace card: hidden when the route is off (503) or fails; one plain line per queue. */
export function paceCard(get) {
  const host = el('section', { class: 'card pace-card', 'data-state': 'loading', hidden: true },
    el('div', { class: 'card-head' }, el('span', { class: 'dot unknown' }), el('h2', { class: 'card-title', text: 'Pace' })));
  get('/queue-pace?scope=pool', POOL_TIMEOUT_MS).then((r) => {
    if (!r.ok) return; // switched off or unreachable: the card stays hidden
    const queues = (r.data && r.data.queues) || [];
    const machines = new Set(queues.map((q) => q.machine));
    const anyBehind = queues.some((q) => toneOf(q) === 'attn');
    host.dataset.state = anyBehind ? 'attn' : 'ok';
    const lines = queues.map((q) => {
      const tone = toneOf(q);
      const li = el('li', { class: 'pace-line', 'data-tone': tone },
        el('span', { class: `dot ${DOT[tone] || ''}`.trim() }),
        el('span', { class: 'pace-text', text: paceLine(q, machines.size > 1) }));
      const links = prLinks(q);
      if (links.length) li.append(el('span', { class: 'pace-prs' }, links.map((l) => el('a', { href: l.href, target: '_blank', rel: 'noopener', text: `#${l.n}` }))));
      return li;
    });
    host.replaceChildren(
      el('div', { class: 'card-head' }, el('span', { class: `dot ${anyBehind ? 'attn' : ''}`.trim() }), el('h2', { class: 'card-title', text: 'Pace' })),
      el('p', { class: 'card-line', text: paceSummary(queues) }),
      el('ul', { class: 'pace-lines' }, lines),
      el('p', { class: 'card-note', text: 'Each line compares how much work comes in with how much gets done over the last week. It only measures; it changes nothing by itself.' }),
    );
    host.hidden = false;
  }).catch(() => { /* hidden on any failure */ });
  return host;
}

/** One pace line for the maturation board headline (empty when not measured or switched off). */
export function maturationPaceNode(get) {
  const p = el('p', { class: 'mb-sub mb-pace', hidden: true });
  get('/queue-pace', POOL_TIMEOUT_MS).then((r) => {
    if (!r.ok) return;
    const line = maturationPaceLine(r.data);
    if (!line) return;
    p.textContent = line;
    p.hidden = false;
  }).catch(() => { /* hidden on any failure */ });
  return p;
}
