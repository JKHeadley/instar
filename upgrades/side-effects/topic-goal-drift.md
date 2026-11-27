# Side-effects review: topic goal drift

## Summary
Tier 1, SMALL: reversible context/prompt bug fix and optional-service wording; no schema or authority expansion. Fresh worktree off origin/main 8d81ecb24, version 1.3.1719. 15 files, approximately 400 added lines including regression tests and case-study/review documentation. Final exact size and attempt counts are recorded in the PR and build summary. One independent review round, iterated on concrete findings.

## 1. Over-block
A topic can contain an older completed phase or an explicitly narrowed user request. The model must resolve relevance, honor user scope changes, and allow a completed milestone with a leading partial report. Missing goal state does not create guessed requirements. Registered conditions remain mandatory even for partial reports.

## 2. Under-block
Extraction can miss goals; summaries are not verbatim user instructions. Model judgment can still err. Missing/omitted state is surfaced rather than treated as full scope. This adds no false guarantee of semantic correctness.

## 3. Level-of-abstraction fit
Scope comparison belongs in the existing CompletionEvaluator, supplied from server state; not a keyword matcher. The helper selects and bounds evidence only.

## 4. Signal vs authority compliance
Per docs/signal-vs-authority.md, topic context is a signal consumed by the existing smart completion authority. No new deterministic block/allow path.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. Attribution, data bounding and transport validation are structural; scope/relevance remains LLM judgment.

## 5. Interactions
Existing scope-accretion, live-proof veto and condition-divergence controls remain in order. Client topicGoalContext is dropped by the transport whitelist. Context is re-read for each evaluation. No background loop, retries, duplicate notices or shared-state mutation added. Goal retrieval and initiative listing use current existing stores.

## 6. External surfaces
Registration gains an additive context field. Completion receives extra model input and provenance stores its hash/size only. Jev's benefit explicitly calls it optional; the offer-text hash changes, so new acceptance records bind to the clarified wording. No service is enabled and no terms/payment/account action is performed. No new operator action or URL.

## 6b. Operator-surface quality
No operator surface markup/form changes. Existing catalog benefit copy becomes clearer.

## 7. Multi-machine posture
Machine-local BY DESIGN for retrieved evidence: topic-intent reflects the history captured on that machine. Existing topic intent has no new replication mechanism here. Linked initiatives use the existing tracker read. A transferred run with no local goal is explicitly marked unavailable to the model, which must limit its completion claim to the run or obtain evidence of wider user scope. This is not represented as pool-complete state. No durable new state, notifications, URLs, status/health/capability verdicts or one-voice emissions are added. Tests cover an empty local store. No silent assumption that missing state means no wider goal.

## 8. Rollback cost
Revert and release a patch. No migration or stored-record cleanup. The changed catalog wording can be reverted; accepted choices retain their existing audit records.

## Conclusion
The defect is missing scope context at the existing authority, plus misleading completion framing. The fix supplies that context without promoting extracted summaries to user instructions or allowing honest partial reports to excuse unfinished registered work.

## Second-pass review
Reviewer: goal_drift_review. Independent read: concur. Evidence polarity, the mandatory registered-condition floor, total input bounds, and fallback delimiter injection were fixed and covered. The existing LLM remains the scope authority, with explicit local-source degradation.

## Class-Closure Declaration
`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: {enforcementType: ratchet, citation: tests/integration/topic-goal-completion.test.ts, howCaught: the incident-shaped narrow charter must deliver the broader user goal to the existing completion authority; forged replacements are dropped and tests fail if the context is missing}`. This guards missing evidence wiring; it does not claim a deterministic guarantee about model accuracy.

## Semantic replay evidence
A live Claude capable-tier replay through CompletionEvaluator rejected the hidden-gap incident (NOT_MET), accepted a completed Jev/Tailscale milestone with a leading remaining-work disclosure (MET), and rejected an unfinished nine-service condition even with a partial report (NOT_MET). Unit/HTTP/lifecycle tests test wiring and protocol, not model accuracy. Three examples are evidence, not a guarantee across every model.
