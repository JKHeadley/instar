// Who can reach me (docs/specs/team-roles-and-access.md §3.10). Read only: GET /team/people.
// Every value reaches the DOM through textContent (el's text attribute); nothing is HTML.

import { buildReachPage } from './reach-model.js';
import { el, setKids, pageHead, note, cantTell, firstPaint } from './ui.js';

const EYEBROW = 'People · Who can reach me';

function personCard(p) {
  return el('div', { class: 'card reach-person', 'data-focus-key': p.key },
    el('h3', { text: p.title }),
    el('p', { text: p.tier }),
    p.reach ? el('p', { text: `Through: ${p.reach}` }) : null,
    p.sees ? el('p', { text: `Can see: ${p.sees}` }) : null,
    ...p.warnings.map((w) => note(w)));
}

export async function renderReach(main, ctx) {
  firstPaint(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { class: 'page-title', text: 'Reading who can reach this agent…' })));
  const res = await ctx.get('/team/people?scope=pool');
  const page = buildReachPage(res);
  if (!page.ok) { setKids(main, pageHead({ eyebrow: EYEBROW, headline: 'I can’t tell right now.' }), cantTell(page.reason)); return; }
  setKids(main, el('div', { class: 'reach-page' },
    pageHead({ eyebrow: EYEBROW, headline: page.head.text, sub: page.head.sub, tone: page.head.tone }),
    el('div', { class: 'page-sections' }, page.rows.map(personCard)),
    page.notes.map((n) => note(n))));
}
