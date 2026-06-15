# Side-effects — wedge-recovery terminal-abandon + loss notice (gap #2 / CMT-1563)

## What changed (3 src files + 2 test files)

- `src/messaging/MessageProcessingLedger.ts` — new terminal `abandoned` state: `LedgerState` +
  `LedgerEntry.abandonedAt` + `abandoned_at` schema column (idempotent ALTER, self-migrating);
  `markAbandoned(dedupeKey, epoch)` (`processing → abandoned`, sets `abandoned_at`, leaves
  `reply_committed_at` NULL); `isActedOn` + `beginProcessing` now treat `abandoned` as terminal.
- `src/messaging/stuckMessageRecovery.ts` — the give-up branch calls `markAbandoned` and pushes the
  entry to a new `StuckRecoveryResult.abandoned: Array<{topic, dedupeKey}>`.
- `src/commands/server.ts` — `runStuckRecovery` emits ONE per-topic loss notice from
  `result.abandoned` via `notify(...)` (targeted to the topic).

## Behavioral side-effects

- **The give-up log-loop ends.** An exhausted stuck entry is moved out of `processing`, so
  `reclaimStuck` stops re-selecting it every cycle (was firing `giving up on … after 3 attempts`
  every ~10 min for hours on the same entries).
- **Loss is no longer silent.** Each abandoned entry produces ONE "I didn't get to N message(s) you
  sent earlier — resend anything still needed" notice to its topic, exactly once.
- **A redelivery of an abandoned event is dropped** (`isActedOn` true) — a genuine resend has a
  fresh dedupeKey and is processed normally.
- **No false reply-evidence:** `abandoned` leaves `reply_committed_at` NULL, so
  `hasReplyCommittedForTopicSince` never returns true for it — it can't wrongly suppress recovery of
  a sibling stuck entry on the same topic.

## Risk + rollback

- Highest-risk subsystem (exactly-once message ledger). Fail-safe: `markAbandoned` acts ONLY on an
  already-exhausted `processing` entry — it cannot touch an in-flight or still-recoverable entry,
  and never marks anything replied. The new state is additive (free-TEXT `state` column).
- No flag — a correctness fix to a live loss + log-loop, not a dark feature. Revert = restore the
  prior `skipped++; continue` give-up branch (but that reinstates the silent drop + the loop).

## Tests

- `tests/unit/MessageProcessingLedger.test.ts` — 2 new: `markAbandoned` terminal semantics (no fake
  reply, terminal, no false topic reply-evidence, not re-selected); no-op when not `processing`.
- `tests/unit/stuck-message-recovery.test.ts` — 1 new: exhausted entry abandoned + surfaced + not
  re-looped; the standby-result assertion updated for the new `abandoned: []` field.
- 30/30 ledger + recovery unit tests green; tsc clean.

## Migration parity

Self-migrating SQLite (idempotent `ALTER TABLE ADD COLUMN abandoned_at`) — existing agents' ledgers
upgrade in place on first access, no PostUpdateMigrator step. Internal recovery mechanism; no
agent-facing route/capability, so no CLAUDE.md template change required.
