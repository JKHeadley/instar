# Side-Effects Review — Codex quota load-shed parity

**Version / slug:** `codex-quota-load-shed`
**Date:** 2026-07-10
**Author:** Instar-codey
**Second-pass reviewer:** framework_guard_review

## Summary of the change

Boot now constructs `QuotaCollector` for `codex-cli`, using the existing rollout reader. The collector maps complete primary/secondary windows to shared `QuotaState`, persists explicit `quotaUnknown` when collection is missing or broken, and attributes both as `codex-rollout`. `QuotaTracker` treats complete Codex readings as authoritative and Codex uncertainty as fail-safe denial while preserving Claude semantics.

## Decision-point inventory

- Framework collector construction — modify — Codex gains a real quota producer; Claude construction is unchanged.
- Codex rollout mapping — add — provider windows become shared quota state.
- Solo-agent quota authority — modify — complete Codex state gates normally; Codex uncertainty sheds.
- Existing-agent awareness migration — add — all framework templates learn the new safety posture.

## 1. Over-block

A Codex agent with no readable complete rollout pauses new jobs/sessions, including first boot before its first quota-bearing turn. This is intentional fail-safe behavior requested for a framework where unknown capacity may already be a hard wall. Existing live sessions are not killed. Claude missing data remains fail-open and Gemini behavior remains unchanged.

## 2. Under-block

The newest persisted rollout can lag actual provider consumption until Codex emits another rate-limit-bearing event. Thresholds therefore remain the existing brake thresholds, not a prediction system. If quota tracking is disabled entirely, this subsystem remains intentionally absent. A complete but old snapshot is rejected by the tracker’s existing staleness bound and then follows Codex fail-safe denial.

## 3. Level-of-abstraction fit

The existing Codex rollout reader owns provider-log parsing. `QuotaCollector` owns normalization and persistence into the shared state shape. `QuotaTracker` remains the single job/session spawn authority. No second parser or parallel spawn gate is introduced.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the rollout reader and collector produce structured provider signals consumed by the existing quota authority.

Quota exhaustion and missing-data posture are constrained operational invariants, not conversational judgments. The tracker already owns this deterministic authority; the change supplies the missing Codex provenance and framework-specific uncertainty rule.

## 5. Interactions

- **Shadowing:** the Codex collector replaces the previous explicit “no framework usage meter” skip only for `codex-cli`.
- **Double-fire:** a solo Codex agent has one `QuotaManager` and one collector. Subscription-pool polling writes account metadata, not this global quota file.
- **Races:** `QuotaTracker.updateState` retains its atomic temp-write/rename. Failed collection writes explicit uncertainty so a prior cached healthy state cannot survive invisibly.
- **Feedback loops:** shedding prevents new spawns; it does not start retries, migrations, or swaps. The next successful scheduled collection overwrites uncertainty and reopens the gate from real headroom.

## 6. External surfaces

Codex agents may pause new background jobs and session spawns when capacity is exhausted or unknown. The existing quota-state file gains additive `codex-rollout` and `quotaUnknown` values. No endpoint, credential, network call, URL, or operator action is added; rollout reads are local and read-only.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local by design.** A rollout describes the Codex account/config home available on that machine, and the global spawn brake controls that machine’s work. Subscription-pool quota continues its separate replicated metadata path. This feature emits no direct user notice, holds only the existing per-machine quota-state file, does not strand topic state, and generates no URLs.

## 8. Rollback cost

Pure code and additive-state rollback. Older readers ignore the extra fields/source at runtime only after code rollback; deleting the optional quota-state file is not required because the collector will replace it. No database migration or credential repair exists.

## Conclusion

The change closes the last solo-Codex fail-open path at the existing choke point. The design deliberately persists uncertainty rather than letting yesterday’s healthy headroom survive a broken reader. Claude authority/degradation behavior is explicitly regression-tested. Clear to ship after scoped gates and authoritative CI.

## Second-pass review

**Reviewer:** framework_guard_review

**First independent read: concern.** A corrupt quota-state file could return previously healthy cached Codex state, and a complete rollout without a valid capture timestamp was being stamped fresh. Both would let uncertainty masquerade as headroom.

**Resolution:** Codex now clears cached state on corrupt/stale file reads while Claude preserves last-known-good behavior. Collector authority additionally requires a finite capture timestamp no older than the configured freshness window and no more than five minutes in the future; otherwise it persists `quotaUnknown`. Adversarial unit tests cover cached-healthy → corrupt and missing-timestamp → deny. Revised concurrence recorded below.

**Final independent read: concur.** Fail-safe cache and timestamp handling are correct, Claude behavior is preserved, boot wiring is sound, and the reviewer’s focused suite passed 75/75.

## Evidence pointers

- `tests/unit/codex-quota-load-shed.test.ts`
- `tests/unit/quota-tracker.test.ts`
- `tests/unit/quota-tracker-pool-aware.test.ts`
- `tests/unit/quota-collector.test.ts`
- `tests/integration/codex-quota-load-shed.integration.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect and no self-triggered controller — not applicable.
