# Side-Effects Review — Spawn Drain Refusal Give-Up

**Version / slug:** `spawn-drain-refusal-giveup`
**Date:** `2026-07-30`
**Author:** `instar-codey`
**Second-pass reviewer:** `Singer (subagent) — concern raised and resolved; Heisenberg (subagent) — re-review concurred`

## Summary of the change

This change makes repeated Threadline spawn-drain refusals bounded and visible. `src/messaging/SpawnRequestManager.ts` now lets the drain callback return a denial verdict, counts denials per drain target, latches the target after a configurable threshold, and exposes status/runtime config for the threshold and re-arm interval. `src/commands/server.ts` returns the drain verdict to the manager and emits one stable agent-health Attention item when give-up occurs. `src/server/routes.ts`, `src/core/types.ts`, and `tests/unit/spawn-request-manager.test.ts` cover the config and regression surface. A successful inline spawn clears the latch only after `spawnSession` resolves, then preserves held queued work for a later drain rather than mixing it into the inline prompt.

## Decision-point inventory

- `SpawnRequestManager.runTick()` — modify — a drain target with queued messages is no longer always eligible; a latched give-up target is skipped until re-arm.
- `SpawnRequestManager.onDrainReady` result handling — modify — a denied spawn verdict now feeds refusal accounting instead of looking like successful callback completion.
- `SpawnRequestManager.#recordDrainRefusal()` — add — deterministic bounded retry and latch decision for one drain target.
- `server.ts onDrainGiveUp` — add — signal emission into the existing Attention queue with a target-stable id and explicit reopen/update behavior.
- `/messages/spawn/config` route allowlist — modify — runtime tuning accepts the new threshold and re-arm interval.

---

## 1. Over-block

The change can delay legitimate queued peer messages after the threshold if the refusal condition clears immediately after the latch is set. The re-arm interval defaults below the queued-message TTL, so a short-lived recovery just after the final refusal may wait for that interval before retrying. This is intentional pressure braking: the prior behavior retried indefinitely under sustained refusal, and the held queue plus attention item makes the delay visible rather than silent. While latched, existing backlog is protected from TTL pruning and capacity eviction; if its per-target capacity is already full, a newer arrival is refused and the existing truncation marker makes that loss explicit.

---

## 2. Under-block

This does not make the queued-message store durable across process restart; held messages are still in-process state. It also does not prove whether a `spawnSession` throw means the prompt was already delivered, so the existing non-requeue behavior for spawn throws remains unchanged. Callback exceptions are counted as drain refusals by server wiring, but the fix does not classify every possible infrastructure failure into a richer cause taxonomy. Second-pass review found resolved under-blocks: held messages could age out at the same ten-minute TTL as the default re-arm interval, later arrivals could TTL-prune latched backlog, old refusal counters could survive re-arm, inline recovery could drain held messages too early, and a failed Attention write had no retry state. The implementation now defaults re-arm below the queue TTL, protects latched backlog from TTL/capacity eviction, refreshes held queue timestamps when the latch genuinely re-arms, clears refusal counters on both re-arm paths, avoids draining held queued payloads before inline spawn success is proven, and records/reports/retries failed Attention writes.

---

## 3. Level-of-abstraction fit

The manager is the right layer because it owns the drain target selection, DRR counters, queue visibility, and callback result semantics. Server wiring is the right layer for Attention because the manager should not import Telegram or operator surfaces. No parallel detector store is introduced; the change extends the existing spawn manager state and status path.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.

This change is deterministic authority, but it falls under the hard-invariant / resource-safety carve-out rather than a conversational judgment point. It does not decide what a message means and does not weaken admission policy. It enforces a steady-state bound on a self-triggered retry loop after repeated explicit denial verdicts, then emits a signal to Attention.

---

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. The bounded retry threshold is a capacity-safety invariant for a self-triggered loop: one target cannot be retried forever after repeated denied spawn verdicts. The memory-pressure clear predicate uses the existing memory monitor state only to prevent flapping; it does not overrule the spawn admission decision.

---

## 5. Interactions

