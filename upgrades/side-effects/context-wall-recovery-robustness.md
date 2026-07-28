# Side-Effects Review — Context-wall recovery robustness

**Version / slug:** `context-wall-recovery-robustness`
**Date:** `2026-07-23`
**Author:** Instar Agent (instar-codey)

## Summary

This closes a context-wall recovery loop that treated helper-process existence
as work, consumed attempts on deferral, and later resumed the poisoned
transcript. The fix reuses transcript-growth evidence, adds a bounded latch
ceiling, and forces all respawns fresh while the latch exists.

## Decision-point inventory

- Transcript growth is the positive work signal for context exhaustion.
- Unknown first observation defers without consuming an attempt.
- A 30-minute persistent latch forces the existing compact-then-fresh ladder.
- The latch suppresses resume UUID consumption at the Telegram and Slack spawn
  chokepoints.
- Ownership recovery gates remain ahead of local recovery.

## Seven-dimension review

1. **Over-block:** a growing transcript still defers recovery; ordinary stall,
   crash, error-loop, and non-latched respawns retain their prior behavior.
2. **Under-block:** static or persistently ambiguous context-wall episodes reach
   the existing fresh recovery path and cannot reload the poisoned transcript.
3. **Abstraction:** transcript probing supplies evidence; SessionRecovery owns
   recovery judgment; spawn chokepoints enforce fresh launch.
4. **Signal vs authority:** transcript growth is a signal. The deterministic
   latch age, attempt budget, ownership gate, and recovery ladder retain
   authority.
5. **Interactions:** compaction remains the first rung; TopicResumeMap and the
   Slack resume map remain authoritative outside a context latch.
6. **External surfaces:** no new operator action or network API is added.
   Standby copy changes only to report the already-durable latch honestly.
7. **Rollback:** revert the additive guards. Timestamped latch state remains
   readable and no external state needs repair.

## Multi-machine posture

Machine-local by design under `process-observer`: the evidence describes a
local pane and transcript. The existing ownership gate prevents local recovery
from acting on a peer-owned topic.

## Operator surface quality

Not applicable: no operator action or dashboard surface is added or changed.

## Class-Closure Declaration

`unbounded-self-action` closes as a **guard**: deferrals consume zero attempts,
the latch has a 30-minute ceiling, successful recovery clears it, and the
existing three-attempt/cooldown breaker bounds actual destructive attempts.
Boundary tests pin the no-burn and force-after-ceiling behavior.

## Evidence

Unit tests cover attempt accounting, transcript growth/static/unknown evidence,
legacy state migration, latch ceiling, and honest standby state. Source-wiring
guards pin Telegram and Slack resume suppression at both spawn chokepoints.
