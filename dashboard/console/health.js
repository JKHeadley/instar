// Health page (docs/specs/mobile-health-issues.md): each thing that is off, in plain words, with its
// details, the fix when there is one, and a way to ask the agent. Problems that affect the person lead;
// internal ones stay folded. Every value goes through textContent. The quick actions and the Hidden list
// (docs/specs/health-quick-actions.md) sit under each problem and at the foot of the page.

import { buildHealthPage, askHref, timesWord, issueChoices, SNOOZE_CHOICES, choiceFailure, hiddenRowWords, hiddenAskHref } from './health-model.js';
import { el, setKids, pageHead, note, cantTell, firstPaint, markNeed, arrivalScroll, sheet, closeSheet } from './ui.js';
import { legacyHref } from './nav-model.js';

const wantKey = () => new URLSearchParams((location.hash.split('?')[1] || '')).get('s');

/** Sends one choice, then redraws from the answer. A failure says so in place and changes nothing. */
function act(ctx, path, body, button, place, refresh) {
  button.disabled = true;
  return ctx.post(path, body).then((r) => {
    if (r.ok) { closeSheet(); return refresh(r.data && r.data.note); }
    button.disabled = false;
    place.replaceChildren(el('p', { class: 'card-note', text: choiceFailure(r.reason) }));
    return undefined;
  });
}

function choiceBar(issue, ctx, refresh) {
  const can = issueChoices(issue);
  const place = el('div');
  const send = (body, button) => act(ctx, '/mobile/health-issues/choices', { id: issue.id, keys: issue.keys, ...body }, button, place, refresh);
  const btn = (text, onclick, cls = 'btn-quiet btn-small') => {
    const b = el('button', { class: cls, type: 'button', text });
    b.addEventListener('click', () => onclick(b));
    return b;
  };
  const ignore = () => {
    const go = btn('Ignore it', (b) => send({ choice: 'ignore' }, b), 'btn-danger');
    sheet({ title: 'Ignore this completely?' }, el('p', { class: 'confirm-text', text: issue.ignoreSays }),
      el('div', { class: 'confirm-row' }, el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeSheet() }), go));
  };
  if (!can.snooze && !can.hide && !can.ignore) return issue.choiceNote ? el('p', { class: 'mc-evidence', text: issue.choiceNote }) : null;
  return el('div', { class: 'health-choices' },
    can.snooze ? el('div', { class: 'health-choice-row' }, el('span', { class: 'health-choice-label', text: 'Hide for' }), SNOOZE_CHOICES.map((c) => btn(c.label, (b) => send({ choice: 'snooze', hours: c.hours }, b)))) : null,
    can.hide || can.ignore ? el('div', { class: 'health-choice-row' },
      can.hide ? btn('Hide from me', (b) => send({ choice: 'hide' }, b)) : null,
      can.ignore ? btn('Ignore completely', ignore, 'btn-quiet btn-small btn-danger-outline') : null) : null,
    issue.choiceNote ? el('p', { class: 'mc-evidence', text: issue.choiceNote }) : null,
    place);
}

function hiddenRow(row, ctx, refresh) {
  const words = hiddenRowWords(row);
  const place = el('div');
  const back = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Bring back' });
  back.addEventListener('click', () => act(ctx, '/mobile/health-issues/choices/undo', { key: row.key }, back, place, refresh));
  return el('div', { class: 'card', 'data-focus-key': `hidden:${row.key}` },
    el('div', { class: 'row-title', text: row.title }),
    el('p', { class: 'mc-evidence', text: [words.kind, words.by].filter(Boolean).join(' · ') }),
    el('p', { text: words.line }),
    el('div', { class: 'card-foot' }, back, el('a', { class: 'btn-quiet', href: hiddenAskHref(row), text: 'Ask the agent about this' })),
    place);
}

function issueCard(issue, open, ctx, refresh) {
  const times = timesWord(issue.count);
  return el('details', { class: 'card', 'data-focus-key': `h:${issue.id}`, open: open || null },
    el('summary', { class: 'row-title', text: issue.title }),
    issue.returnNote ? el('p', { class: 'card-note', text: issue.returnNote }) : null,
    el('p', { text: issue.detail }),
    issue.evidence ? el('p', { class: 'mc-evidence', text: `In my own words: ${issue.evidence}` }) : null,
    times ? el('p', { class: 'mc-evidence', text: times }) : null,
    el('div', { class: 'card-foot' },
      issue.action ? el('a', { class: 'btn-primary btn-inline', href: issue.action.console, text: issue.action.label }) : null,
      el('a', { class: issue.action ? 'btn-quiet' : 'btn-primary btn-inline', href: askHref(issue), text: 'Ask the agent about this' })),
    choiceBar(issue, ctx, refresh),
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
  // A choice redraws the page from a fresh read, and keeps its note on screen if a machine didn't answer.
  const refresh = (said) => renderHealth(main, ctx).then(() => { if (said) main.prepend(note(said)); });
  const card = (i, lead) => issueCard(i, lead || i.id === want, ctx, refresh);
  const quietOpen = page.quiet.some((i) => i.id === want);
  const quiet = page.quiet.length ? fold(page.quiet.length === 1 ? 'One internal note' : `${page.quiet.length} internal notes`, page.quiet.map((i) => card(i, false))) : null;
  if (quiet && quietOpen) quiet.setAttribute('open', '');
  const hidden = page.hidden.length ? fold(`Hidden (${page.hidden.length})`, page.hidden.map((r) => hiddenRow(r, ctx, refresh))) : null;
  if (hidden && want === 'hidden') hidden.setAttribute('open', '');
  setKids(main,
    pageHead({ noAsk: true, eyebrow: 'Capacity · Health', headline: page.headline, sub: page.sub, tone: page.tone, facts: page.uptime ? [{ n: page.uptime, label: 'running for' }] : [] }),
    page.problems.map((i) => markNeed(card(i, true), 'health')),
    page.unsorted.map((i) => card(i, false)),
    quiet,
    hidden,
    page.hiddenUnreadable ? note('I couldn’t read what you’ve hidden, so everything is showing.') : null,
    page.truncated ? note('There are more than I can show here. Ask me for the rest.') : null,
    legacy,
  );
  if (want) arrivalScroll(main.querySelector(`[data-focus-key="h:${CSS.escape(want)}"]`), { key: `h:${want}` });
}
