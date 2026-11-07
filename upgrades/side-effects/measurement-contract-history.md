# Side-effects review — retained measurement definitions

## Summary

Tier1 additive archive and retention increment in the existing BlockerLifecycleLedger. Closed definition snapshots, corroborated baseline reference pins, indexed bounded expiry, exact historical read metadata and collapsed method details on the existing numeric board. Revert stops using the sidecars; existing observation/evaluation tables and unique keys are not migrated. A conservative correction can retract a ready slot after archive failure; it never promotes or activates a capability.

## Decision-point inventory

Archive validation/capacity signals feed the existing advisory insufficient-evidence status. Ready retraction is a conservative correction of an unsupported record; no ordinary-service or promotion authority is added. Peer read validation remains data integrity, not semantic performance judgment.

## 1. Over-block

An archive fault or exhausted capacity can hold otherwise good measurements. A same-slot ready retraction remains held until a later evaluation slot; retrying INSERT OR IGNORE does not upgrade it. This sacrifices an advisory readiness claim rather than ordinary service availability. Unknown legacy definitions stay explicit gaps.

## 2. Under-block

A snapshot cannot establish that a method measures the intended outcome or that numeric change is causal improvement. Baseline retention cannot supply corroboration. Generic authoring, promotion/claim floors and live deployment/intelligibility remain original CMT-001 duties. <!-- tracked: CMT-001 --> A source changing semantics without changing its descriptor still requires accountable review.

## 3. Level of abstraction

Archive and pins live with the existing observation/evaluation owner; no new store, registry, scheduler or collector. The same contract hash and source/ref/descriptor identities are retained. Exact indexed pin joins preserve the complete metric/time collision set, not only a preferred row. Current contracts refresh established retention references even when new ambiguity prevents proof.

## 4. Signal vs authority

Per docs/signal-vs-authority.md, hash/shape/capacity checks express enumerable recording facts. The existing advisory scorer reports missing evidence. It cannot stop services, activate flags or declare improvement. No regex or semantic detector gains independent blocking authority.

## 4b. Judgment-point check

No global quality, improvement, causation or significance judgment. Historical policies are labelled under exact fingerprints, with first archived and last current sighting times. Those times are not fabricated original capture dates.

## 5. Interactions

Existing recurring evaluation archives before writing its current result. Full transaction includes pin work. Immutable body mismatch fails rather than overwrite. Global8192rows/64MiB and per-subject256versions are enforced by transactional insert triggers; exact existing versions may refresh at capacity. At most16pins/version, and version deletion waits for all pins to expire, so bounded cleanup cannot free capacity while orphaning pins. Existing90day pruning excludes active collision sets; versions/pins expire after180days without current use, at most1000deletes/table/pass. Current read overlay holds ready results if durable retraction fails; bounded history receives the same overlay. New archive setup failure does not close ordinary ledger access.

## 6. External surfaces

Optional exact contractVersions metadata on selected-origin measurement detail. Closed peer validator checks all requested current/history hashes, disjoint missing/omitted/unreadable/returned categories, full body hashes, timestamps and32KiB method budget. Older peers without snapshots remain explicit unknown history. Total124KiB builder budget reserves methods before fair numeric point allocation;128KiB route bound retained. No external notification added.

## 6b. Operator-surface quality

Collapsed Evaluation versions and method section shows current/historical definition labels, owner, method, cadence, evidence age, thresholds and sample floors. Missing/unreadable/omitted counts remain distinct. It states that an archive does not establish a baseline or improvement verdict. Normal text nodes render content literally; no untrusted HTML. Existing phone/desktop chart layout and question actions are retained.

## 7. Multi-machine posture

Machine-local ledger ownership by design, selected-origin proxied reads through existing peer credential allowlist. Definitions and pins cannot borrow another machine's baseline. No new notification or transfer authority. Full bodies contain the already-private typed measurement contract, no raw messages, prompts, credentials or observation payload expansion.

## 8. Rollback cost

Revert code; old code ignores unused additive tables/triggers. Existing records are not rewritten by setup. Conservative insufficient-evidence corrections are retained as truthful historical holds; a later ordinary evaluation can become ready. A rollback restores old90day retention, so active baseline preservation is no longer promised. No state repair or destructive migration is required.

## Verification and independent review

Required independent reviewer review_history concurred after closing collision-set retention, storage ceilings, same-slot ready retraction, active ambiguous pin refresh, orphan-free expiry and summary/detail read overlay. Added explicit summary assertion. Focused real SQLite tests cover immutable/durable definitions, closed shapes, proof-only pins, foreign/future/forged/tied/undersampled gaps,90/180day retention, capacity reuse, bounded reads and actual SQLite rejection triggers. Final48focusedunit pass, including the dual rejection triggers and localSummary assertion.19integration and3production-wiringE2E passed; additional exact v1/v2 archive route assertion is included in final integration rerun. Full lint passed; no full-suite or deployed claim.
