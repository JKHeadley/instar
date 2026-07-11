# Side-Effects Review — Codex quota and framework-safe pool selection

**Version / slug:** `codex-quota-framework-safe`
**Date:** 2026-07-10
**Author:** Instar-codey
**Second-pass reviewer:** framework_guard_review

## Summary of the change

`QuotaPoller` now reuses the existing Codex rollout reader for OpenAI/Codex accounts and persists five-hour/weekly `AccountQuotaSnapshot` values. `QuotaAwareScheduler`, `poolHeadroom`, `ProactiveSwapMonitor`, and `SwapAntiThrashEngine` constrain candidates to the source session/account framework. Server wiring supplies the active framework where available. Snapshot replication, awareness/migration, and three test tiers are updated.

## Decision-point inventory

- Codex quota poll eligibility — modify — Codex/OpenAI joins the existing supported-account set.
- Account placement/headroom selection — modify — optional session-framework constraint filters candidates.
- Reactive/proactive swap target selection — modify — source framework is carried or derived and cross-framework targets are refused.

## 1. Over-block

A pool with spare quota only in a different framework is now correctly treated as having no usable alternate for the current session. That is intentional: those credentials cannot execute the session. An unknown source framework fails closed before selection.

## 2. Under-block

A Codex account has no new snapshot until at least one rollout contains a rate-limit event. It remains degraded/unknown rather than fabricated. A malformed or unreadable rollout produces no snapshot and retries on the next cadence. When an idle account's latest event predates a known window reset, that expired window becomes 0% so an old 99% reading cannot strand it forever. The snapshot retains the rollout's original capture time, so another non-expired window never masquerades as freshly measured; proactive optimization remains conservative while reactive rescue can use the deterministic reset boundary.

## 3. Level-of-abstraction fit

The poller owns normalized quota snapshots and calls the existing provider reader rather than parsing rollouts itself. The pure scheduler and anti-thrash selection layers own framework compatibility, ensuring every caller inherits the same guard.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this is a hard credential-compatibility invariant, not conversational judgment.

Provider/framework types are enumerated structural facts. Cross-framework execution is invalid, so deterministic filtering is the correct authority.

## 5. Interactions

- **Shadowing:** framework filtering composes before quota scoring; an incompatible account never influences rank.
- **Double-fire:** Codex and Claude poll branches are mutually exclusive by provider/framework pair.
- **Races:** the existing pool update persistence and poll cadence are unchanged.
- **Feedback loops:** proactive selection and execute-time revalidation both enforce framework compatibility, so a stale intent cannot bypass the guard.

## 6. External surfaces

Users see accurate Codex quota in existing pool/quota surfaces. Automated swaps may now correctly report no matching alternate instead of attempting a foreign credential home. No new endpoint, external network call, URL, or approval surface is introduced; Codex reads local rollout data only.

## 6b. Operator-surface quality

No operator renderer/form change — not applicable.

## 7. Multi-machine posture

**Replicated.** Codex quota uses the existing subscription-account metadata projection and coherence-journal path; the validator now accepts `codex-rollout` provenance. Selection remains machine-local execution truth because credential homes are local, while redacted quota metadata follows the pool. No user notices, topic-transfer state, or generated URLs are added.

## 8. Rollback cost

Normal code rollback. Existing Codex snapshots are optional backward-compatible fields; older readers that reject the new provenance drop that optional projection rather than credentials. No credential writes or irreversible migrations occur.

## Conclusion

The two required halves ship together: Codex becomes quota-visible only after every selection and swap chokepoint is framework-safe. The independent review also forced unknown-framework fail-closed behavior and post-reset rollover normalization. Existing Claude-only behavior is explicitly regression-tested. Clear to ship after full gates and CI.

## Second-pass review

**Reviewer:** framework_guard_review

**Independent read: concur.** Concerns raised across two passes (unknown-framework fail-open, post-reset stale exhaustion, and mixed-window false freshness) were incorporated. The reviewer reran the focused unit/integration boundaries and confirmed the structural credential invariant now fails closed without falsifying snapshot freshness.

## Evidence pointers

- `tests/unit/quota-poller.test.ts`
- `tests/unit/quota-aware-scheduler.test.ts`
- `tests/unit/swap-antithrash-engine.test.ts`
- `tests/integration/quota-framework-safety.integration.test.ts`
- `tests/e2e/subscription-quota-lifecycle.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect and no new self-triggered controller — not applicable.
