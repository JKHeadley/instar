/**
 * Feedback Drain tab — the operator's approve/revoke card for the readiness authority
 * (docs/specs/feedback-factory-operating-drain.md §2, "operator-rooted").
 *
 * The drain refuses every tick until an operator registers which model may decide
 * which feedback reports become work items. That registration was PIN-only with no
 * screen. This card is the screen: the server computes every technical field
 * (GET /feedback-factory/readiness-authorities/proposal); the operator sees one plain
 * sentence, may adjust the batch size and daily cap, and approves with the PIN.
 * The POST sends `useProposal: true`, so the server — not this page — fills in the
 * binding fields. Every dynamic value is written with textContent, never innerHTML.
 */

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** One line on where the authority stands, in the operator's words. */
export function statusLine(p) {
  const s = (p && p.status) || 'none';
  const cur = (p && p.current) || null;
  if (s === 'none') return 'Not set up yet — the feedback drain is waiting for your approval before it sorts anything.';
  if (s === 'revoked') return `Revoked (version ${cur ? cur.generation : '?'}). The drain is not sorting feedback.`;
  if (s === 'proposal-only') {
    return `Paused by a safety brake (version ${cur ? cur.generation : '?'}) — for example the daily cap was reached or the model answer did not check out. Approve again to resume.`;
  }
  if (cur && cur.matchesProposal === false) {
    return `Active (version ${cur.generation}), but out of date for this machine — approve to update it.`;
  }
  return `Active (version ${cur ? cur.generation : '?'}): up to ${cur ? cur.maxBatch : '?'} reports per batch, at most $${cur ? cur.maxDailySpendUsd : '?'} per day.`;
}

/** A unique, bounded reference recorded in the authority's audit chain. */
export function newDecisionRef(now = new Date(), rand = Math.random) {
  const suffix = Math.floor(rand() * 0xffffffff).toString(16).padStart(8, '0');
  return `dashboard:${now.toISOString().replace(/[^0-9A-Za-z]/g, '')}:${suffix}`;
}

/** The POST body for an approve (create/replace/restore) or revoke. */
export function authorityRequest(action, envelope, pin, operatorDecisionRef) {
  const body = { action, pin, operatorDecisionRef };
  if (action === 'create' || action === 'replace') {
    body.useProposal = true;
    // An emptied field means "use the default", never 0.
    for (const k of ['maxBatch', 'maxTokens', 'maxDailySpendUsd']) {
      const v = String(envelope[k] ?? '').trim();
      if (v !== '') body[k] = Number(v);
    }
  }
  return body;
}

/** What to show after the server answers a mutation. */
export function resultNote(ok, data) {
  if (ok) {
    return data && data.revoked
      ? `Revoked. The drain stops sorting feedback from its next run (version ${data.generation}).`
      : `Approved (version ${data ? data.generation : '?'}). The next drain run will start sorting feedback.`;
  }
  const m = String((data && data.error) || '');
  if (/incorrect pin|pin required/i.test(m)) return 'That PIN was not accepted. Nothing has changed.';
  if (/too many/i.test(m)) return 'Too many PIN attempts — wait a few minutes. Nothing has changed.';
  return `Not applied: ${m || 'the server refused'}. Nothing has changed.`;
}

function numberField(doc, label, id, value, hint) {
  const wrap = el(doc, 'label', 'spend-arm-field');
  wrap.appendChild(el(doc, 'span', null, label));
  const input = el(doc, 'input', 'spend-arm-input');
  input.type = 'number';
  input.inputMode = 'decimal';
  input.id = id;
  input.value = String(value);
  wrap.appendChild(input);
  if (hint) wrap.appendChild(el(doc, 'span', 'spend-arm-hint', hint));
  return { wrap, input };
}

/**
 * Render the card into `target`. `handlers.submit(action, envelope, pin)` performs the
 * POST and resolves to a note string; `handlers.preview(envelope)` re-reads the proposal
 * so the plain sentence follows the operator's edits.
 */
