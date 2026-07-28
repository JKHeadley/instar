# Side-Effects Review — Context-wedge seen latch

**Version / slug:** `context-wedge-seen-latch`  
**Date:** `2026-07-21`  
**Author:** `instar-codey`  
**Second-pass reviewer:** `independent Codex agent /root/living_doc_canonicalization`

## Summary of the change

`SessionMonitor` records the existing detector's positive context-exhaustion result through a true-only per-topic latch owned and persisted by `SessionRecovery`. `SessionRecovery` may reuse that remembered observation after the banner scrolls away, while retaining its existing ownership, active-work, cooldown, attempt, compact, and respawn authority. Tests cover monitor presentation, persistence, reload, attempt-row preservation, success clear, and manual clear.

## Decision-point inventory

- `detectContextExhaustion` result — pass-through — unchanged detector is the only setter signal.
- `SessionMonitor` context presentation — modify — current detector match or remembered true signal enters the same existing call, still behind the existing monitor cooldown.
- `SessionRecovery` context branch — modify — consumes the remembered signal but retains every existing recovery guard and action decision.
- latch clear — add invariant — only existing `recovered:true` or explicit manual clear.

## 1. Over-block

No new block/allow surface. A deliberately recycled numeric topic id could inherit a stale true value unless the operator uses the explicit manual clear first; the final scope ruling rejects inferred mapping validation, and current topic ids are stable external conversation identities.

## 2. Under-block

The change remembers only context wedges already recognized by the existing patterns. It does not recognize new banner text, silent provider/network waits, or other terminal shapes. A persistence write failure degrades to in-memory behavior for that process, matching the existing recovery-state failure posture.

## 3. Level-of-abstraction fit

The latch is signal memory at the observer/action seam. It does not create a parallel detector or recovery controller. Persistence belongs to `SessionRecovery`, the existing single owner of recovery-state writes; the monitor receives only mechanical mark/read methods.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The unchanged regex detector sets only a boolean. The existing deterministic SessionRecovery policy remains the only action authority and applies ownership, work, cooldown, attempt, compact-verification, and respawn rules.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. True-or-absent persistence is an invariant materialization of a detector result. Competing work/recovery signals remain with the existing SessionRecovery authority.

## 5. Interactions

- **Shadowing:** a current detector match remains preferred; the latch matters only when the current capture is negative.
- **Double-fire:** one monitor branch calls the one recovery instance at most once per existing monitor cooldown.
- **Races:** `SessionMonitor.poll()` is already serialized; latch mutations and whole-state writes occur synchronously through the one SessionRecovery instance.
- **Feedback loops:** failed/deferred recovery retains the boolean but creates no timer. Existing cooldown and attempt exhaustion bound later action.

## 6. External surfaces

The only durable surface is a `wedgedSeen` true-only object in `.instar/recovery-state.json`. No raw pane text, pattern, timestamp, confidence, or session metadata is stored. Users may observe recovery continuing after the original banner scrolls away. No new notification or external-service call is added. The manual-clear method is an internal recovery seam, not a new operator UI or API.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design (`hardware-bound-resource`): the signal describes a tmux pane and SessionRecovery instance local to the machine owning that session. It emits no new user-facing notice, generates no URL, and creates no pool-wide authority. Topic transfer needs the existing recovery/ownership lifecycle or explicit manual clear; this increment intentionally adds no mapping policy.

## 8. Rollback cost

Revert the code and ship a patch. Old versions ignore the additive `wedgedSeen` field in the recovery-state JSON. No migration is required; the field can remain harmlessly or be manually removed.

## Conclusion

The change is intentionally narrower than the withdrawn expiring typed-latch design. The side-effect review confirms that it adds only durable detector memory, while all action authority and brakes remain in SessionRecovery. The required independent second pass concurred.

## Second-pass review (if required)

**Reviewer:** independent Codex agent `/root/living_doc_canonicalization`  
**Independent read of the artifact:** concur

Concur with the review. The unchanged detector is the sole setter; persistence is true-or-absent with no metadata; SessionRecovery retains ownership, work, cooldown, attempt, compact, and respawn authority; monitor reuse stays behind the existing cooldown; and clear occurs only on `recovered:true` or the explicit manual seam. No new timer, pattern, mapping, retry owner, engine, or external side effect was introduced.

## Evidence pointers

- `tests/unit/context-exhaustion-recovery.test.ts`
- `tests/unit/SessionMonitor.test.ts`
- `docs/specs/reports/context-wedge-detection-completeness-convergence.md`

## Class-Closure Declaration (display-only mirror)

This modifies an existing self-triggered recovery path but adds no new control-loop edge or side effect. `defectClass: unbounded-self-action`; `closure: guard`; `guardEvidence: { enforcementType: ratchet, citation: tests/unit/context-exhaustion-recovery.test.ts, howCaught: the persistence/reload test forces the detector-positive banner to disappear, then proves the same bounded SessionRecovery path still receives the true-only signal while the existing cooldown and maximum-attempt brake remain authoritative }`. The unchanged steady-state brakes are SessionMonitor's poll/cooldown and SessionRecovery's per-session cooldown plus max-attempt cap; `tests/unit/self-action-convergence.test.ts` remains the standing controller ratchet.
