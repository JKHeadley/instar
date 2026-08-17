/**
 * Spend tab — the operator's ON SWITCH for the spending-control layer (Phase 2 UI for
 * docs/specs/money-layer-operator-enable-surface.md).
 *
 * Phase 1 built six pre-gate routes and no screen. The operator's report was the same
 * sentence twice: *"still has no path/mechanism to enable any options."* The arming
 * controls next to this panel sit BEHIND this switch, so until there is a button here,
 * every one of them answers 503 and the tab reads as broken rather than as off.
 *
 * Four things this module refuses to do, because each one would re-create a failure the
 * spec is built around:
 *
 * 1. It never says "spending works". Enabling arms NO door — every paid door stays
 *    refused at $0 until it is separately armed. The copy says "spending controls are up
 *    and enforcing" and nothing stronger.
 * 2. It never claims enabling took effect immediately. The layer is CONSTRUCTED at server
 *    start, so a commit answers `enable-pending-restart` and this panel says so and offers
 *    the restart, rather than showing a switch that reads on over machinery that is down.
 * 3. It never paraphrases the server's words. The plan text and the restart confirmation
 *    text are displayed VERBATIM — a client that paraphrased could show a reassuring label
 *    over a different signed action.
 * 4. It never presents a store-only disable as "stopped". When the config file is what
 *    enables the layer, clearing the operator flag does NOT stop spending, and this panel
 *    leads with freeze instead of a disable that would quietly do nothing.
 *
 * A lifecycle enum value is never rendered — the operator sees copy derived from
 * `enforcementReady` and `enableSources`, never `probed` or `enable-pending-restart` raw.
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
 * What to tell the operator when a pre-gate call fails.
 *
 * These six routes answer 200 while the layer is OFF — that is their whole purpose — so a
 * 503 here means something quite different from a 503 on the arming controls: the enable
 * SURFACE itself did not construct. Saying "your switch is off" there would send the
 * operator to flip a switch that is not the problem.
 */
export function enableNote(message) {
  const m = message === undefined || message === null ? '' : String(message);
  if (/bad-pin|pin/i.test(m)) {
    return 'That PIN was not accepted. Nothing has changed.';
  }
  if (/lock-not-held/i.test(m)) {
    return 'Another copy of the agent server owns this machine right now, so this one will ' +
      'not act on money settings. Nothing has changed.';
  }
  if (/stale-nonce|confirmation-hash-mismatch|expired/i.test(m)) {
    return 'That approval went stale before it was used. Nothing has changed — start it again.';
  }
  if (/nothing-to-mirror/i.test(m)) {
    return 'There is nothing to copy — the config file is not switching this on.';
  }
  if (/rate|too many/i.test(m)) {
    return 'That was too soon after the last attempt. Nothing has changed — wait a moment ' +
      'and try again.';
  }
  if (/503|surface-unavailable|surface-error/i.test(m)) {
    return 'The spending-control settings could not be read on this machine, so nothing here ' +
      'will act rather than guess. Nothing has changed.';
  }
  return 'Could not reach the spending-control settings just now. Nothing has changed — try again.';
}

/**
 * The headline state, in the operator's words.
 *
 * `enforcementReady` is the ONE fact that means the controls are live; everything else is
 * a reason they are not. The three off-reasons are kept distinct because the remedy
 * differs: off (turn it on), asked-for-but-not-built (restart), and built-but-refusing
 * (restart, and say which part refused).
 */
