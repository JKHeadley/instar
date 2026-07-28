# Side-Effects Review — Codex session-wedge self-recovery

**Version / slug:** `codex-wedge-self-recovery`
**Date:** `2026-06-03`
**Author:** `Echo`
**Second-pass reviewer:** `Echo (self) — Tier-2, single-pass under standing preapproval; ships dark`

## Summary of the change

Adds an escalating self-recovery for wedged codex sessions (input delivered but
not draining). The detector (`StuckInputSentinel`, server process) escalates past
the keypress ladder by requesting a tier-C recovery — a server restart + queue
replay — which is executed by a new lifeline-process consumer
(`SessionRecoveryConsumer`), because `ServerSupervisor` lives in the lifeline. The
two processes communicate through a new on-disk `SessionRecoveryChannel`
(single-writer-per-file request + ack + cooldown). Files: `SessionRecoveryChannel.ts`
(new), `SessionRecoveryConsumer.ts` (new), `StuckInputSentinel.ts` (escalation state
machine + recovered-request cleanup), `types.ts` (config shape), `server.ts` +
`TelegramLifeline.ts` (wiring). Highest-blast-radius decision point: **whether to
restart the agent server.** Ships dark (`monitoring.codexWedgeRecovery`, default
off + dryRun).

## Decision-point inventory

- `StuckInputSentinel exhausted-record path` — modify — after the keypress ladder,
  escalate (request tier C) instead of stopping, when enabled.
- `SessionRecoveryConsumer.handle` — add — decides whether to restart the server
  for a given request (cooldown + dedup + dry-run gates).
- `monitoring.codexWedgeRecovery` config gate — add — master enable + dryRun +
  cooldown + timeout. Default off.
- No message block/allow decision point is touched.

---

## 1. Over-block

No message block/allow surface — over-block not applicable. The closest analogue
is "would it restart a server it shouldn't?" Guards against that: it only fires
when (a) the config is enabled, (b) a codex marker is stuck past the keypress
ladder (≥ minTicks + maxAttempts keypresses all failed), and (c) the durable
cooldown is clear. In dry-run (the shipping default) it never restarts at all.

---

## 2. Under-block

No message block/allow surface. Failure-to-recover modes it still misses: a wedge
whose pane signature the marker-based detector doesn't recognize won't escalate
(out of scope — detection is unchanged); a wedge that a server restart genuinely
can't fix will restart once, hit the cooldown, ack failed, and stop (by design —
bounded, not infinite). Tier B (a gentler server-side message re-inject before the
restart) is a documented planned refinement, not in this cut.

---

## 3. Level-of-abstraction fit

Correct layering, and it was the central design question. Detection is a low-level
signal in the server; the restart is a high-level authority in the lifeline. They
are split across the real process boundary via the channel rather than forcing the
sentinel to reach across it. Reuses existing primitives (`fireStuckInputRecovery`,
`ServerSupervisor.performGracefulRestart`, `replayQueue`) instead of reimplementing
them.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no message block/allow surface.

This is the textbook Signal-vs-Authority split: the sentinel emits a SIGNAL (a
recovery request); the lifeline holds the AUTHORITY to act on it (or decline, via
cooldown/dry-run). The sentinel never restarts anything; the consumer is the only
actor, and it is gated.

---

## 5. Interactions

- **Shadowing:** The escalation hangs off the END of the existing keypress ladder —
  it only runs after `attempts >= maxAttempts`, so it never shadows the keypress
  recovery (that still runs first, unchanged). The lifeline consumer runs on its own
  15s interval alongside the existing replay + restart-signal intervals; it acts
  only on tier-C requests, so it can't interfere with version-skew restart signals
  (different file, different tier).
- **Double-fire:** The consumer dedups on `(sessionId, attemptId)` (terminal ack →
  skip) and records the restart durably BEFORE acting, so a crash mid-restart still
  counts against the cooldown. The sentinel won't emit a second request while one is
  in flight (idempotent by attemptId).
- **Races:** Single-writer-per-file (server owns request + cooldown-trigger via the
  sentinel's clears; lifeline owns ack + cooldown record) — no cross-process write
  contention. Atomic writes via SafeFsExecutor.
- **Feedback loops:** THE risk for this feature — a tier-C restart wipes the
  sentinel's in-memory escalation bound, so a still-stuck session could re-detect →
  re-restart forever. Closed by the DURABLE cooldown the lifeline checks before every
  restart (the sentinel's in-memory bound is no longer load-bearing across restarts).
  Unit-tested explicitly (cooldown blocks the second restart; allows it after the
  window).

---

## 6. External surfaces

- **Other agents / users:** none — per-agent state files + per-agent processes.
- **External systems:** none (Telegram/Slack/GitHub untouched). The server restart
  is the agent restarting itself — the same action the auto-updater + `/lifeline
  restart` already perform; it briefly drops the local API/dashboard while the
  server bounces (seconds), then queue replay re-delivers. This only happens when
  the feature is enabled AND not in dry-run.
- **Persistent state:** three new small JSON files under `state/`
  (`session-recovery-requested/acked/cooldown.json`). Inert when the feature is off.
- **Timing:** the consumer ticks every 15s only when enabled.

---

## 7. Rollback cost

Pure code + new files; the feature is dark by default. Back-out is `git revert` +
ship the next patch — nothing to undo on existing agents because nothing runs
until `monitoring.codexWedgeRecovery.enabled` is set (which no agent has). The new
state files are only written when enabled and are inert otherwise. No data
migration, no user-visible regression. Disabling live is a config flip (set
`enabled:false` or `dryRun:true`).

---

## Conclusion

The review's central concern — the restart-loop feedback path — was found DURING
the build (a tier-C restart wipes the in-memory bound) and closed with a durable
cooldown, which is the load-bearing safety mechanism and is unit-tested. The
feature ships dark + dry-run on the Graduated-Feature-Rollout track, with the only
high-blast-radius action (server restart) gated four ways (config enabled, not
dry-run, past the keypress ladder, cooldown clear) and bounded. Clear to ship as a
dark feature for review; enabling (dry-run → live) is a deliberate, reversible
config decision for the operator.

---

## Second-pass review (if required)

**Reviewer:** Echo (self) — Tier-2, ships dark; recommend a dry-run soak before live.
**Independent read of the artifact: concur**

The Signal-vs-Authority split is clean, the restart-loop guard is durable and
tested, dark-by-default is verified in both unit and integration tiers, and the
rollback cost is a revert. One flagged follow-up (not blocking): add tier B (a
server-side message re-inject) as a gentler step before the restart, to reduce how
often tier C fires once this soaks.

---

## Evidence pointers

- `tests/unit/SessionRecoveryChannel.test.ts` (15), `tests/unit/StuckInputSentinel-escalation.test.ts` (7),
  `tests/unit/SessionRecoveryConsumer.test.ts` (8), `tests/integration/codex-wedge-recovery.test.ts` (3),
  plus existing stuck-input suites — 78 total green.
- `docs/specs/CODEX-SESSION-WEDGE-SELF-RECOVERY.md` — design, cross-process
  constraint, durable-cooldown finding, increment plan.
- `tsc --noEmit` + `pnpm build` clean.
