/**
 * Feedback Drain tab — Triage section (docs/specs/feedback-triage-and-execution.md §3, §5, §7).
 *
 * Renders, in plain language: the triage authority approval card (one PIN tap; the server
 * computes every technical field), the summary, the ranked work queue, and the PIN-bound
 * "turn ignores live" plan/commit buttons. Every dynamic value is written with textContent,
 * never innerHTML. Mirrors feedback-readiness-authority.js.
 */

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** Where the triage authority stands, in the operator's words. */
export function triageStatusLine(p) {
  const s = (p && p.status) || 'none';
  const cur = (p && p.current) || null;
  if (s === 'none') return 'Not set up yet — feedback work items are not being sorted until you approve the sorting model.';
  if (s === 'revoked') return `Revoked (version ${cur ? cur.generation : '?'}). Triage is not sorting anything.`;
  if (s === 'proposal-only') return `Paused (version ${cur ? cur.generation : '?'}) — ${(p && p.pausedBecause) || 'a safety brake fired.'} Approve again to resume.`;
  if (cur && cur.matchesProposal === false) return `Active (version ${cur.generation}), but out of date for this machine — approve to update it.`;
  return `Active (version ${cur ? cur.generation : '?'}): up to ${cur ? cur.maxBatch : '?'} items per batch.`;
}

/** The POST body for an approve (create/replace/restore) or revoke of the triage authority. */
export function triageAuthorityRequest(action, pin, operatorDecisionRef) {
  const body = { action, pin, operatorDecisionRef };
  if (action === 'create' || action === 'replace') body.useProposal = true;
  return body;
}

export function newTriageDecisionRef(now = new Date(), rand = Math.random) {
  const suffix = Math.floor(rand() * 0xffffffff).toString(16).padStart(8, '0');
  return `dashboard-triage:${now.toISOString().replace(/[^0-9A-Za-z]/g, '')}:${suffix}`;
}

export function triageResultNote(ok, data) {
  if (ok) return data && data.revoked ? 'Revoked. Triage stops at its next run.' : `Approved (version ${data ? data.generation : '?'}). The next triage run starts sorting.`;
  const m = String((data && data.error) || '');
  if (/incorrect pin|pin required/i.test(m)) return 'That PIN was not accepted. Nothing has changed.';
  if (/too many/i.test(m)) return 'Too many PIN attempts — wait a few minutes. Nothing has changed.';
  return `Not applied: ${m || 'the server refused'}. Nothing has changed.`;
}

const AUTHORITY_WORDS = {
  'awaiting-approval': 'waiting for your approval',
  active: 'sorting',
  paused: 'paused by a safety brake',
  'self-healing': 'retrying on its own after unusable answers',
  exhausted: 'stopped after its automatic retries — approve again to restart',
  'binding-stale': 'needs a fresh approval for this machine',
};

/** One plain paragraph for the summary. */
export function summaryText(summary) {
  if (!summary) return 'Triage status is unavailable.';
  const c = summary.counts || {};
  const parts = [
    `Triage is ${AUTHORITY_WORDS[summary.authority] || summary.authority}.`,
    `${c.work || 0} to work on, ${c.hold || 0} held, ${c.ignored || 0} set aside, ${(c.untriaged || 0) + (c.queued || 0)} waiting to be sorted.`,
    `Model calls today: ${summary.callsUsedToday || 0} of ${summary.maxCallsPerDay || 0}.`,
  ];
  if (summary.quotaPause && summary.quotaPause.at) parts.push('Paused for now: the account serving triage is near its usage limit.');
  if (summary.ignoreBrake && summary.ignoreBrake.engaged) parts.push('Ignores are braked: the ignore rate rose sharply, so new ignores are being held.');
  parts.push(summary.ignoreLive ? 'Ignores are live.' : 'Ignores are in practice mode (parked as holds).');
  if (summary.ignoreLiveRecommended && !summary.ignoreLive) parts.push('The evidence says ignores are ready to go live — see the button below.');
  return parts.join(' ');
}

const EXECUTION_WORDS = {
  queued: '', running: ' (being worked on)', 'pr-open': ' (fix waiting for your approval)', 'spec-pr-open': ' (design draft waiting for your approval)',
  merged: ' (fixed — checking it stays fixed)', failed: ' (the last attempt did not work)',
};