export function enableHeadline(status) {
  const s = status || {};
  if (s.enforcementReady === true) {
    return {
      state: 'enforcing',
      headline: 'Spending controls are up and enforcing',
      // The one sentence that stops "on" being read as "spend works".
      detail: 'Turning them on arms nothing by itself — every paid service stays refused, at $0, ' +
        'until you arm it below.',
    };
  }
  const lifecycle = typeof s.lifecycleState === 'string' ? s.lifecycleState : '';
  if (lifecycle === 'enable-pending-restart') {
    return {
      state: 'pending-restart',
      headline: 'Switched on — waiting for a restart to take effect',
      detail: 'The spending controls are built when the agent server starts, so they are not ' +
        'enforcing yet. Restarting this machine’s agent server finishes it.',
    };
  }
  if (lifecycle === 'construction-failed' || lifecycle === 'probe-failed') {
    const part = typeof s.failingComponent === 'string' && s.failingComponent ? s.failingComponent : '';
    return {
      state: 'failed',
      headline: 'Switched on, but the controls are NOT enforcing',
      detail: (part ? `The part that refused is: ${part}. ` : '') +
        'Nothing can spend in this state — the paid path refuses when the controls are not up. ' +
        'A restart of this machine’s agent server is the remedy.',
    };
  }
  return {
    state: 'off',
    headline: 'Spending controls are off',
    detail: 'While they are off, the caps and go-live controls below cannot act. Turning them ' +
      'on is your decision — it is deliberately not something an agent can flip.',
  };
}

/**
 * The notice for an enable that came from the CONFIG FILE rather than from this screen.
 *
 * This is the trap in the whole feature: pressing "turn off" here clears the operator flag
 * only. No route writes the config file, so with `config-enabled` the layer stays on and a
 * disable that looked successful would not have stopped anything. Freeze is the control
 * that actually halts money, so the notice leads with it.
 */
export function configSourceNotice(status) {
  const state = (status && status.enableSources && status.enableSources.state) || '';
  if (state === 'config-enabled') {
    return 'This is switched on by the config file on this machine, not from here. Turning it ' +
      'off here clears only my setting — it will NOT stop spending. To stop spending now, ' +
      'freeze the door below; freezing is instant and always available.';
  }
  if (state === 'both-enabled') {
    return 'This is switched on both here and in the config file on this machine. Turning it ' +
      'off here clears only my setting; the config file would keep it on.';
  }
  return null;
}

/**
 * Which actions this state genuinely offers. Buttons are derived from state rather than
 * always rendered and conditionally refused — an inert button is the same "where do I tap?"
 * failure this screen exists to remove.
 */
export function availableActions(status) {
  const s = status || {};
  const sources = s.enableSources || {};
  const out = [];
  if (s.enforcementReady !== true) {
    // Offered in EVERY not-enforcing state, including one already switched on: "switch says
    // on, machinery down" is exactly the state this control exists to rescue, so re-pressing
    // it must re-verify rather than be treated as a no-op.
    out.push({ action: 'money-layer-enable', label: sources.store === true ? 'Re-check and turn on' : 'Turn on spending controls' });
  }
  if (sources.config === true && sources.store !== true) {
    out.push({ action: 'money-layer-mirror-config', label: 'Also record it here' });
  }
  if (sources.store === true) {
    out.push({ action: 'money-layer-disable', label: 'Turn off' });
  }
  if (s.restartEligible === true) {
    out.push({ action: '__restart', label: 'Restart the agent server' });
  }
  return out;
}

/** The plan request. Bearer-only and deliberately PIN-free: the operator must see the
 *  server's words BEFORE any secret leaves the page. */
export function planRequest(action) {
  return { action };
}

/** The commit body — the plan identity plus the PIN, never a form field. The server
 *  derives what to apply solely from the plan it rendered. */
export function commitRequest(plan, pin) {
  return { planId: (plan || {}).planId, nonce: (plan || {}).nonce, pin };
}

/** The restart body. The hash binds the restart to the exact confirmation text that was
 *  DISPLAYED, so a restart cannot be approved against words the operator never saw. */
export function restartRequest(nonce, confirmationTextHash, pin) {
  return { nonce, confirmationTextHash, pin };
}

/**
 * SHA-256 of the confirmation text, hex.
 *
 * The server mints the text and its hash but returns only the TEXT, so the client hashes
 * what it displayed — that is what makes the binding meaningful. `crypto.subtle` exists on
 * https and on localhost; over plain http to a LAN address it does not, and the honest
 * answer there is to say the restart cannot be approved from this page rather than to
 * silently send an unbound request.
 */
