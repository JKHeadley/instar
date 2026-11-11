// Settings → Context (docs/specs/context-budget-layered-summaries.md §11, Phase 1 S14).
// READ-ONLY: what each conversation's running summary holds, how fresh it is, what it costs,
// and whether recovery after a compression works here. Every value reaches the DOM through
// textContent; context-model.js decides every word.

import { buildContextPage, RECOVERY_INTRO, WATCHER_INTRO } from './context-model.js';
import { el, setKids, pageHead, section, sheet, story, note, firstPaint, markNeed, askLink } from './ui.js';
import { topicNameMap } from './topic-names.js';

const EYEBROW = 'Settings · Context';
const POOL_TIMEOUT_MS = 12_000;

function linesBlock(id, title, block, intro) {
  const wrap = el('section', { class: 'list-section', id: `sec-${id}` },
    el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: title })),
    intro ? el('p', { class: 'card-line', text: intro }) : null);
  const lines = (block && block.lines) || [];
  wrap.append(el('ul', { class: 'pace-lines' }, lines.map((l) => {
    const text = typeof l === 'string' ? l : l.text;
    const tone = typeof l === 'string' ? '' : l.tone;
    return el('li', { class: 'pace-line', 'data-tone': tone || 'ok' },
      el('span', { class: `dot ${tone === 'attn' ? 'attn' : tone === 'unknown' || tone === 'muted' ? 'unknown' : ''}`.trim() }),
      el('span', { class: 'pace-text', text }));
  })));
  if (block && block.note) wrap.append(note(block.note));
  return wrap;
}

export async function renderContext(main, ctx) {
  const { get } = ctx;
  firstPaint(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { class: 'page-title skeleton', text: 'Loading conversation summaries' })));
  const [layers, metrics, sentinel, delta, topics] = await Promise.all([
    get('/context-budget/layers'), get('/context-budget/metrics'), get('/context-budget/sentinel'), get('/context-budget/delta-shadow'),
    get('/telegram/topics?scope=pool', POOL_TIMEOUT_MS),
  ]);
  const names = topicNameMap(topics);
  const page = buildContextPage({ layers, metrics, sentinel, delta }, Date.now(), names);
  const hero = pageHead({ eyebrow: EYEBROW, headline: page.headline, sub: page.sub, tone: page.tone, facts: page.facts, noAsk: page.needs.length > 0 });
  if (page.off) { setKids(main, el('div', { class: 'context-page' }, hero)); return; }

  // What needs the operator leads, each with a way to act on it in place.
  const needs = page.needs.length
    ? markNeed(el('div', { class: 'need-card' }, page.needs.map((n) => [
      el('span', { class: 'need-title', text: n.title }),
      el('span', { class: 'need-sub', text: n.detail }),
      askLink(n.ask, 'Ask the agent what to do'),
    ]), page.needsStale ? el('span', { class: 'need-sub', text: `As of the watcher’s last check${page.lastCheck ? `, ${page.lastCheck}` : ''}; it may have changed since.` }) : null), 'context')
    : page.needsUnreadable ? note('The watcher answered in a form this page does not understand, so it can’t tell whether anything is stuck.') : null;

  const conv = section({
    id: 'conversations', title: 'Conversations', rows: page.conversations,
    empty: 'No conversation has a summary on this machine yet.',
    onRow: (r) => sheet({ title: r.main }, story(r.detail)),
  });
  if (page.conversationsNote) conv.append(note(page.conversationsNote));

  setKids(main, el('div', { class: 'context-page' },
    hero,
    needs,
    el('div', { class: 'page-sections' },
      linesBlock('recovery', 'Recovery after a compression', page.recovery, RECOVERY_INTRO),
      conv,
      linesBlock('cost', 'What it costs', page.cost),
      linesBlock('trial', 'Trial: sending only what changed', page.trial),
      linesBlock('upkeep', 'The watcher', page.upkeep, WATCHER_INTRO),
    ),
    el('p', { class: 'foot-note', text: 'A token is about three quarters of a word; re-reading text the AI already has costs a tenth as much, and costs here are counted that way.' }),
  ));
}