export function queueRowText(item) {
  const sev = item.severity || 'unrated';
  const title = String(item.title || item.clusterId || 'A feedback item').slice(0, 140);
  const state = EXECUTION_WORDS[item.executionState] || '';
  return `${item.rank}. [${sev}] ${title}${state}${item.summary ? ` — ${String(item.summary).slice(0, 200)}` : ''}`;
}

const EXECUTOR_REASON_WORDS = {
  ok: 'ready to work on the top items',
  'dry-run': 'in practice mode: it picks what it would work on but starts nothing',
  disabled: 'turned off',
  'no-source-repo': 'not available here (no copy of the source code on this machine)',
  'github-unavailable': 'waiting: GitHub could not be reached',
  'auto-merge-disabled': 'waiting: the repository does not allow auto-merge',
  'approver-unset': 'waiting: no approver is set for this organization repository',
  'approver-not-independent': 'waiting for you: this agent could approve its own fixes as the repository owner, so it needs your one-time PIN acceptance (or leave it off)',
  'profile-unenforceable': 'stopped: the sandbox check did not hold, so no attempts start (retried daily)',
  'deps-unavailable': 'waiting: installing the code dependencies failed (retrying)',
  'publish-fork-unset': 'waiting: no fork is set to publish fixes from (feedbackFactory.execute.publishRepo), so no new attempts start',
  'not-canonical-owner': 'runs on another machine',
  'not-checked-yet': 'not checked yet',
};

/** One plain paragraph for the executor status. */
export function executorText(status) {
  if (!status) return 'The fix worker is not available on this machine.';
  const words = EXECUTOR_REASON_WORDS[status.reason] || status.reason || 'unknown';
  const parts = [`The fix worker is ${words}.`];
  if (typeof status.live === 'number') parts.push(`${status.live} attempt(s) running, ${status.openPrs || 0} fix(es) waiting for review, ${status.startsToday || 0} started today.`);
  return parts.join(' ');
}

/** Attempts parked because some files look like they contain a secret (names only). */
export function heldSecretAttempts(status) {
  return ((status && status.attempts) || []).filter((a) => a.state === 'held' && a.reason === 'needs-review-secret-shape');
}

/**
 * Render the Triage section into `target`.
 * handlers: submitAuthority(action, pin) → note; planIgnoreLive(enabled) → plan|null; planExecutorAction(request) → plan|null;
 * commitPlan(plan, pin) → note.
 */
