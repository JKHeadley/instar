// Repositories page (docs/specs/no-data-loss-on-machine-death.md §1.7): every repository the agent works in,
// on every machine, and whether its work exists anywhere else. What needs the owner leads the page. Read-only:
// nothing here changes a repository; the one action asks the agent. Every value goes through textContent.

import { buildReposPage, askHref, REPOS_READ } from './repos-model.js';
import { el, setKids, pageHead, note, cantTell, firstPaint, markNeed, arrivalScroll } from './ui.js';

const EYEBROW = 'Capacity · Repositories';
const wantKey = () => new URLSearchParams((location.hash.split('?')[1] || '')).get('s');

function needCard(n) {
  return markNeed(el('section', { class: 'need-card', 'data-focus-key': n.key },
    el('h2', { class: 'need-title', text: n.main }),
    n.sub ? el('p', { class: 'need-line', text: n.sub }) : null,
    el('div', { class: 'confirm-row' }, el('a', { class: 'btn-primary btn-inline', href: askHref({ kind: n.kind, machineName: n.machineName, repos: n.refs, key: n.key }), text: 'Ask the agent to copy it off the machine' }))), 'repos');
}

export async function renderRepos(main, ctx) {
  firstPaint(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { class: 'page-title skeleton', text: 'Loading repositories' })));
  const res = await ctx.get(REPOS_READ, 15000);
  const page = buildReposPage(res);
  if (!page.ok) { setKids(main, pageHead({ eyebrow: EYEBROW, headline: 'Repositories', tone: 'muted' }), cantTell(page.reason)); return; }
  const machines = page.machines.map((m) => el('details', { class: 'list-section', open: page.machines.length === 1 || null },
    el('summary', { class: 'eyebrow', text: `${m.name} · ${m.repos.length} repositor${m.repos.length === 1 ? 'y' : 'ies'}` }),
    m.note ? note(m.note) : null,
    m.repos.map((r) => el('div', { class: 'card', 'data-state': r.tone },
      el('div', { class: 'row-title', text: r.path }),
      el('p', { class: 'card-line', text: r.line })))));
  setKids(main,
    pageHead({ noAsk: true, eyebrow: EYEBROW, headline: page.headline, tone: page.tone, sub: 'Work that exists on only one machine is lost if that machine is. This lists every repository I work in and whether it has a copy anywhere else.' }),
    page.needs.map(needCard),
    machines,
    page.scan && page.scan.state !== 'complete' ? note('I haven’t finished looking through every folder yet, so this list may grow.') : null,
  );
  const want = wantKey();
  if (want) arrivalScroll(main.querySelector(`[data-focus-key="${CSS.escape(want)}"]`), { key: want });
}
