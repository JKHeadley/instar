# Round 17 — adversarial and lessons-aware final design pass

Independently recomputed reviewable-body SHA-256: `9294f4b98380ebfb6727a408530ea66092e9710d0971e46a82a67ad7347ca5b5`, unchanged from round 16. Re-read the current N1–N10 contract and operator metrics/lifecycle table against the previously reviewed binding, browser and retention obligations. Two perspectives from the same reviewer.

## ADVERSARIAL

**DESIGN: 0. PRECISION: 0 new.**

Final targeted counterexamples: fake ordinary reference reaching the special sender, changing notice variants after claim, taking over a timed-out owner, letting a paced queue outlive policy authority, replaying after an unknown send or restart, and counting archived/retried records twice. The current contract explicitly rejects each: private exclusive permit consumer with behavioral bypass tests; one sealed child and allowed finite variant selection; no-reclaim process-incarnation permit; dequeue-time validated projection; one attempt and unknown holds; idempotent transactional aggregate updates with archive invariance. No concrete remaining design defect found.

Browser activation remains blocked at the first unsupported build or failed principal/receipt proof. The two-build threshold changes migration behavior, not authorization to send with an incompatible client. The completed feasibility spike does not substitute for authenticated production receipt proof.

## LESSONS-AWARE

**DESIGN: 0. PRECISION: 0 new.**

P19/P22 require the bounded read-only broker recovery plus persistent latch/brake before escalation; no failed write can start an unbounded restart loop. P23 preserves coalesced authorized operator-hub notices. P20 and Observability retain positive runtime controls, real receipt evidence, explicit stale/unavailable metrics and honest restart state. Audit archives and unavailable-shard coverage prevent silent history loss from becoming a misleading complete answer. The activation matrix still requires actual production wiring and all three testing tiers; approval remains permission to build rather than runtime compliance.

## Independent review-evidence check

Conformance round 17 reports 90 standards checked, zero findings, not degraded. Read `external-round-17-delta.json` and both actual round-16 external result files. Both prior runs succeeded with `promptTruncated:false`; GPT explicitly declared 0 DESIGN/3 PRECISION, Claude 0 DESIGN/2 PRECISION. The delta artifact names the identical body hash and skips unchanged bodies; it does not claim fresh external model calls or erase their precision findings. No external call was launched here, and no external finding was reclassified.

Combined internal findings: **0 DESIGN, 0 new PRECISION**. No source/spec/runtime edits or external messages performed. Storage implementation can proceed when assigned; runtime completion and activation are not claimed by this design review.
