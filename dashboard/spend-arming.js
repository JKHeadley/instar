/**
 * Spend tab — the paid-door arming controls (Routing Control Room, Increment B UI).
 *
 * The money layer's routes existed but had no screen, while the Spend tab told the
 * operator that caps and go-live were "a later increment". So an operator told the
 * arming was "one tap in the Spend tab, enter your PIN" went looking for a PIN box
 * that had never been built. This is that screen.
 *
 * Three things this module refuses to do, because each one caused or repeated that
 * failure:
 *
 * 1. It never claims a control is available when the server says the money layer is
 *    off. A 503 renders the REASON — that enabling it is the operator's own switch,
 *    reserved to them by design — not a generic "something went wrong".
 * 2. It never sends the PIN anywhere except the commit call. The plan/preview call
 *    is deliberately PIN-free, so the operator sees exactly what they are approving
 *    BEFORE any secret leaves the page.
 * 3. It never derives what will be committed from the form. The server renders the
 *    plan text; the commit sends back only the plan id and nonce. A field the
 *    operator never saw rendered cannot land.
 *
 * Every dynamic value is written with textContent (same contract as subscriptions.js).
 */

/** Element helper — textContent ONLY, never innerHTML. */
function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/**
 * What to tell the operator when a money-layer call fails.
 *
 * The 503 case is the one that matters. "Money controls are unavailable" would repeat
 * the original confusion — the operator would go looking for what they did wrong. The
 * money layer being off is not a fault and not something they can fix from this screen;
 * it is a switch deliberately reserved to them, and saying so is the whole point.
 */
export function moneyLayerNote(message) {
  const m = message === undefined || message === null ? '' : String(message);
  if (/503|not enabled|money layer/i.test(m)) {
    return 'Money controls are switched off on this agent. Turning them on is your decision — ' +
      'it is deliberately not something an agent or a developer can flip. Once it is on, these ' +
      'controls work; until then nothing here can arm a door.';
  }
  if (/caps store unreadable/i.test(m)) {
    return 'The caps record could not be read, so money controls are refusing to act rather ' +
      'than guess. Nothing has changed.';
  }
  if (/pin/i.test(m)) {
    return 'That PIN was not accepted. Nothing has changed.';
  }
  return 'Could not reach the money controls just now. Nothing has changed — try again.';
}

/**
 * Validate the two ceilings before asking the server for a plan.
 *
 * BOTH are required: the server takes a lifetime ceiling and a daily ceiling, and there
 * is no monthly figure to fall back on. A monthly intent has to be expressed as both, and
 * leaving one blank silently produces a very different product — a daily rate with no
 * lifetime bound is a tap left running, not a budget.
 */
export function validateCaps(input) {
  const { lifetimeCapUsd, dailyCapUsd } = input || {};
  for (const [name, label] of [['lifetimeCapUsd', 'lifetime'], ['dailyCapUsd', 'daily']]) {
    const v = (input || {})[name];
    if (v === '' || v === null || v === undefined) {
      return { ok: false, error: `Enter a ${label} ceiling — the server requires both.` };
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, error: `The ${label} ceiling must be a number.` };
    }
    if (v <= 0) {
      return { ok: false, error: `The ${label} ceiling must be greater than zero.` };
    }
  }
  if (dailyCapUsd > lifetimeCapUsd) {
    return {
      ok: false,
      error: 'The daily ceiling is above the lifetime ceiling, so the daily one could never ' +
        'bind. Lower the daily figure or raise the lifetime one.',
    };
  }
  return { ok: true };
}

/**
 * The request body for a plan preview. Deliberately a pure function so a test can prove
 * the PIN is NOT in it — a preview that carried the secret would defeat the point of
 * showing the operator what they are approving first.
 */
export function planRequest(action, fields) {
  const f = fields || {};
  if (action === 'caps-adjust') {
    return {
      action: 'caps-adjust',
      keyRef: f.keyRef,
      provider: f.provider,
      lifetimeCapUsd: f.lifetimeCapUsd,
      dailyCapUsd: f.dailyCapUsd,
    };
  }
  if (action === 'go-live') {
    return { action: 'go-live', door: f.door, keyRef: f.keyRef, enabled: f.enabled === true };
  }
  if (action === 'unfreeze') {
    return { action: 'unfreeze', keyRef: f.keyRef };
  }
  return null;
}

/**
 * The commit body. Carries ONLY the plan identity and the PIN — never the form fields.
 *
 * This is the load-bearing security shape: the server derives what to apply solely from
 * the plan it rendered, so a value the operator never saw on screen cannot be committed
 * by editing the form after previewing.
 */
export function commitRequest(plan, pin) {
  return { planId: (plan || {}).planId, nonce: (plan || {}).nonce, pin };
}

