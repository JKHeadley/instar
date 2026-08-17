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
