# Side-Effects Review — Context-Wall Recovery Escalation

**Version / slug:** `context-wall-compact-escalation`
**Date:** `2026-06-06`
**Author:** `Echo (instar-dev agent — Justin: "still sometimes having trouble recovering from compaction, can you look into this?")`
**Second-pass reviewer:** `self-adversarial pass over the one way this can go wrong — pressing /compact on a session that shouldn't be touched`

## Summary of the change

`SessionRecovery.recoverFromContextExhaustion` gains a non-destructive rung
BEFORE its existing kill+fresh-respawn: an optional `attemptCompaction(name)`
dep presses `/compact` for a session genuinely stuck at the context wall and
verifies the wall cleared (`detectContextExhaustion`). On success the
conversation is preserved; on failure/timeout it falls through to the
pre-existing destructive respawn. Gated to `!hasActiveProcesses`. server.ts
wires the dep (injectMessage('/compact') + bounded verify poll). CLAUDE.md note
added. Files: SessionRecovery.ts, server.ts, PostUpdateMigrator.ts, 2 test files.

## Decision-point inventory

- `attemptCompaction` rung — **add (recovery action, non-destructive)** — tried
  before the existing destructive path.
- `!hasActiveProcesses` gate on the rung — **add** — never /compact a working session.
- fall-through on cleared:false / throw — **preserve** — existing respawn unchanged.
- optional dep — **add** — absent ⇒ fully back-compat.

## 1. Over-block

None. The rung adds no blocking authority; it is strictly LESS destructive than
the kill+respawn it precedes. The only "action" is a `/compact` keystroke, gated
to a genuinely idle stuck session. A working session is never compacted (the
gate + the existing kill-defer both protect it).

## 2. Under-block (the real risk — pressing /compact wrongly)

The danger is compacting a session that's actually fine. Defenses, each tested:
- **`!hasActiveProcesses` gate:** a session with running children (working) skips
  the rung entirely (test: "does NOT /compact a working session").
- **Reached only on a confirmed context-exhaustion detection** (the caller already
  matched `detectContextExhaustion` on the live output before calling recovery).
- **Verify-then-claim:** the rung only reports success when the wall signature is
  actually gone from the live tail post-/compact; a no-op /compact times out and
  falls through.
Residual: if a session shows the wall signature but is between turns with a
child momentarily absent, the rung could /compact it — but /compact on a session
that didn't need it is benign (Claude compacts and continues), and the detection
gate makes this rare. Worst case is strictly better than the old "kill it."

## 3. Level-of-abstraction fit

The rung lives in the dedicated context-exhaustion handler. The inject+verify
mechanism is wired in server.ts (which owns SessionManager) via existing
primitives (`injectMessage`, `captureOutput`, `detectContextExhaustion`) — no
new transport. The dep is injected, mirroring `respawnSessionFresh`.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] The escalation is a bounded recovery ACTION, gated by the same work-check
  and attempt/cooldown limits as the existing kill+respawn, and strictly less
  destructive. No new decision-maker; verification (not assertion) gates the
  success claim. Failure degrades to the prior authority path.

## 5. Interactions

- **SessionMonitor:** unchanged caller — it already calls `checkAndRecover` on a
  confirmed context-exhaustion detection; the new rung is internal to recovery.
- **kill-defer / hasActiveProcesses:** the rung reuses the same work-check the
  kill uses, so a working session is uniformly protected across both rungs.
- **attempt/cooldown limits (`shouldAttempt`):** unchanged — a /compact attempt
  counts as the attempt, same as a respawn did.
- **#935 (UUID-rotation verification):** orthogonal — that fix is for the
  sentinel's JSONL-growth verification; this rung verifies via tmux tail.

## 6. External surfaces / 7. Rollback

No API, no route, no config key (the dep is wired in server.ts; default-on when
wired). One idempotent CLAUDE.md note (marker 'Context-wall recovery
escalation'). Rollback = revert; recovery returns to kill+fresh-respawn-only
(the conversation-losing behavior).
