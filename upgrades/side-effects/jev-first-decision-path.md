# Side-Effects Review — Jev-first decision path

**Version / slug:** `jev-first-decision-path`
**Date:** 2026-11-03
**Author:** Echo
**Second-pass reviewer:** independent reviewer agent

## Summary of the change

`JevFirstDecision` adds a bounded, auditable yes/no first pass with the incumbent model as fallback. The first caller is `CommitmentSentinel`, shadow-only on development agents and off on the fleet. `GET /jev-first/summary` exposes observed calls and settlement counts; scaffold and migration awareness explain the feature. The review job reads the measured surface. No new Jev verdict acts until a separately measured live promotion.

Declared Tier 1: the new caller is clamped to shadow, the route is read-only, and a revert restores the previous behavior. The initial staged change spanned 28 files and about 1,300 added lines, including tests and reproducible research notes. It had one independent side-effects review and one corrective pass. The first commit gate caught two direct test cleanups; the second passed. The full suite then caught a missing non-Claude awareness marker. The follow-up commit's first gate attempt required the ELI16 overview to be restaged; this update includes it.

A later full-suite lint pass found four optional-telemetry catches whose intended fallback needed explicit markers; those markers now make the existing behavior auditable. The shared contract also now states the current one-question limit accurately. A time-bounded PromptGate incident count was added to the research inventory so provider circuit shedding is not mistaken for machine pressure.

## Decision-point inventory

- `CommitmentSentinel.detectCommitments` — modified — Jev may say whether a batch has any qualifying promise; only a confident negative can eventually skip detailed extraction. The incumbent remains the authority in shadow, audit, uncertainty, outage, missing-key, and oversized-context cases.
- `JevFirstDecision.decide` — added — handles per-point confidence bands, declared settlement direction, fallback, and local decision record.
- `/jev-first/summary` — added — read-only observed rollup, with token savings null until a comparable baseline exists.

## 1. Over-block

No user message is blocked by this change. A future live false negative could suppress registration of an agent promise; the current stage is shadow, and live promotion requires a held-out batch replay. The first fresh pair replay missed its precision bar, so this point is not promoted.

## 2. Under-block

The current incumbent may still miss a promise, and the Jev question cannot extract promise type or exact text. A Jev positive always reaches the incumbent. The pair replay's two labels disagreed on 88 of 151 items, so its consensus score alone is not an adequate live gate. A secret scrub that cannot safely retain full context routes to the incumbent; it may leave the original incumbent's own transport/privacy behavior unchanged.

## 3. Level-of-abstraction fit

The gateway is a shared model-call primitive, not a second independent commitment authority. It sits inside the existing sentinel's extraction path. The sentinel owns the final detected commitment and tracker write. Feature metrics and provenance use existing ledgers.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).

- [x] Yes — the proposed future shortcut is a model judgment over the same bounded conversation batch; there is no regex or brittle detector given blocking authority.

In shadow, Jev is only a measured signal. In live, the registered point may authorize one direction only after a point-specific replay bar; uncertain and uncovered cases go to the incumbent.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The confidence thresholds are declared floors around a model judgment and are not treated as truth without held-out validation.

## 5. Interactions

- Shadowing: the Jev call precedes the incumbent, but shadow always calls the incumbent and preserves its verdict.
- Promotion: the commitment factory clamps a requested live stage to shadow while its held-out bar remains unmet, so a config typo cannot grant Jev settlement authority.
- Double-fire: only the incumbent extracts and registers promises; Jev never writes the tracker.
- Races: the sentinel's existing `isScanning` guard still serializes scans. The live stage is read from live config per scan, so a rollback does not require server restart.
- Feedback: observed comparisons can guide threshold tuning, but no automatic threshold changes are introduced.

## 6. External surfaces

Jev receives secret-scrubbed bounded conversation text in shadow on development agents with a key. This adds calls and some latency to that agent's periodic promise scan. New records go to the local judgment provenance and feature-metrics ledgers. The HTTP summary serves aggregate counts only; full content is not served there. No operator action or mobile form is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local by design:** decision context and call metrics describe the machine that made the model call. The summary is local, not a falsely merged pool figure. Commitment registration retains its existing owner behavior; this change emits no user-facing notice, stores no new topic-transfer state, and generates no URLs.

## 8. Rollback cost

Set `intelligence.jevFirstCommitment.enabled` to `false` to return immediately to the incumbent on Echo. A code revert removes the route and gateway. Existing local audit rows can remain; there is no schema or tracker migration and no fleet behavior change while dark.

## Conclusion

The shared path is ready for shadow measurement. The reviewer found that an accepted provenance ID was only buffered, so this change now waits for the append and falls back if it fails; the persisted row also names its prompt version and outcome-grading gap. The CommitmentSentinel replay has not passed its quality bar, so live settlement remains off. A later promotion needs a better independently labeled batch corpus and a task-matched fallback benchmark or an explicit incumbent-retention justification.

## Second-pass review (required)

**Reviewer:** independent reviewer agent
**Independent read of the artifact:** Concur with shadow release after review. The first pass found three gaps: a buffered provenance row could fail after settlement, the persisted row lacked prompt version and a named grading gap, and the E2E exercised only the summary route. `recordDecisionFlushed`, persisted metadata, and the shared production factory plus E2E one-provider scan address them. A conservative fallback on an unrelated concurrent provenance error is acceptable. Final test execution remains required before ship.

## Evidence pointers

- `docs/research/jev/jev-first-inventory.md`
- Local private replay output (not committed because it contains user conversations); aggregate figures are in `docs/research/jev/jev-first-inventory.md`
- `tests/unit/JevFirstDecision.test.ts`, `tests/unit/CommitmentSentinel.test.ts`
- `tests/integration/jev-first-summary-routes.test.ts`, `tests/e2e/decision-quality-alive.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed. The existing sentinel's timer, tracker write, and retry behavior are unchanged; this adds a model first pass inside one scan rather than a new self-triggered controller. Not applicable.
