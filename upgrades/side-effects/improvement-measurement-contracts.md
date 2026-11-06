# Side-Effects Review — recorded improvement contracts

**Version / slug:** improvement-measurement-contracts
**Date:** 2026-11-05
**Author:** Echo
**Second-pass reviewer:** review_history (independent build review)

## Summary of the change

Optional outcome/owner/method/version/quality and baseline-reference metadata extends the existing MaturationEvaluationContract and LadderRung. A shared pure validator keeps source-scanned and dynamic ladder contracts compatible without applying the scanner allowlist to ladder projections. Existing BlockerLifecycleLedger exact/latest indexed reads corroborate values; no database/schema write change. Existing summary gains scoped declared-contract counts and a bounded single-feature detail query, including pool reads. Scanner errors survive both legacy and accounting reconciliation and remain invalid, rather than becoming missing.

Tier1: reversible optional metadata and bounded read projection, no durable migration or new effect authority. One design review and two code repair rounds plus a focused closing verification were needed to close source/freshness and reconciliation gaps. First commit attempt caught a missing frozen carrier excerpt; registered CMT-001 on the active machine and generated its checked-in registry snapshot. No enforcement bypass. Actual staged size is recorded by the trace/gate.

## Decision-point inventory

No new effect, session, promotion or ordinary-service authority. Existing contract schema validation rejects malformed opted-in metadata. The new peer-read validator excludes malformed proof from the combined read and reports failure. Existing D7 threshold scoring remains advisory as before; numerical corroboration is not an automatic improvement verdict or a new promotion floor.

## 1. Over-block

Old contracts without metadata serialize/hash unchanged and old peers work on default reads. Explicit new detail queries disclose unsupported peers. A same-time source tie is unavailable rather than selecting an arbitrary row. Source/spec mistakes can invalidate the opted-in contract and hold its existing readiness evaluation, while ordinary services continue.

## 2. Under-block

Shape does not establish that an intended outcome is meaningful, that its named owner is a verified principal, or that a source author correctly versioned changed semantics. Those remain accountable review duties. Numeric proof does not establish causation, statistical significance or a globally improved outcome. Missing/pruned corroboration is unavailable even though a declared snapshot remains in the contract. Universal inventory coverage, the missing-baseline promotion floor and the visual end-to-end proof remain explicit work in topic139374, not claims of this patch. <!-- tracked: topic-139374 -->

## 3. Level-of-abstraction fit

Same contract, store, scorer and route owners. The new pure module holds metadata shape and arithmetic, not state. No parent graph is added: Initiative parentProjectId, accounting ownerFeatureId and ladder composedInto remain the hierarchy. Metadata can be authored on the existing ladder/spec source; no duplicate registry.

## 4. Signal vs authority compliance

Required reference: docs/signal-vs-authority.md. No brittle semantic block/allow authority. Source/ref/version equality, exact sample/value matches, chronology and freshness are enumerable facts. The review's model judges improvement and corrective action under existing authority. Peer validation is a read-data boundary, not an ordinary service interruption.

## 4b. Judgment-point check

No static threshold substitutes for weighing competing quality signals. Criterion results and deltas are exposed individually; no global better/worse decision is manufactured.

## 5. Interactions

Baseline reads bypass the globally capped8192 recent-row query; latest reads cannot select an older compatible source after a newer incompatible row. Equal-time source ties explicitly fail to corroborate. Baseline and current sample floors both apply. A contract metadata change changes the existing hash/soak; legacy absence adds no serialized field. Invalid scanner errors persist even when the contract itself was omitted, and clear when the source is repaired. Detail requests re-read instead of using the ordinary60s peer cache; receiving-time validation rejects future or stale claimed proof. Read exceptions become explicit unavailable evidence, never a zero or an improvement.

## 6. External surfaces

Additive fields on existing summary and optional feature detail. Text is bounded plain metadata, not executable instructions. No raw messages, secrets or new credentials are added. Detail is limited to16 metrics and32KiB; the existing512KiB peer and4MiB pool caps remain. Default counts are tiny and scoped, not a claim that all features/jobs/decisions were independently enumerated.

## 6b. Operator-surface quality

The operator asks for an outcome/baseline conversationally; no shell/config workflow is introduced. This patch supplies evidence to existing readers. A chart or human intelligibility test is not claimed here. Descriptions need the existing surface's escaping when rendered.

## 7. Multi-machine posture

Proxied-on-read through the existing pool envelope. Observations stay origin-local; a baseline from a different origin is explicit foreign-origin evidence, never silently merged. Peer detail validates expected origin and exact requested subject. No replication path, notification loop, machine-local new state or generated URL is added.

## 8. Rollback cost

Revert additive code; no database migration or repair. Existing JSON metadata is optional. An already-authored outcome may continue to alter the old generic contract hash until removed from its source; ordinary services are unaffected.

## Independent review and checks

Design review checked six lenses and found current selection/freshness, exact unique baseline coverage and ladder/scanner source separation gaps; repaired. Code review found source ties, future peer evidence and invalid-to-missing propagation; repaired. Author also closed the peer-cache freshness window and validates arithmetic/sample floors at the read boundary. Final focused unit checks101 pass; real-route/pool integration13 pass; full npm lint including typecheck passes. Independent closing reviewer concurs below.

## simplestRobustRoute

Add optional descriptive contract metadata, verify it against the existing store and expose it through the existing authenticated read. Preserve declared-vs-corroborated, quality-vs-activity and source/version boundaries. No new background machinery is needed. This is a bounded read proof, not an unattended improvement outcome claim.

## Final independent disposition — review_history

Concur after inspecting the final three repairs. Reconciliation now carries the artifact's contract and parse-error state into both rollout and accounting on same-stage updates, advances and regressions before returning. A validated ladder override clears the superseded scanner error on both contract locations. Explicit feature-detail pool requests bypass cache reuse and cache writes, preserving freshness without retaining unused detail summaries. No remaining correctness issue identified within these three repairs. The author's reported focused reconciler and ladder-service results were not rerun by this reviewer.