export async function sha256Hex(text) {
  const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;
  if (!subtle) {
    throw new Error('secure-context-required');
  }
  const bytes = new TextEncoder().encode(String(text));
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Render the server's plan text for approval — verbatim, never paraphrased. */
export function renderPlanApproval(doc, target, plan) {
  if (!target) return;
  target.replaceChildren();
  if (!plan || !plan.renderedText) {
    target.appendChild(el(doc, 'div', 'spend-arm-note', 'Nothing to approve yet.'));
    return;
  }
  target.appendChild(el(doc, 'div', 'spend-arm-plan-label', 'Approve exactly this:'));
  target.appendChild(el(doc, 'div', 'spend-arm-plan-text', plan.renderedText));
  if (plan.expiresAt) {
    target.appendChild(el(doc, 'div', 'spend-arm-plan-expiry', `This approval expires at ${plan.expiresAt}.`));
  }
}

/**
 * Render the restart confirmation — the server's words, verbatim, plus the one fact the
 * server's text cannot know the operator is missing: this restarts the WHOLE agent server
 * on this machine, not just the spending controls.
 */
export function renderRestartConfirmation(doc, target, mint) {
  if (!target) return;
  target.replaceChildren();
  if (!mint || !mint.confirmationText) {
    target.appendChild(el(doc, 'div', 'spend-arm-note', 'Nothing to approve yet.'));
    return;
  }
  target.appendChild(el(doc, 'div', 'spend-arm-plan-label', 'Approve exactly this:'));
  target.appendChild(el(doc, 'div', 'spend-arm-plan-text', mint.confirmationText));
  target.appendChild(el(doc, 'div', 'spend-arm-note',
    'This restarts the whole agent server on this machine, not only the spending controls. ' +
    'It comes back on its own; anything mid-flight is interrupted.'));
  if (mint.expiresAt) {
    target.appendChild(el(doc, 'div', 'spend-arm-plan-expiry', `This approval expires at ${mint.expiresAt}.`));
  }
}

/**
 * What a commit's own words mean for what happens next. The server's `message` is shown
 * as-is; this decides whether the RESTART step is now the operator's next move.
 */
export function nextStepAfterCommit(result) {
  const r = result || {};
  // ORDER IS LOAD-BEARING. A store-only disable under a config enable comes back with
  // `enforcementReady: true` — the layer really is still enforcing, because clearing the
  // operator flag did not stop it. Checking `enforcementReady` first would report that
  // outcome as 'done', which is precisely the "I disabled it and it is still on" reading
  // the whole surface exists to make legible. What the operator DID is decided first.
  if (r.storeCleared === true) {
    const sources = r.enableSources || {};
    return sources.config === true ? 'still-enabled-by-config' : 'done';
  }
  if (r.enforcementReady === true) return 'done';
  return 'restart';
}

/** Render the state block. `target` is replaced. */
export function renderEnablePanel(doc, target, status, opts = {}) {
  if (!target) return;
  target.replaceChildren();
  if (!status) {
    target.appendChild(el(doc, 'div', 'spend-arm-note',
      'Could not read whether the spending controls are on. Nothing has changed.'));
    return;
  }
  const head = enableHeadline(status);
  const box = el(doc, 'div', `mle-state mle-state-${head.state}`);
  box.appendChild(el(doc, 'div', 'mle-headline', head.headline));
  box.appendChild(el(doc, 'div', 'mle-detail', head.detail));
  const notice = configSourceNotice(status);
  if (notice) box.appendChild(el(doc, 'div', 'mle-config-notice', notice));
  if (status.anyKeyFrozen === true) {
    box.appendChild(el(doc, 'div', 'mle-detail', 'At least one door is frozen — that door cannot spend.'));
  }
  if (status.machineNickname) {
    box.appendChild(el(doc, 'div', 'mle-machine', `These controls belong to ${status.machineNickname}.`));
  }
  target.appendChild(box);

  const btns = el(doc, 'div', 'mle-actions');
  for (const a of availableActions(status)) {
    const b = el(doc, 'button', 'spend-arm-btn', a.label);
    b.setAttribute('data-mle-action', a.action);
    if (typeof opts.onAction === 'function') b.addEventListener('click', () => opts.onAction(a.action));
    btns.appendChild(b);
  }
  target.appendChild(btns);
}