/**
 * WHICH route commits a rendered plan.
 *
 * The server has one commit route per action and each REFUSES a plan whose signed action
 * is not its own — the plan-binding discipline, working exactly as designed. The dashboard
 * posted every plan to `/routing-spend/caps/adjust`, so "Preview go live" rendered its plan
 * correctly, took the operator's PIN, and then failed with a 400 they could do nothing
 * about: arming a door — the whole point of the panel — was unreachable from the screen
 * built to do it. Found by driving the panel against a real server, not by a test; the unit
 * tests were green because none of them knew a second route existed.
 *
 * Derived from the PLAN's action, never from the button that was pressed: the server may
 * substitute a different action than the one requested, and the commit must follow what was
 * actually rendered and approved.
 */
export function commitRoute(plan) {
  const action = plan && typeof plan.action === 'string' ? plan.action : '';
  if (action === 'go-live') return '/routing-spend/go-live';
  if (action === 'unfreeze') return '/routing-spend/unfreeze';
  if (action === 'caps-adjust') return '/routing-spend/caps/adjust';
  // gemini-payg §8: the one-PIN go-live is a money-layer PRE-GATE action; its commit
  // route also schedules the restart its plan text disclosed (no second PIN).
  if (action === 'gemini-payg-setup') return '/routing-spend/money-layer/commit';
  // An unknown action gets NO route rather than a default one: posting an unrecognised plan
  // to the caps route is how this defect happened, and the server would refuse it anyway.
  return null;
}

/** Render the server's plan text for approval. The text is the server's, shown verbatim. */
export function renderPlanPreview(doc, target, plan) {
  if (!target) return;
  target.replaceChildren();
  if (!plan || !plan.renderedText) {
    target.appendChild(el(doc, 'div', 'spend-arm-note', 'No plan to approve yet.'));
    return;
  }
  target.appendChild(el(doc, 'div', 'spend-arm-plan-label', 'Approve exactly this:'));
  target.appendChild(el(doc, 'div', 'spend-arm-plan-text', plan.renderedText));
  if (plan.expiresAt) {
    target.appendChild(el(doc, 'div', 'spend-arm-plan-expiry', `This approval expires at ${plan.expiresAt}.`));
  }
}

/**
 * The per-door rows the arming panel offers.
 *
 * Only METERED (paid) doors can be armed, so subscription doors are excluded rather than
 * rendered as inert rows — an unarmable row invites the same "where do I tap?" confusion
 * this screen exists to remove.
 */
export function armableDoors(caps) {
  const keys = (caps && Array.isArray(caps.keys)) ? caps.keys : [];
  return keys
    .filter((k) => k && typeof k.keyRef === 'string' && k.keyRef.length > 0)
    .map((k) => ({
      keyRef: k.keyRef,
      provider: k.provider,
      door: k.door,
      lifetimeCapUsd: k.lifetimeCapUsd,
      monthlyCapUsd: k.monthlyCapUsd ?? null,
      committedMonthUsd: k.committedMonthUsd ?? 0,
      dailyCapUsd: k.dailyCapUsd,
      frozen: k.frozen === true,
      goLiveState: k.goLiveState,
      live: k.goLiveState === 'live',
    }));
}

/** Plain-language state for a door, so the operator can tell armed from not-armed. */
export function doorStateWords(row) {
  if (!row) return '';
  if (row.frozen) return 'Frozen — spending is halted';
  if (row.live) return 'Live — this door can spend';
  return 'Not live — this door cannot spend';
}

/**
 * The monthly row for a pay-per-use door (gemini-payg §7). Plain words from the server's
 * figures; null when the door has no monthly cap. 50% and 80% are SHOWN here and never
 * pushed (Near-Silent): spending within the authorization needs no action.
 */
export function monthlyRowWords(caps) {
  const g = caps && caps.geminiPayg;
  if (!g || !g.month || typeof g.month.capUsd !== 'number') return null;
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;
  const lines = [];
  const where = caps.proxiedFrom ? ` (read from ${caps.proxiedFrom}${typeof caps.ageMs === 'number' ? `, ${Math.round(caps.ageMs / 1000)}s ago` : ''})` : '';
  lines.push(`Gemini this month: ${money(g.month.committedUsd)} of ${money(g.month.capUsd)} (${g.month.pct}%)${where}.`);
  if (g.thresholds && g.thresholds.reached100) lines.push('The monthly limit is reached — Gemini has stopped spending until the month resets.');
  else if (g.thresholds && g.thresholds.reached80) lines.push('Over 80% of the month is used.');
  else if (g.thresholds && g.thresholds.reached50) lines.push('Over half of the month is used.');
  if (g.day && typeof g.day.guardUsd === 'number') lines.push(`Today: ${money(g.day.committedUsd)} of ${money(g.day.guardUsd)}.`);
  if (g.e2 && typeof g.e2.shareCapUsd === 'number') lines.push(`Second opinions this month: ${money(g.e2.monthUsd)} of ${money(g.e2.shareCapUsd)}.`);
  if (g.provisionalMonthUsd > 0) lines.push(`Uncertain charges this month: ${money(g.provisionalMonthUsd)}${typeof g.provisionalCeilingUsd === 'number' ? ` of ${money(g.provisionalCeilingUsd)}` : ''}.`);
  lines.push(g.releaseState === 'live' ? 'The door is live.' : g.releaseState === 'armed-pending-proof' ? 'The door is set up and waiting for its proof call.' : 'The door is not set up.');
  if (caps.holderUnreachable) lines.push('The spending machine could not be reached; these are the last known figures.');
  return lines;
}