export function renderAuthorityCard(doc, target, p, handlers = {}) {
  if (!target) return;
  target.replaceChildren();
  target.appendChild(el(doc, 'h3', 'ph-h', 'Who decides which feedback becomes work'));
  target.appendChild(el(doc, 'div', 'ph-detail-body', statusLine(p)));
  if (!p) return;

  const env = (p.proposal) || { maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5 };
  const summary = el(doc, 'div', 'spend-arm-plan-text', p.summary || '');
  target.appendChild(summary);
  for (const b of p.blockers || []) target.appendChild(el(doc, 'div', 'spend-arm-note', b));

  const batch = numberField(doc, 'Reports per batch', 'fraMaxBatch', env.maxBatch, '1 to 50');
  const spend = numberField(doc, 'Daily spend cap (USD)', 'fraMaxDailySpendUsd', env.maxDailySpendUsd, 'The drain stops for the day at this amount.');
  const tokens = numberField(doc, 'Answer length limit (tokens)', 'fraMaxTokens', env.maxTokens, 'Leave as is unless asked.');
  const details = el(doc, 'details', 'ph-detail');
  details.appendChild(el(doc, 'summary', 'ph-detail-summary', 'Adjust limits'));
  for (const f of [batch, spend, tokens]) details.appendChild(f.wrap);
  if (p.proposal) {
    details.appendChild(el(doc, 'div', 'spend-arm-hint',
      `Bound to: agent ${p.proposal.agentId}; machine ${p.proposal.ownerMachineId} (epoch ${p.proposal.ownerEpoch}); ` +
      `model ${p.proposal.modelFamily} via ${p.proposal.provider}.`));
  }
  target.appendChild(details);
  const envelope = () => ({ maxBatch: batch.input.value, maxTokens: tokens.input.value, maxDailySpendUsd: spend.input.value });
  if (typeof handlers.preview === 'function') {
    for (const f of [batch, spend, tokens]) {
      f.input.addEventListener('change', async () => {
        const next = await handlers.preview(envelope());
        if (next) {
          summary.textContent = next.summary || '';
        }
      });
    }
  }

  const pin = el(doc, 'input', 'spend-arm-pin');
  pin.type = 'password';
  pin.inputMode = 'numeric';
  pin.id = 'fraPin';
  pin.placeholder = 'Dashboard PIN';
  pin.autocomplete = 'off';
  target.appendChild(pin);

  const note = el(doc, 'div', 'spend-arm-status');
  note.id = 'fraNote';
  note.setAttribute('aria-live', 'polite');
  const btns = el(doc, 'div', 'spend-arm-btns');
  const add = (label, action, cls) => {
    const b = el(doc, 'button', `spend-arm-btn ${cls || ''}`.trim(), label);
    b.setAttribute('data-fra-action', action);
    b.addEventListener('click', async () => {
      if (typeof handlers.submit !== 'function') return;
      note.textContent = 'Working…';
      note.textContent = await handlers.submit(action, envelope(), (pin.value || '').trim());
    });
    btns.appendChild(b);
  };
  if (p.approveAction === 'restore') {
    target.appendChild(el(doc, 'div', 'spend-arm-note', 'Restore brings back the last approved limits. To change them, restore first, then save new limits.'));
    add('Approve (restore)', 'restore', 'spend-arm-btn-commit');
  }
  else if (p.approveAction) add('Approve', p.approveAction, 'spend-arm-btn-commit');
  // Already active and current: the only thing left to approve is a change of limits.
  else if (p.status === 'active' && (p.blockers || []).length === 0) add('Save new limits', 'replace', 'spend-arm-btn-commit');
  if (p.status === 'active' || p.status === 'proposal-only') add('Revoke', 'revoke');
  target.appendChild(btns);
  target.appendChild(note);
}
