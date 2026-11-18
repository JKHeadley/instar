# Side-effects review: locked-proof timing evidence

Date: 2026-11-17. Author: Instar Agent (echo). Tier 1, reversible proof-harness correction. Second-pass reviewer: parent /root. Independent source and test rereview concurs; no remaining blocker.

## Summary and decision-point inventory

The existing judge in scripts/locked-proof/lib.mjs now consumes a raw same-duty timing result instead of trusting extraEvidence fields. A shared beforeEnterTiming helper also supplies diagnostic measurements. The viewer in scripts/locked-proof/driver.mjs records identity and expiry from a successful approved exact-request GET. No native or product authorization path changes.

## 1. Over-block

Historical evidence without identity, creation time, finite interruption/expiry, or Enter is unmeasured. A genuine cancellation before Enter can therefore fail to prove its timing. This is intentional: absent Enter is not independent evidence that no dispatch occurred. Equal timestamp resolution can reject an actual before-dispatch interruption. No product access is blocked.

## 2. Under-block

Evidence remains trusted output of the isolated proof driver, not tamper-proof attestation. Interruption completion is the return of the awaited driver action, a conservative upper bound on the requested revoke or transport change; both start and completion must be finite and correctly ordered. It is not an exact OS-effect timestamp. Enter is the native pre-dispatch marker, not a keyboard event observation. A negative gap proves the awaited action completed before that marker; it does not claim successful cancellation or independently prove no submission. Existing outcome checks remain in force. A zero submission count is not used to recover missing timing.

## 3. Level-of-abstraction fit

Measurement lives in the harness. The existing judge is the sole authority for the bounded test verdict; diagnostic extraEvidence cannot override it.

## 4. Signal versus authority

The helper produces measured/unknown signals with explicit reasons; the existing deterministic proof judge consumes them. This enumerated timestamp invariant is appropriate under docs/signal-vs-authority.md. No message-routing or access authority added.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The invariant is a finite negative gap from one exact grant/duty; missing data is unknown.

## 5. Interactions

Shadowing: raw timing replaces the old optional-extra comparison. Double-fire: no new action. Races: asynchronous viewer receipts can leave identity unavailable, producing unmeasured rather than success. All observed Enter values for the duty must agree; an unrelated key cannot fill a gap. Feedback: none. Existing recovery still runs after every proof case.

## 6. External surfaces

Only proof evidence and verdicts change. No live sends, server restarts, new routes, credentials, persistent product stores, or operator actions. Approved GET response identity is captured without another API call.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine

Local-by-design proof runner reads the isolated test Mac's marker store and its approved viewer response. No machine registry, fleet state, tunnel, or sync changes.

## 8. Rollback cost

Revert this harness commit. No state migration, helper rebuild, or production restart. Existing evidence packs remain readable but may honestly fail the stricter timing check.

## Validation

Targeted proof-driver and timing regressions exercise all four cases, missing/non-finite/forged metrics, equality, wrong identity, multiple duties, conflicting timestamps, missing Enter with aborted+zero, exact approved GET receipt, and the actual runCase extraEvidence override boundary. Full verification belongs to Local Verify; no integration/E2E or live Mac execution by this implementer.

Validation after the completion-bound correction is recorded below. Second-pass concurrence is recorded below; the implementer writes a fresh Tier 1 trace before the authorized local commit.

## Conclusion

The bounded proof verdict now rejects unknown timing and actions that complete at or after Enter. No runtime safety authority changes. Historical evidence can honestly fail the stricter check; rollback is one harness revert.

## Second-pass review (if required)

Parent review found that action start alone did not establish completion before Enter. Corrected to require finite start <= completion < Enter for non-deadline actions; deadline uses the approved expiry. Parent independent rereview concurs with the completion bound after checking source and test changes; no remaining blocker. Parent owns push and PR.

## Evidence pointers

scripts/locked-proof/lib.mjs#beforeEnterTiming and #judge; scripts/locked-proof/driver.mjs#viewer; tests/unit/locked-proof-timing.test.ts; tests/unit/locked-proof-driver.test.ts; docs/builds/locked-proof-timing-evidence.md.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This repairs ordinary proof-runner logic, not an LLM prompt, hook, config, skill, standards text, or self-triggered production controller.

Final targeted validation after completion-bound correction: 92/92 tests passed across the two proof driver/timing unit files. git diff --check passed.

Required fast guards: all 30 files passed in six sequential batches of at most five files (802 passing tests). Batch logs: /tmp/topic138345-timing-guards-1.log through -6.log; manifest: /tmp/topic138345-timing-guards-summary.json. Main 0a7724de4 is an ancestor of the reviewed base.

## Final-retention boundary correction

Parent reproduced a false pass with valid historical timing but an empty final marker map, and independently concurred with the narrow correction. beforeEnterTiming now requires the exact final key/request/creation/Enter record in a terminal state. Missing, moved, mismatched or nonterminal final records remain unmeasured. This modifies only the existing measurement completeness check; no product authority, I/O, recovery, migration or external action is added. Valid retained terminal controls pass for all four cases. The four new regressions failed against the preceding commit before implementation, confirming the defect. Rollback remains a harness revert; historical packs without final retained evidence may now fail intentionally.

Final-retention validation: 96/96 targeted tests pass across driver and timing unit files; git diff --check passes. Logs: /tmp/topic138345-timing-retention-red.log and /tmp/topic138345-timing-retention-tests.log. Prior 30-file fast guards remain recorded; no broad rerun requested for this narrow correction.
