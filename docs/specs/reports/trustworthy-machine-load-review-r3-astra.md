# Review round 3 — GPT-6 Astra, 2026-10-25

1. **Verdict: ready with changes.** P1–P2 can proceed; P3 needs one recovery contract tightened.

2. **Round-2 blockers:** Resolved in the design: admission respects hard constraints without router fallback; reports carry age and expiry; capacity accounting is host-wide; critical signals take precedence; overload proposals are separate from pins; recovery no longer blindly reverses a completed claim. The move engine is now correctly identified.

3. **Remaining BLOCKER — in-flight recovery must outlive transient proposals.** D1 drops an overload entry on expiry or target ownership, but D4 still requires recovery and source cleanup afterward—including across restart. Today, `OwnershipReconciler.tick()` discovers transfers only while iterating effective pins. An unpinned overload transfer therefore cannot rely on that existing loop once its transient entry disappears. Additionally, existing `abort-transfer` runs only on the source and only when the target is considered offline; a live target that never claims does not meet that condition.

   Specify that started moves remain durably discoverable independently of proposal expiry, through claim/abort, source cleanup, and reservation settlement. Define who recovers them when the source is unreachable, and ensure the deadline handles a live-but-nonclaiming target. Otherwise a restart or expired proposal can strand ownership in `transferring` and leak reserved capacity.

No other blockers found.