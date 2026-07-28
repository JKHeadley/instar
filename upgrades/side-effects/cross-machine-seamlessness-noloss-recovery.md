# Side-Effects Review — Cross-Machine Seamlessness: no-loss stuck-message recovery (D-noloss)

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3a ("Stuck-`processing` recovery")

The complement to the inbound dedup gate. With dedup alone, a crash AFTER claiming an
inbound event but BEFORE the reply commits would lose the reply (Telegram won't redeliver
once polled). This adds the spec's explicit "re-run from the stored input by the current
lease holder" mechanism: a `processing` entry stuck past `maxProcessingMs` is re-routed from
its `inputSnapshot`, producing the lost reply. Together with the dedup gate this makes the
flag's guarantee genuinely *exactly-once* (no-loss AND no-duplicate). Still flag-gated dark
(`multiMachine.exactlyOnceIngress`, default false).

## What changed
- `src/messaging/stuckMessageRecovery.ts` — NEW. `recoverStuckMessages(deps)`: lease-gated
  (a standby never injects); `reclaimStuck(maxProcessingMs)` → for each entry with a stored
  input and `attempts < maxReplayAttempts` (default 3), re-claim under the current epoch and
  call the injected `reinject(topic, dedupeKey, text)`. Pure orchestration over injected deps.
- `src/commands/server.ts` — after `server.start()`, ONLY when the ledger is wired (flag on)
  AND telegram is present: builds `reinject` (sets the per-topic current-inbound key, then
  routes the stored text via the same `telegram.onTopicMessage` path a fresh forward uses),
  runs recovery at boot, and on a cadence (`max(30s, maxProcessingMs)`), lease-gated.

## Over-block / under-block
- OVER-re-run (the risk = re-answering a message the agent legitimately left unanswered, or a
  persistently-failing turn looping): bounded by (1) only entries stuck past `maxProcessingMs`
  (a genuinely timed-out turn, not one in flight), (2) `attempts < maxReplayAttempts` cap —
  after the cap the entry is left alone, never re-run again, (3) lease-gate (only the awake
  machine), (4) flag-off default. Proven both sides in stuck-message-recovery.test.ts.
- UNDER-recover: an entry with no `inputSnapshot` can't be replayed (nothing captured) → skipped
  honestly rather than guessed. Inputs ARE captured by the dedup gate's `decideIngress(input:text)`.
- The known single-duplicate residual (spec §3 / §8 G3a impossibility floor): a crash AFTER the
  reply physically sent but BEFORE `reply_committed` persisted → re-run produces one duplicate.
  This is the documented Two-Generals floor, bounded to one, not a defect.

## Signal vs authority
- recoverStuckMessages decides which entries to re-run; the re-injection authority is the
  existing onTopicMessage routing. The module holds no Telegram/server coupling (injected deps).

## Interactions
- Re-injection sets `currentInboundByTopic[topic]` BEFORE routing so the eventual reply commits
  the correct entry (same coupling the inbound gate uses) — closing the loop: re-run → reply →
  commit → not re-run again.
- Telegram-only for v1 (the `--no-telegram` sessionManager path is a tracked refinement; the
  block is guarded on `telegram` present).
- Cadenced re-scan is `unref()`'d (never holds the process open) and lease-gated (a standby's
  timer no-ops).

## Rollback cost
- Low. Flag default-off ⇒ the whole block is skipped (messageLedger undefined). Revert = drop the
  post-start block + the module. No persisted schema beyond the opt-in ledger SQLite.

## Tests
- `tests/unit/stuck-message-recovery.test.ts` (7): re-runs a stuck entry from stored input;
  standby no-op; already-replied not re-run; in-flight (within window) not re-run; attempts-cap
  gives up (no storm); no-input skipped; + boot wiring-integrity (server.ts calls it after
  server.start(), gated on the ledger + coordinator lease).

## NOT in this increment (tracked, topic-13481)
- Behavioral boot-recovery e2e (needs a live Telegram adapter) — exercised by the live flag-flip
  test-as-self, which is the gate before defaulting the flag on. Cross-machine marker (D-xmachine)
  + CONTINUATION resume (D3) remain.