- **Shadowing:** the latch runs after existing spawn admission returns a denial. It does not run before memory/session/quota checks and cannot hide a valid approval.
- **Double-fire:** Attention uses one stable id and agent-health key per target, so delivery retries dedupe. A later episode after genuine re-arm updates and reopens that same item instead of either disappearing behind it or creating an unbounded series of episode-keyed items.
- **Races:** `runTick()` already has an inflight guard; the new maps are mutated inside that serialized tick path. Current main's payload-preservation funnel snapshots queued backlog without removing it and commits only after `spawnSession` proves delivery. The rebase preserves that invariant: a latched target's inline recovery probe snapshots no held backlog, force-rearms only after proven delivery, and leaves the held entries for the next drain.
- **Feedback loops:** the re-arm path has both time hysteresis and an optional clear predicate. For memory pressure, server wiring requires the memory monitor to report normal before re-arm.

---

## 6. External surfaces

Other agents see no protocol change. The receiving agent's operator gets one Attention item when a drain target gives up. The existing GET and PATCH `/messages/spawn/config` responses include/accept two new numeric knobs. Persistent state is not added; held queue and latch state are process-local. No operator-facing dashboard or form is changed.

---

## 6b. Operator-surface quality

No operator surface — not applicable. The only operator-visible change is an existing Attention queue item, not a new dashboard/form action.

---

## 7. Multi-machine posture

**Machine-local BY DESIGN.** Spawn admission, memory pressure, active session count, and queued drain payloads are machine-specific truths. A Mac Mini under swap pressure should latch its own drain target even if another machine is healthy. The emitted notice is a local agent-health Attention item; it does not generate URLs and does not need topic-transfer durability. One-voice gating is handled by the target-stable Attention id on the machine that owns the failed drain.

---

## 8. Rollback cost

Rollback is a code revert and patch release. No migration is needed because no durable schema is added. Held queue/latch state exists only in memory and disappears on process restart. During rollback, the old behavior returns: persistent refusals can again retry silently, but no user data migration or repair is required.

---

## Conclusion

The review changed the implementation from dropping queued messages at give-up to holding them behind a latch, then changed the re-arm paths so held messages do not silently expire before their first post-rearm delivery attempt. That preserves work while still bounding the retry loop and surfacing the incident. The change is clear to ship as a spawn-lifecycle fix with second-pass review.

---

## Second-pass review

**Reviewer:** Singer (subagent), then Heisenberg (subagent)
**Independent read of the artifact:** concern raised, resolved, and re-reviewed cleanly

Concern raised: held messages could still be silently lost because the give-up latch skipped drain attempts until the default ten-minute re-arm interval while queued entries also expired after ten minutes. A later review also checked stale refusal counters after re-arm and inline recovery draining held messages too early.

Resolution: `SpawnRequestManager` now defaults the re-arm interval below the queue TTL, refreshes held queued entries' `receivedAt` timestamps immediately before scheduled re-arm, clears the old refusal counter on both re-arm paths, and no longer drains held payloads into an inline prompt before spawn success is proven. Heisenberg independently re-reviewed the amended diff and found no issues.

**Current-main rebase review:** the only semantic conflict was with the later transient-refusal payload-preservation funnel. The resolution keeps both guarantees: no backlog removal before delivery, and no held-backlog injection into a latched inline probe. A successful probe force-rearms and refreshes the held entries; a failed probe leaves the latch and original backlog age/order untouched.

The fresh independent reviewer raised four concrete gaps across three passes: later arrivals could TTL-prune latched backlog; an Attention write failure had neither visible state nor retry; an absent Telegram adapter falsely counted as successful delivery; and a permanent target-only Attention id could hide a later give-up episode behind an old resolved item. The implementation now protects latched backlog from TTL/capacity eviction, records and reports Attention failure state, retries every 30 seconds while latched, treats a missing adapter as failure, and explicitly refreshes/reopens the target-stable Attention item after genuine re-arm. This preserves the one-item-per-target invariant while making recurrence visible. The reviewer then audited that final target-stable/reopen design against the real-adapter regression and returned `APPROVE`; 115 focused tests and the build pass.

---

## Evidence pointers

- `npx vitest run tests/unit/spawn-request-manager.test.ts tests/unit/attention-single-topic-routing.test.ts` — 115 tests passing, including current main's payload-preservation and ordering cases, latched-backlog TTL protection, Attention-write retry state, and target-stable Attention reopen behavior through the real adapter.
- `npm run build` — passing; expected local no-signing-key transitional warning only.
- `npm run lint` — completed during pre-commit; existing report-only notices only.

---

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/spawn-request-manager.test.ts, howCaught: the regression tests drive one drain target through repeated refused spawn verdicts, assert the loop settles by emitting exactly one give-up event and skipping subsequent ticks while messages remain held, and assert held messages survive re-arm rather than silently expiring }`.
