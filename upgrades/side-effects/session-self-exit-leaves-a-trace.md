# Side-effects review — a session that exits on its own leaves a trace

**Change:** the monitor's "tmux pane is gone" branch previously wrote
`status:'completed'` with no reason and emitted nothing a log could catch. It
now stamps `endedReason` (`process-exited` / `process-exited-during-startup`),
emits `sessionExited`, and the server records a `type:'exited'` row in the
reap-log carrying uptime, framework, and a redacted, clamped last-seen pane
tail sampled during the session's startup window.

**Files:**
- `src/core/SessionManager.ts` — startup-window tail sampling; `endedReason`
  stamp + `sessionExited` emit on the vanish branch.
- `src/monitoring/ReapLog.ts` — `recordExited()`, the `'exited'` type, new
  optional fields, redaction + clamp at the write chokepoint, re-clamp on read.
- `src/commands/server.ts` — `sessionExited` → `reapLog.recordExited` wiring.

**Tier:** 1. Risk floor 1 — at the floor. Additive observability; no blocking
authority, no migration, no config, revert-only rollback.

**Origin:** the 2026-08-22 codex interactive death charter named this
explicitly: "Every death is recorded as a normal completion with an empty
reason, and no shutoff record explains it. That means nobody can debug this
from the records alone, which is itself part of what you should fix."

---

## 1. Over-block — what legitimate input does this now reject?

Nothing is rejected; this path gates nothing. The one behaviour a caller could
perceive as a "block" is that `recordExited` refuses to store an unscrubbed or
oversized tail — it scrubs and clamps instead of refusing, so no write is ever
dropped.

## 2. Under-block — what does this still miss?

- **A death in the first 15 seconds has no tail sample.** The monitor's grace
  period skips sessions younger than 15s, so sampling starts there and the
  tick is 5s; a session that exits at ~16s may have 0–1 samples. Today's class
  (18–23s) gets at least one tick in the window in practice, but it is a
  window, not a guarantee. The reason stamp and the row itself do not depend
  on the sample.
- **A death past the 120s window carries no tail.** Deliberate: the silent-
  death class clusters at startup, and sampling every live session every tick
  would double the monitor's per-tick tmux calls for the common long-lived
  case. The row still records uptime + reason.
- **Server-restart between sample and vanish loses the sample** (memory-only
  by design — see §8).
- **`reapCompletedSessions()` (the sync reaper) still marks `completed`
  without a reason.** Checked: it is a legacy sweep the monitor loop has
  superseded; I left it untouched rather than widen a Tier-1 change, and it is
  named here so it is not mistaken for covered.

## 3. Level-of-abstraction fit

Correct layer, and the alternatives were considered:

- The reason belongs on the **vanish branch of the monitor** because that is
  the single place instar learns a process ended on its own. Every other end
  path (`terminateSession`, `killSession`) already stamps `endedReason`; this
  branch was the one that did not.
- The row belongs in **ReapLog** because that log already IS "why did a
  session end" — a parallel "exit log" would fork the question the reap-log
  answers and break `GET /sessions/reap-log` as the one surface.
- The redaction belongs **inside `recordExited`**, not in the caller: the
  reap-log is world-readable and a second caller (future or foreign) must not
  be able to write raw pane text. `redactForLiveTail` is the existing
  chokepoint for exporting pane content (dashboard live tail) — reused, not
  re-invented.
- Sampling belongs in the **monitor tick**, which already probes every
  running session; adding a bounded capture there is the cheapest place it can
  live and needs no new timer.

## 4. Signal vs authority compliance

Pure signal. The change produces a record and an event; it blocks, delays, or
rewrites nothing. `sessionComplete` still fires for every existing listener
(asserted by test), so no downstream authority changes. The `sessionExited`
listener in server.ts is wrapped so an audit-write failure cannot disturb the
monitor loop.

## 5. Interactions

- **`sessionComplete` listeners:** unchanged; the new event is additive and
  emitted BEFORE `sessionComplete` so a log row exists by the time any
  completion-driven cleanup runs.
- **Resume queue / boot reconciliation:** reads `type:'reaped'` rows only
  (`server.ts:10016`); an `'exited'` row is ignored by it, which is correct —
  a self-exit is not a mid-work reap to revive.
- **Pool-scope reap-log merge:** the peer-page validator checks shape only
  (entries are objects, page has `truncated`), so `'exited'` rows from a peer
  on this version pass; a peer on the OLD version that reads a new row
  normalises its type to `'reaped'` (the legacy coercion). Mixed-version
  honesty: an old reader mislabels, it does not crash. Stated in §7.
- **Skip-state dedup:** `recordExited` calls `forgetSkip`, same as
  `recordReaped`, so a same-named successor logs fresh.
- **Startup tail sampling vs the readiness probe:** both call `capture-pane`
  on young sessions; they do not share state and the sample is taken before
  the liveness probe so a dead pane keeps the previous sample.

## 6. External surfaces

- `GET /sessions/reap-log` now returns a new row kind. Consumers that switch
  on `type` were checked (§5); none break. The dashboard does not render the
  reap-log directly.
- `GET /sessions?include=all` now shows `endedReason` on self-exited records.
- **The tail is pane content in a log.** This is the one genuinely new
  exposure and it is bounded: redacted through the live-tail scrubber (API
  keys, bearer tokens, JWTs, private-key blocks, `secret=`-style assignments),
  capped at 12 lines / 1500 chars, with the redaction count recorded. It is
  the same class of data the dashboard already streams off-box through the
  same scrubber; here it stays in a local log. Stated honestly: the scrubber
  is pattern-based and cannot catch a secret it has no pattern for.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The reap-log is per-machine and already read
pool-wide via the existing `?scope=pool` merge, which this rides unchanged.
The tail sample is per-process memory on the machine that owns the pane —
there is nothing to replicate (the pane exists on one disk). Mixed-version
pool: a peer still on the prior version that reads an `'exited'` row coerces
its type to `'reaped'` on read (legacy whitelist) — a mislabel, never a
failure, and it resolves as the pool updates. No user-facing notice is
emitted, so no one-voice concern; no durable state strands on transfer.

## 8. Rollback cost

`git revert`. No migration, no config, no stored state beyond append-only log
rows that older readers already tolerate (coerced to `'reaped'`). Partial
rollback is clean: dropping the sampling leaves reason + row intact; dropping
the row leaves the reason stamp.

## Framework generality

Framework-general by construction. The vanish branch does not know what
framework it is looking at — it stamps a reason and forwards `session.framework`
(whatever was recorded at spawn) into the row. The sampling is a `capture-pane`
on a tmux target, identical for every framework. Nothing here routes through
the framework abstraction because nothing here is framework-specific; the
first beneficiary happens to be codex-cli because that is what died today.

## Phase 5 — second-pass review

Not run: this session carries a standing operator directive against spawning
subagents. Recorded as `secondPass:false`; causal autopsy supplied in the
trace as the Tier-1 compensating control.
