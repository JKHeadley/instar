// Health page (docs/specs/mobile-health-issues.md): each thing that is off, in plain words, with its
// details, the fix when there is one, and a way to ask the agent. Problems that affect the person lead;
// internal ones stay folded. Every value goes through textContent.

import { buildHealthPage, askHref, timesWord } from './health-model.js';
import { el, setKids, pageHead, note, cantTell, firstPaint, markNeed } from './ui.js';
import { legacyHref } from './nav-model.js';

const wantKey = () => new URLSearchParams((location.hash.split('?')[1] || '')).get('s');

function issueCard(issue, open) {
  const times = timesWord(issue.count);
  return el('details', { class: 'card', 'data-focus-key': `h:${issue.id}`, open: open || null },
    el('summary', { class: 'row-title', text: issue.title }),
    el('p', { text: issue.detail }),
    issue.evidence ? el('p', { class: 'mc-evidence', text: `In my own words: ${issue.evidence}` }) : null,
    times ? el('p', { class: 'mc-evidence', text: times }) : null,
    el('div', { class: 'card-foot' },
      issue.action ? el('a', { class: 'btn-primary btn-inline', href: issue.action.console, text: issue.action.label }) : null,
      el('a', { class: issue.action ? 'btn-quiet' : 'btn-primary btn-inline', href: askHref(issue), text: 'Ask the agent about this' })),
  );
}

function fold(title, kids) {
  return el('details', { class: 'list-section' }, el('summary', { class: 'eyebrow', text: title }), kids);
}

export async function renderHealth(main, ctx) {
  firstPaint(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Capacity · Health' }), el('h1', { class: 'page-title', text: 'Checking how I’m doing…' })));
  const res = await ctx.get('/mobile/health-issues');
  const page = buildHealthPage(res);
  const legacy = el('p', { class: 'foot-note' }, el('a', { href: legacyHref('systems'), text: 'Each subsystem, one by one, is in the legacy Health tab.' }));
  if (!page.ok) { setKids(main, pageHead({ eyebrow: 'Capacity · Health', headline: 'Health', tone: 'muted' }), cantTell(page.reason), legacy); return; }
  const want = wantKey();
  const card = (i, lead) => issueCard(i, lead || i.id === want);
  const quietOpen = page.quiet.some((i) => i.id === want);
  const quiet = page.quiet.length ? fold(page.quiet.length === 1 ? 'One internal note' : `${page.quiet.length} internal notes`, page.quiet.map((i) => card(i, false))) : null;
  if (quiet && quietOpen) quiet.setAttribute('open', '');
  setKids(main,
    pageHead({ eyebrow: 'Capacity · Health', headline: page.headline, sub: page.sub, tone: page.tone, facts: page.uptime ? [{ n: page.uptime, label: 'running for' }] : [] }),
    page.problems.map((i) => markNeed(card(i, true), 'health')),
    page.unsorted.map((i) => card(i, false)),
    quiet,
    page.truncated ? note('There are more than I can show here. Ask me for the rest.') : null,
    legacy,
  );
  if (want) { const n = main.querySelector(`[data-focus-key="h:${CSS.escape(want)}"]`); if (n && n.scrollIntoView) n.scrollIntoView({ block: 'start' }); }
}