/**
 * The Gemini pay-per-use setup plan (gemini-payg §8 "Delivery": the card links to this
 * Spend-tab plan view).
 *
 * The lane shipped a card that pointed at the Spend tab, a server that renders and
 * commits the `gemini-payg-setup` plan, and a commit route that schedules its own
 * restart — but no screen that showed the plan or took the PIN for it. Found by the
 * user-role live test driving the real dashboard. These helpers are that screen's
 * pure parts; the server's words are shown verbatim and nothing is derived from a form.
 */

/** Whether the Spend tab shows the setup plan: a proposal exists here and no door is set up yet. */
export function geminiSetupShouldRender(proposal, release) {
  if (!proposal || proposal.present !== true) return false;
  const st = release && release.here === true && release.evaluation ? release.evaluation.releaseState : 'not-armed';
  return st === 'not-armed';
}

/**
 * The commit body for the setup plan: the plan identity, the PIN and the proposal hash the
 * plan was rendered from (so a proposal changed after rendering is refused by the server
 * with "the proposal changed; a new card is needed"). Never a form field.
 */
export function geminiSetupCommitRequest(plan, pin) {
  const p = plan || {};
  return { planId: p.planId, nonce: p.nonce, pin, ...(typeof p.proposalHash === 'string' ? { proposalHash: p.proposalHash } : {}) };
}

/**
 * Render the setup plan. The FIRST line of the server's text is the first-screen line
 * ("Gemini joins as a reviewer and a second opinion. …") and is shown as the panel's
 * lead, above everything else; the full text follows verbatim.
 */
export function renderGeminiSetupPlan(doc, target, plan) {
  if (!target) return;
  target.replaceChildren();
  if (!plan || !plan.renderedText) {
    target.appendChild(el(doc, 'div', 'spend-arm-note', 'No Gemini setup to approve yet.'));
    return;
  }
  const lines = String(plan.renderedText).split('\n');
  target.appendChild(el(doc, 'div', 'gp-setup-lead', lines[0]));
  target.appendChild(el(doc, 'div', 'spend-arm-plan-label', 'Approve exactly this:'));
  target.appendChild(el(doc, 'div', 'spend-arm-plan-text', lines.slice(1).join('\n').replace(/^\n+/, '')));
  if (plan.expiresAt) {
    target.appendChild(el(doc, 'div', 'spend-arm-plan-expiry', `This approval expires at ${plan.expiresAt}.`));
  }
}

/**
 * What the operator reads after the setup commit. The commit itself schedules the
 * restart its plan disclosed, so the next step is never a second PIN: either the server
 * is restarting, or the server says why it did not and when it applies.
 */
export function geminiSetupAfterCommit(out) {
  const o = out || {};
  if (o.restart && o.restart.scheduled === true) {
    return { state: 'restarting', words: 'Approved. The agent server on this machine is restarting to apply it — no second PIN is needed. This page reloads when it is back.' };
  }
  if (o.appliedHot === true) return { state: 'done', words: o.message ? String(o.message) : 'Approved and applied.' };
  return { state: 'saved', words: o.message ? String(o.message) : 'Approved and saved.' };
}

/**
 * Plain words for a refused render or commit. Never shows a raw server code, and never
 * says "nothing has changed" when that cannot be known (a commit whose answer was lost,
 * or a plan another approval used up).
 */
export function geminiSetupRefusalWords(err, opts = {}) {
  const m = err && err.message ? String(err.message) : '';
  if (/proposal-changed/.test(m)) return 'The proposal changed after this was shown, so a new card is needed. Nothing was approved.';
  if (/awaiting-key/.test(m)) return 'The Gemini key is not ready on this machine yet, so there is nothing to approve. Nothing has changed.';
  if (/lockout|429|rate/i.test(m)) return 'Too many attempts just now. Wait a few minutes, then reload the Spend tab and try again.';
  if (/pin/i.test(m)) return 'That PIN was not accepted. Nothing has changed.';
  // The plan was used up, or the state moved under it, by another approval (a second
  // tap, another device — the server answers `consumed`/`unknown-plan`, or
  // `source-state-drift` for a second tab's own plan). Saying "nothing has changed" here
  // would be wrong: the other approval may have applied it. Found racing two dashboard
  // tabs in the user-role live test.
  if (/consumed|unknown-plan|nonce|drift/i.test(m)) return 'This plan was already used — it may have just been approved from another tap or device. Reload the Spend tab to see where it stands.';
  if (opts.duringCommit) return 'The approval could not be confirmed (the server did not answer clearly). Reload the Spend tab to see where it stands before trying again.';
  return 'This could not be shown just now. Nothing has changed — reload the Spend tab to try again.';
}
