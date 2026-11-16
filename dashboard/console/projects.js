// Projects on the Work door (docs/specs/work-front-doors.md stage 2a): every project the Chief of Staff
// tracks, where it stands, its done list and its cards. One row per project; a row opens in place.
// SAFETY: every server value goes through textContent via el().

import { el } from './ui.js';
import { projectsView } from './projects-model.js';

const DONE_MARK = { pass: '✓', fail: '✗', unknown: '·' };
/** The console's own dot classes (console.css .dot.attn / .bad / .unknown; plain .dot is ok; quiet is a muted ok). */
const DOT = { attn: 'dot attn', bad: 'dot bad', unknown: 'dot unknown', ok: 'dot', quiet: 'dot quiet' };

function cardLine(c) {
  return el('li', { class: 'project-card' },
    el('a', { href: c.href, text: c.title }),
    c.sub ? el('span', { class: 'need-sub', text: ` · ${c.sub}` }) : null,
    c.chatHref ? el('a', { class: 'link-btn project-chat', href: c.chatHref, text: 'Conversation' }) : null);
}

function projectRow(p) {
  const summary = el('summary', { class: 'project-summary' },
    el('span', { class: DOT[p.tone] || 'dot', 'aria-hidden': 'true' }),
    el('span', { class: 'project-text' },
      el('span', { class: 'project-title', text: p.title }),
      el('span', { class: 'project-state', text: [p.stateWords, p.doneLine, p.cardsLine].filter(Boolean).join(' · ') })));
  return el('details', { class: `project-row tone-${p.tone}`, 'data-project': p.key },
    summary,
    el('div', { class: 'project-body' },
      p.pausedLine ? el('p', { class: 'need-sub', text: p.pausedLine }) : null,
      p.goal ? el('p', { class: 'project-goal', text: p.goal }) : null,
      p.doneItems.length ? el('ul', { class: 'project-done', 'aria-label': 'Done when' },
        p.doneItems.map((i) => el('li', { class: `done-${i.state}` }, el('span', { class: 'done-mark', 'aria-hidden': 'true', text: DONE_MARK[i.state] }), el('span', { text: ` ${i.text}` })))) : null,
      p.cards.length ? el('ul', { class: 'project-cards', 'aria-label': 'Cards' }, p.cards.map(cardLine)) : el('p', { class: 'need-sub', text: 'No cards yet.' }),
      p.moreCards ? el('p', { class: 'need-sub', text: `${p.moreCards} more cards` }) : null,
      p.chatHref ? el('p', {}, el('a', { class: 'link-btn', href: p.chatHref, text: 'Open the project conversation' })) : null));
}

/** The Projects section, or null when the answer cannot be read and the board is the only thing to show. */
export function projectsSection(data) {
  const v = projectsView(data);
  const wrap = el('section', { class: 'list-section projects-section', id: 'sec-projects' },
    el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Projects' }), v.ok ? el('span', { class: 'list-count', text: String(v.count) }) : null));
  if (!v.ok) { wrap.append(el('p', { class: 'need-sub', text: 'The projects could not be read, so this may not be everything.' })); return wrap; }
  if (v.line) wrap.append(el('p', { class: 'need-sub', role: 'status', text: v.line }));
  if (v.off) wrap.append(el('p', { class: 'empty-line', text: 'Project tracking (the Chief of Staff) is not switched on for this agent.' }));
  if (v.empty) wrap.append(el('p', { class: 'empty-line', text: 'No projects are being tracked yet.' }));
  for (const p of v.active) wrap.append(projectRow(p));
  if (v.finished.length) {
    wrap.append(el('details', { class: 'projects-finished' },
      el('summary', { class: 'eyebrow', text: `Finished (${v.finished.length})` }),
      v.finished.map(projectRow)));
  }
  if (v.loose.length) {
    wrap.append(el('details', { class: 'projects-loose' },
      el('summary', { class: 'eyebrow', text: `Cards in no project (${v.loose.length})` }),
      el('ul', { class: 'project-cards' }, v.loose.map(cardLine))));
  }
  return wrap;
}
