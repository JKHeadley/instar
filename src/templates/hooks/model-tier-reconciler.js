#!/usr/bin/env node
// Model-Tier Reconciler — UserPromptSubmit hook.
//
// FABLE-MODEL-ESCALATION-SPEC sections 5.3(1)/5.4/5.5/6: computes the desired
// tier from durable signals and, ONLY on a transition, asks the server-side
// swap endpoint to act. It never performs a swap itself, never blocks the
// turn, and emits no prompt context. The common path is PURE FILESYSTEM with
// an early-exit no-op when desired == last-applied (no HTTP, no tmux).
// Fail-closed: anything missing or unparseable exits 0 and the session stays
// on its default model.
//
// NOTE: dynamic import('node:...') so this works under both CJS and ESM
// hosts (the hook-event-reporter lesson).

const sid = process.env.INSTAR_SESSION_ID || '';
const sessionName = process.env.INSTAR_SESSION_NAME || '';
const serverUrl = process.env.INSTAR_SERVER_URL || '';
const authToken = process.env.INSTAR_AUTH_TOKEN || '';
if (!sid || !sessionName || !serverUrl || !authToken) process.exit(0);

(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
  const instarDir = path.join(projectDir, '.instar');
  const stateDir = path.join(instarDir, 'state', 'model-tier-escalation');
  const modeFile = path.join(stateDir, 'mode-state-' + sid + '.json');
  const markerFile = path.join(stateDir, 'last-applied-' + sid + '.json');

  const readJson = (p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
  };

  const cfgAll = readJson(path.join(instarDir, 'config.json'));
  const te = (cfgAll && cfgAll.models && cfgAll.models.tierEscalation) || null;
  if (!te || te.enabled !== true) process.exit(0);
  const guards = te.costGuards || {};
  const ttlMs = typeof guards.maxEscalationTtlMs === 'number' ? guards.maxEscalationTtlMs : 21600000;
  const dwellMs = typeof guards.minTierDwellMs === 'number' ? guards.minTierDwellMs : 300000;
  const dwellTurns = typeof guards.minTierDwellTurns === 'number' ? guards.minTierDwellTurns : 1;

  // Desired tier — re-derived LIVE each turn from the durable signal (never
  // a persisted "escalated" flag that must be cleared). The mode-state is
  // self-expiring on read (spec 5.5): past TTL it is QUARANTINED (renamed),
  // so re-escalation needs a FRESH trigger, not a clock reset.
  let desired = 'default';
  const mode = readJson(modeFile);
  if (mode && mode.instanceId === sid && mode.tier === 'escalated') {
    const since = Date.parse(mode.since || '');
    if (Number.isFinite(since) && Date.now() - since < ttlMs) {
      desired = 'escalated';
    } else {
      try { fs.renameSync(modeFile, modeFile + '.expired'); } catch { /* already gone */ }
      // One audit breadcrumb — a TTL firing means the primary path failed.
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.appendFileSync(
          path.join(stateDir, 'audit.jsonl'),
          JSON.stringify({ ts: new Date().toISOString(), source: 'reconciler', type: 'ttl-expired', instanceId: sid }) + '\n',
        );
      } catch { /* best-effort */ }
    }
  }

  const marker = readJson(markerFile) || { tier: 'default', at: 0, turnsClear: 0 };

  // FAST PATH (spec section 6): desired == last applied. Pure read, zero
  // writes, no HTTP. (A stale turnsClear can survive an interrupted
  // de-escalation streak; worst case is a de-escalation one turn early,
  // still bounded by dwellMs here AND by the server-side dwell backstop.)
  if (marker.tier === desired) process.exit(0);

  const writeMarker = (m) => {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = markerFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(m));
      fs.renameSync(tmp, markerFile);
    } catch { /* a lost marker only costs one redundant no-op POST */ }
  };

  // Asymmetric hysteresis (spec 5.5): escalate immediately; de-escalate only
  // after the condition has been clear for dwellTurns consecutive turns AND
  // dwellMs since the last swap. Suppressed flaps leave the marker counting.
  if (desired === 'default') {
    const turnsClear = (marker.turnsClear || 0) + 1;
    if (turnsClear < dwellTurns || (marker.at && Date.now() - marker.at < dwellMs)) {
      writeMarker({ ...marker, turnsClear });
      process.exit(0);
    }
  }

  // Stable-refusal cooldown: 'disabled' / 'launch-time-only-framework' can't
  // change turn-to-turn — don't hammer the endpoint for 10 minutes.
  if (
    marker.refusedReason &&
    marker.refusedDesired === desired &&
    Date.now() - (marker.refusedAt || 0) < 600000
  ) {
    process.exit(0);
  }

  // TRANSITION: ask the server — the single swap authority. Bounded (4s);
  // any failure leaves the marker untouched, so the next idle boundary
  // retries. The reconciler reconciles against the OBSERVED outcome
  // ('swapped' = canary-confirmed), never its own write-intent.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      serverUrl + '/sessions/' + encodeURIComponent(sessionName) + '/model-swap',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
        body: JSON.stringify({ tier: desired }),
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    const body = await res.json().catch(() => ({}));
    const status = body && body.status;
    if (status === 'swapped' || status === 'dry-run' || status === 'noop') {
      // 'swapped': independent oracle confirmed. 'dry-run'/'noop': nothing
      // will change for this tier — marking prevents per-turn re-POSTs while
      // keeping exactly one audit line per transition.
      writeMarker({ tier: desired, at: Date.now(), turnsClear: 0 });
    } else if (
      status === 'refused' &&
      (body.reason === 'disabled' || body.reason === 'launch-time-only-framework')
    ) {
      writeMarker({ ...marker, refusedReason: body.reason, refusedDesired: desired, refusedAt: Date.now() });
    }
    // 'unconfirmed' and transient refusals (not-idle / dwell / cost-guard):
    // do NOT mark reconciled (spec 5.3) — behaviourally default; retry later.
  } catch { /* never blocks the turn */ }
  process.exit(0);
})();
