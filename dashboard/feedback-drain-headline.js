/**
 * Feedback Drain tab — the decision headline (ACT-003).
 *
 * The tab used to open on the drain's debugging counters, so a cold glance showed
 * numbers and no obvious action. This module answers the only question the operator
 * opens the tab with — "does anything here need me, and what do I press?" — in one
 * sentence and at most one button, the same shape as the Process Health headline.
 *
 * Presentation only. It reads the same GET routes the cards below already read and
 * changes no gate, authority, route or PIN behaviour: the button only brings the
 * existing approval card into view (and, for the executor acceptance, presses that
 * card's own "Let it run anyway…" preview step, which itself still needs the PIN).
 * Every dynamic value is written with textContent, never innerHTML.
 */

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

const pending = (p) => Boolean(p && p.approveAction);

/** Fixes whose pull request is waiting for the operator's GitHub approval. */
export function fixesAwaitingReview(queue) {
  const items = (queue && Array.isArray(queue.items)) ? queue.items : [];
  return items.filter((i) => (i.executionState === 'pr-open' || i.executionState === 'spec-pr-open') && typeof i.prLink === 'string' && /^https:\/\/github\.com\//.test(i.prLink));
}

/**
 * Everything on this tab that is the operator's to do, most important first.
 * Each entry: { sentence, button, target, press?, href? }.
 */
export function operatorTodos(data) {
  const d = data || {};
  const todos = [];
  const ready = d.readiness;
  if (pending(ready)) {
    const why = ready.status === 'proposal-only'
      ? ` It was paused: ${ready.pausedBecause || 'a safety brake fired.'}`
      : ready.status === 'revoked' ? ' You turned it off earlier.' : '';
    todos.push({
      sentence: 'Feedback is waiting on one approval from you.',
      detail: `Approve which model sorts incoming reports.${why}`,
      button: 'Review and approve', target: 'fdAuthority', focus: 'fraPin',
    });
  }
  if (pending(d.triageProposal)) {
    todos.push({
      sentence: 'Feedback is waiting on one approval from you.',
      detail: 'Approve which model decides which reports get fixed.',
      button: 'Review and approve', target: 'fdTriage', focus: 'ftPin',
    });
  }
  if (d.execute && d.execute.reason === 'approver-not-independent') {
    todos.push({
      sentence: 'The fix worker needs your one-time OK to run.',
      detail: 'This agent could approve its own fixes on GitHub, so it waits for you. Every fix still needs your GitHub approval to merge.',
      button: 'Review and decide', target: 'fdTriage', focus: 'ftPin', press: 'plan-accept-approver-dependence',
    });
  }
  const held = ((d.execute && d.execute.attempts) || []).filter((a) => a.state === 'held' && a.reason === 'needs-review-secret-shape');
  if (held.length > 0) {
    todos.push({
      sentence: `${held.length === 1 ? 'A fix needs' : `${held.length} fixes need`} your look before publishing.`,
      detail: 'It touched files that look like they hold a secret, so it is on hold.',
      button: 'Review it', target: 'fdTriage', focus: 'ftPin', press: 'plan-publish-secret-shape',
    });
  }
  const prs = fixesAwaitingReview(d.queue);
  if (prs.length > 0) {
    todos.push({
      sentence: `${prs.length === 1 ? 'A fix is' : `${prs.length} fixes are`} waiting for your approval on GitHub.`,
      detail: 'Approve it there and it merges on its own.',
      button: prs.length === 1 ? 'Open the fix' : 'Open the first fix', href: prs[0].prLink,
    });
  }
  return todos;
}

/** What to say when nothing needs the operator. */
function calmLine(d) {
  const blockers = (d.readiness && d.readiness.blockers) || [];
  if (!d.readiness && !d.triageSummary) {
    return { sentence: 'Nothing here needs you.', sub: 'The feedback drain is not running on this machine, so there is nothing to approve here.' };
  }
  if (d.readiness && d.readiness.status === 'none' && blockers.length > 0) {
    return { sentence: 'Nothing here needs you yet.', sub: `Feedback sorting can't be set up on this machine yet: ${blockers[0]}` };
  }
  const c = (d.triageSummary && d.triageSummary.counts) || null;
  if (!c) return { sentence: 'Nothing here needs you.', sub: 'Incoming feedback is being sorted on its own.' };
  const work = c.work || 0;
  const waiting = (c.untriaged || 0) + (c.queued || 0);
  return {
    sentence: 'Nothing here needs you.',
    sub: `Feedback is being sorted and fixed on its own — ${work} item${work === 1 ? '' : 's'} picked to work on, ${waiting} waiting to be sorted.`,
  };
}

/**
 * The headline model: { tone: 'action'|'calm', sentence, sub, todo|null }.
 * tone 'action' means something is the operator's to do.
 */
export function decideHeadline(data) {
  const d = data || {};
  const todos = operatorTodos(d);
  if (todos.length > 0) {
    const more = todos.length - 1;
    const after = more > 0 ? ` After that, ${more} more thing${more === 1 ? '' : 's'} here need${more === 1 ? 's' : ''} you.` : '';
    return {
      tone: 'action',
      sentence: todos[0].sentence,
      sub: `${todos[0].detail || ''}${after}`.trim(),
      todo: todos[0],
    };
  }
  const calm = calmLine(d);
  return { tone: 'calm', sentence: calm.sentence, sub: calm.sub, todo: null };
}

/**
 * Render the headline into `target`. `handlers.reveal(todo)` brings the approval card
 * for a todo into view; links open in a new tab.
 */
export function renderHeadline(doc, target, model, handlers = {}) {
  if (!target) return;
  target.replaceChildren();
  const box = el(doc, 'div', `fd-decision fd-decision-${model.tone === 'action' ? 'action' : 'calm'}`);
  box.appendChild(el(doc, 'div', 'ph-headline', model.sentence));
  if (model.sub) box.appendChild(el(doc, 'div', 'ph-subline', model.sub));
  const todo = model.todo;
  if (todo && todo.href) {
    const a = el(doc, 'a', 'spend-arm-btn spend-arm-btn-commit fd-decision-btn', todo.button);
    a.href = todo.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    box.appendChild(a);
  } else if (todo) {
    const b = el(doc, 'button', 'spend-arm-btn spend-arm-btn-commit fd-decision-btn', todo.button);
    b.setAttribute('data-fd-action', 'reveal');
    b.addEventListener('click', () => { if (typeof handlers.reveal === 'function') handlers.reveal(todo); });
    box.appendChild(b);
  }
  target.appendChild(box);
}

/** The headline shown before any data has arrived — never a wall of numbers. */
export function renderChecking(doc, target) {
  if (!target) return;
  target.replaceChildren();
  const box = el(doc, 'div', 'fd-decision fd-decision-calm');
  box.appendChild(el(doc, 'div', 'ph-headline', 'Checking whether anything here needs you…'));
  target.appendChild(box);
}
