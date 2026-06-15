# Side-Effects Review — Slack Subsystem Error Containment (Robustness Net #1)

**Version / slug:** `slack-subsystem-error-containment`
**Date:** `2026-06-15`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `required (touches the uncaughtException recovery path + a self-heal "reconnect" trigger)`

## Summary of the change

Contains Slack WebSocket subsystem errors so a non-OPEN socket send can never crash
the whole agent process (Robustness Net #1; defense-in-depth behind nets #2/#3).
Three source files:

- `src/messaging/slack/SocketModeClient.ts` — adds one private funnel
  `_safeSend(data, context, reconnectOnFailure = false)` and routes all four socket
  sends through it (`queueOutbound`, the ACK send, the heartbeat liveness probe,
  `_drainQueue`). The funnel reads `this.ws` once, sends only on an OPEN socket inside
  a `try/catch`, returns a boolean, and (liveness path only) triggers the existing
  `_forceReconnect()` — guarded by `this.started && !this.reconnecting && this.ws === sock`.
- `src/core/uncaughtExceptionPolicy.ts` — extracts `handleProcessLevelError(err, label,
  opts)` (the crash-vs-continue decision both process handlers share) and adds ONE
  anchored allowlist entry `'WebSocket is not open'` (the Node 22+ built-in message
  form of the already-allowlisted non-OPEN-send race).
- `src/commands/server.ts` — rewrites the existing `uncaughtException` handler to
  delegate to `handleProcessLevelError`, and adds a `process.on('unhandledRejection')`
  handler delegating to the same function (closes the async `.then`-chain gap — the
  `'message'` listener's escaping throw is a *rejection*, not a sync exception).

Decision points: the process-level crash-vs-continue authority (modified — extracted +
one narrow allowlist addition + a second event type) and a per-socket self-heal signal
(added — `_safeSend`'s liveness-path reconnect, no blocking authority).

## Decision-point inventory

- `uncaughtExceptionPolicy.isNonFatalUncaught` (the fail-toward-crash allowlist) —
  **modify** — adds one anchored substring `'WebSocket is not open'`; default stays
  crash-on-unknown.
- `process.on('uncaughtException')` handler (server.ts) — **modify** — body extracted
  into `handleProcessLevelError`; behavior preserved byte-for-byte in policy.
- `process.on('unhandledRejection')` handler (server.ts) — **add** — same authority,
  same default-crash, via the same shared function.
- `SocketModeClient._safeSend` liveness-path `_forceReconnect()` — **add** — a
  self-heal signal at the subsystem boundary; no cross-subsystem blocking authority.
- The four `.send()` callsites — **modify (pass-through)** — routed through `_safeSend`;
  no new decision logic.

---

## 1. Over-block

**What legitimate inputs does this reject that it shouldn't?**

`_safeSend` only changes behavior on the *unhappy* path. On an OPEN socket it sends
exactly as before; the only "rejection" is a send on a non-OPEN socket, which today
either throws (the bug) or is already guarded. No legitimate Slack message is dropped
on a healthy socket. The one nuance: `queueOutbound` on a non-OPEN socket now *enqueues*
the message (previously it also enqueued, but an OPEN-but-racing send could throw) — so
this is strictly fewer drops, not more.

The allowlist addition is the one over-broadening risk: `'WebSocket is not open'` is
anchored precisely so it does NOT match the live user-facing strings `"<name> is not
open for public registration"` (TelegramAdapter/AuthGate) or `"database connection is
not open"` (SqliteRegistry's already-closed-handle message). A negative unit test pins
that those do NOT match `isNonFatalUncaught`.

---

## 2. Under-block

**What failure modes does this still miss?**

- The process-level backstop is brittle-substring by nature: a future Node/`ws` version
  could change `"WebSocket is not open: readyState N"` and silently disable the
  allowlist match. Mitigated by the `_safeSend` funnel + grep ratchet being the PRIMARY
  guarantee (the backstop only ever sees *un-funneled* escapes), plus a source comment
  citing the Node origin of the string.
- A genuinely-wedged reconnect (e.g. `reconnecting` stuck true) would leave the process
  alive but Slack-silent — neither net #2 nor #3 observes subsystem-level degradation
  (both are process-existence triggers). The 30s heartbeat's `readyState != OPEN →
  _forceReconnect` is the recovery bound; `consecutiveErrors` + `onError` are the
  visible signal. This is an accepted, documented trade (Slack is non-load-bearing).

---

## 3. Level-of-abstraction fit

`_safeSend` is a **low-level structural validator** at a hard invariant (a socket must
be OPEN to send) — not a judgment call — so it correctly does not route to an LLM
authority. It produces a boolean signal and self-heals via the *existing*
`_forceReconnect`/`_backoffReconnect` path; it does not re-implement reconnect logic.
The crash-vs-continue **authority** stays exactly where it belongs:
`uncaughtExceptionPolicy`. The change does not add a parallel authority — it extends the
one that exists (one new event type, one narrow allowlist entry) and funnels the new
`unhandledRejection` handler into it so the two can't diverge.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — `_safeSend` produces a signal (boolean + self-heal) consumed by the existing
  reconnect machinery; it holds no cross-subsystem blocking authority.
- [x] Yes, smart-gate-equivalent — the process-level allowlist is the canonical,
  deliberately-narrow, audited authority and stays default-crash. The new
  `unhandledRejection` handler reuses the *identical* `isNonFatalUncaught` predicate; it
  does NOT introduce a second, looser policy.

`_safeSend`'s readyState check is a deterministic hard-invariant validator (OPEN or not),
the documented exception class for structural validators — not a brittle content
heuristic holding block authority. No brittle-detector-with-authority is introduced.

---

## 5. Interactions

- **Shadowing:** `_safeSend` replaces the inline ACK guard and the heartbeat try/catch —
  same behavior, relocated. The heartbeat's pre-probe `readyState != OPEN` check still
  runs first and force-reconnects before the probe ever reaches `_safeSend`.
- **Double-fire:** the liveness-path reconnect is guarded by `!this.reconnecting` + the
  `this.ws === sock` identity check, so a burst of failures collapses to at most one
  `_forceReconnect`/epoch-bump (storm guard, unit-tested). The ACK path does NOT
  reconnect (a failed ack ≠ a dead socket), removing a reconnect-churn source.
- **Races:** `_safeSend` reads `this.ws` once into `sock` and reconnects only if
  `this.ws === sock` — so a teardown-and-replace between capture and throw cannot tear
  down a fresh healthy socket. Respects the #1076 epoch model (never resurrects a
  torn-down socket). `_drainQueue` iterates a snapshot and reassigns `outboundQueue`
  once (no mutate-during-iterate; single-threaded so no interleave).
- **Feedback loops:** none. `handleProcessLevelError`'s non-fatal branch logs-and-returns;
  it does not re-throw or re-enter.

---

## 6. External surfaces

- **Other agents (same machine):** none — per-process socket + per-process crash guard.
- **Install base:** ships to all agents via the normal release path (pure `src/*.ts`).
- **External systems (Slack):** strictly more robust — a transient socket glitch now
  reconnects instead of crashing; unacked envelopes are redelivered by Slack as today.
- **Persistent state:** none added. The fatal path still calls `closeAllSqlite()` before
  exit (now via the injected cleanup callback) — unchanged behavior.
- **Operator surface (Mobile-Complete):** no operator-facing action added — no route, no
  form, no PIN/approval surface. Not applicable.

## 6b. Operator-surface quality

No operator surface — no dashboard renderer, approval page, or grant/secret form touched.
Not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN** — all three artifacts are per-process / per-socket:

- `_safeSend` + reconnect: the Slack WebSocket is a per-process resource; only the
  machine holding the live socket sends. A standby machine has `this.ws === null`, so
  `_safeSend` no-ops. Which machine owns the socket is the existing lease/standby model's
  job; this change does not touch it.
- `uncaughtException` / `unhandledRejection` handlers: process-level crash containment is
  inherently per-process. The allowlist already encodes the standby case
  (`'StateManager is read-only'`); the new rejection handler consults the same authority,
  so lease/standby semantics stay identical across both handlers.

No user-facing notices (no one-voice concern). No durable state (nothing strands on topic
transfer). No generated URLs.

---

## 8. Rollback cost

Pure code change — revert the commit, ship as the next patch (reaches agents via `instar
update`; nets #2/#3 keep them alive during the rollback window). No persistent state, no
data migration, no config flag (so no `migrateConfig` obligation), no user-visible
regression. The single riskiest knob — the allowlist broadening — is independently
revertable (delete the one entry) without touching `_safeSend`.

---

## Conclusion

The review produced the converged design directly (the spec's `## Frontloaded Decisions`
captured every choice). Key review-driven shapes baked in: the ACK path does not reconnect
(storm-avoidance), `_drainQueue` retains unsent messages on failure, `_safeSend` re-checks
socket identity before reconnecting, the allowlist entry is anchored + transport-scoped
with a negative test, and the new `unhandledRejection` handler shares one authority with
`uncaughtException` so they cannot drift. No brittle-detector-with-authority is introduced;
the global default stays fail-toward-crash. Clear to ship pending the required second-pass
read.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (instar-dev Phase 5 — change touches the
process-level recovery path + a self-heal reconnect trigger)
**Independent read of the artifact: concur**

Read all three implementation files line-by-line plus tree-wide greps, and verified
the six load-bearing points against the ACTUAL code (not the artifact's claims):
(1) `_safeSend` reads `this.ws` once into `sock`, sends on `sock`, and reconnects only
when `reconnectOnFailure && this.started && !this.reconnecting && this.ws === sock` —
identity guard present, no resurrection; (2) ACK passes no reconnect, liveness passes
`true`, `queueOutbound` enqueues on false, `_drainQueue` breaks + `pending.slice(k)`
retains the unsent tail (remove-only, ≤ MAX), no reconnect from drain; (3) the not-OPEN
precheck logs nothing, the catch never logs the payload; (4) `handleProcessLevelError`
has zero static `SqliteRegistry` import, takes injected `onFatalCleanup`/`exit`, owns the
full log/cleanup/exit sequence, and BOTH server.ts handlers delegate to it with one
shared `onFatalCleanup`; (5) the allowlist entry is the anchored `'WebSocket is not open'`
and a tree-wide grep confirms the live "...is not open for public registration" /
"database connection is not open" strings do NOT contain it; (6) exactly one raw
`sock.send(` exists (inside `_safeSend`), no shadow process handlers, no mutate-during-
iterate. Concur with the review — clear to ship.

---

## Evidence pointers

- Converged spec: `docs/specs/SLACK-SUBSYSTEM-ERROR-CONTAINMENT-SPEC.md`
- Convergence report: `docs/specs/reports/slack-subsystem-error-containment-convergence.md`
- ELI16 overview: `docs/specs/SLACK-SUBSYSTEM-ERROR-CONTAINMENT-SPEC.eli16.md`
- Tests (added): `tests/unit/slack-safesend.test.ts`,
  `tests/unit/process-level-error-handler.test.ts`,
  `tests/integration/slack-adapter-boundary.test.ts`,
  `tests/e2e/slack-containment-process-survival.test.ts`