export function renderTriageSection(doc, target, data, handlers = {}) {
  if (!target) return;
  target.replaceChildren();
  target.appendChild(el(doc, 'h3', 'ph-h', 'Triage — what to work on, hold or set aside'));
  if (!data || !data.summary) { target.appendChild(el(doc, 'div', 'ph-detail-body', 'Triage is not live on this machine.')); return; }
  target.appendChild(el(doc, 'div', 'ph-detail-body', summaryText(data.summary)));

  // Authority card.
  const p = data.proposal;
  const card = el(doc, 'div', 'spend-arm-plan');
  card.appendChild(el(doc, 'div', 'spend-arm-plan-label', 'Who sorts feedback work items'));
  card.appendChild(el(doc, 'div', 'ph-detail-body', triageStatusLine(p)));
  if (p && p.summary) card.appendChild(el(doc, 'div', 'spend-arm-plan-text', p.summary));
  for (const b of (p && p.blockers) || []) card.appendChild(el(doc, 'div', 'spend-arm-note', b));
  const pin = el(doc, 'input', 'spend-arm-pin');
  pin.type = 'password'; pin.inputMode = 'numeric'; pin.id = 'ftPin'; pin.placeholder = 'Dashboard PIN'; pin.autocomplete = 'off';
  card.appendChild(pin);
  const note = el(doc, 'div', 'spend-arm-status');
  note.id = 'ftNote';
  note.setAttribute('aria-live', 'polite');
  const btns = el(doc, 'div', 'spend-arm-btns');
  const add = (label, run, cls) => {
    const b = el(doc, 'button', `spend-arm-btn ${cls || ''}`.trim(), label);
    b.addEventListener('click', async () => { note.textContent = 'Working…'; note.textContent = await run((pin.value || '').trim()); });
    btns.appendChild(b);
    return b;
  };
  if (p && p.approveAction && typeof handlers.submitAuthority === 'function') {
    add(p.approveAction === 'restore' ? 'Approve (restore)' : 'Approve', (v) => handlers.submitAuthority(p.approveAction, v), 'spend-arm-btn-commit').setAttribute('data-ft-action', p.approveAction);
  }
  if (p && (p.status === 'active' || p.status === 'proposal-only') && typeof handlers.submitAuthority === 'function') {
    add('Revoke', (v) => handlers.submitAuthority('revoke', v)).setAttribute('data-ft-action', 'revoke');
  }
  // Live-ignore plan/commit: render the server's exact wording, then commit with the PIN.
  if (typeof handlers.planIgnoreLive === 'function' && typeof handlers.commitPlan === 'function') {
    const enabled = !data.summary.ignoreLive;
    const planBox = el(doc, 'div', 'spend-arm-plan-text');
    add(enabled ? 'Turn ignores live…' : 'Turn ignores back to practice mode…', async () => {
      const plan = await handlers.planIgnoreLive(enabled);
      if (!plan || !plan.planId) return 'Could not prepare that change. Nothing has changed.';
      planBox.textContent = plan.renderedText;
      card.insertBefore(planBox, btns);
      const confirm = el(doc, 'button', 'spend-arm-btn spend-arm-btn-commit', 'Confirm with PIN');
      confirm.setAttribute('data-ft-action', 'commit-ignore-live');
      confirm.addEventListener('click', async () => { note.textContent = 'Working…'; note.textContent = await handlers.commitPlan(plan, (pin.value || '').trim()); });
      btns.appendChild(confirm);
      return 'Read the change above, enter your PIN, then confirm.';
    }).setAttribute('data-ft-action', 'plan-ignore-live');
  }
  card.appendChild(btns);
  card.appendChild(note);
  target.appendChild(card);

  // Executor card: its state in plain words, and the two PIN-only executor actions.
  if (data.execute !== undefined) {
    const ex = el(doc, 'div', 'spend-arm-plan');
    ex.appendChild(el(doc, 'div', 'spend-arm-plan-label', 'Fixing the top items'));
    ex.appendChild(el(doc, 'div', 'ph-detail-body', executorText(data.execute)));
    const exBtns = el(doc, 'div', 'spend-arm-btns');
    const exPlan = el(doc, 'div', 'spend-arm-plan-text');
    const offer = (label, actionKey, request) => {
      if (typeof handlers.planExecutorAction !== 'function' || typeof handlers.commitPlan !== 'function') return;
      const b = el(doc, 'button', 'spend-arm-btn', label);
      b.setAttribute('data-ft-action', `plan-${actionKey}`);
      b.addEventListener('click', async () => {
        note.textContent = 'Working…';
        const plan = await handlers.planExecutorAction(request);
        if (!plan || !plan.planId) { note.textContent = 'Could not prepare that change. Nothing has changed.'; return; }
        exPlan.textContent = plan.renderedText;
        ex.insertBefore(exPlan, exBtns);
        const confirm = el(doc, 'button', 'spend-arm-btn spend-arm-btn-commit', 'Confirm with PIN');
        confirm.setAttribute('data-ft-action', `commit-${actionKey}`);
        confirm.addEventListener('click', async () => { note.textContent = 'Working…'; note.textContent = await handlers.commitPlan(plan, (pin.value || '').trim()); });
        exBtns.appendChild(confirm);
        note.textContent = 'Read the change above, enter your PIN in the box above, then confirm.';
      });
      exBtns.appendChild(b);
    };
    if (data.execute && data.execute.reason === 'approver-not-independent') {
      offer('Let it run anyway…', 'accept-approver-dependence', { action: 'accept-approver-dependence' });
    }
    for (const attempt of heldSecretAttempts(data.execute).slice(0, 5)) {
      ex.appendChild(el(doc, 'div', 'spend-arm-note', `Held: a fix touched files that look like they hold a secret (${(attempt.secretFiles || []).slice(0, 5).join(', ')}).`));
      offer('Review and publish…', 'publish-secret-shape', { action: 'publish-secret-shape', attemptId: attempt.attemptId });
    }
    ex.appendChild(exBtns);
    target.appendChild(ex);
  }

  // Ranked queue.
  const items = (data.queue && Array.isArray(data.queue.items)) ? data.queue.items : [];
  const list = el(doc, 'div', 'ph-detail-body');
  if (items.length === 0) list.textContent = 'No feedback items are queued to work on yet.';
  for (const item of items.slice(0, 25)) list.appendChild(el(doc, 'div', null, queueRowText(item)));
  if (items.length > 25) list.appendChild(el(doc, 'div', 'spend-arm-note', `…and ${items.length - 25} more.`));
  target.appendChild(el(doc, 'div', 'spend-arm-plan-label', 'Work queue (highest first)'));
  target.appendChild(list);
}
