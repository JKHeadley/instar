# Jev-first merge verification repair

## Summary
Tier 1: a narrow reversible registry repair after merging current main into PR 2795. One registry entry plus an ELI16 and this review. One independent review pass; one successful main-merge commit gate. Repair gate results recorded below. No runtime TypeScript edits, new enablement, or authority changes.

## 1. Over-block
No new message or action rejection. Existing coverage correctly rejected the missing feature registration. The zero-wrong quality requirement conservatively prevents unsupported promotion.

## 2. Under-block
A ladder entry alone cannot establish commitment accuracy. Tracking remains needed because the previous replay failed. Real calls and independent outcome grades are both required; promotion also requires code review and removal of the existing shadow clamp on evidence.

## 3. Level-of-abstraction fit
Feature rollout metadata belongs in src/data/feature-ladders.json. Existing MaturationLadder and JevFirstCommitment own rollout reporting and runtime posture respectively.

## 4. Signal vs authority compliance
Reference: docs/signal-vs-authority.md. No new block/allow surface. This registers evidence requirements; it grants Jev no new decision authority.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. Registry thresholds describe evidence for human/code review, not a replacement judgment or automatic deployment.

## 5. Interactions
The existing derived coverage test sees the flag. dryRunDefault conservatively describes supported enabled shadow/live operation under the factory's live-to-shadow clamp. It is rollout metadata, not proof of exact runtime stage; enabled:true with stage:off still reports dry-run in the existing generic reader. Both advancement paths require code. No duplicate calls, mutable shared state, retries, or lifecycle changes.

## 6. External surfaces
The ladder status gains one feature. No runtime config, provider request, conversation, secret, fleet enablement, or operator action changes. No new operator-facing actions.

## 6b. Operator-surface quality
No operator surface — not applicable.

## 7. Multi-machine posture
Replicated as shipped package metadata on every installation of the release. Evidence remains machine-local BY DESIGN because calls and grades describe observations on that machine. This repair adds no notices, durable state, generated URLs, or status/health route. No topic-transfer state can strand.

## 8. Rollback cost
Revert the registry and documentation commit. No migration or agent state repair.

## Class-Closure Declaration
No agent-authored-artifact defect — not applicable: this repairs missing rollout registration rather than a prompt, hook, config, skill, standards text, or self-triggered controller. Existing tests/unit/feature-ladders-coverage.test.ts structurally catches future missing registrations.

## Validation
Before: feature-ladders coverage failed solely for intelligence.jevFirstCommitment (6 passed, 1 failed). Full build and tsc pass after merging main eaf43103f7580efc029c761297bd7b33cf86adf4; the historical compiler failure does not reproduce against current main. After: coverage/gateway/recovery tests: 19 passed; ladder core/service and Jev awareness tests: 76 passed; summary-route integration tests: 2 passed. Full unit run still in progress; sandbox process inspection and writes outside the workspace are already producing unrelated failures. No claim of a passing full suite.

## Second-pass review
Reviewer: review_jev_repair (independent build reviewer). Concur with the review: no runtime authority changes, no fleet enablement, both promotion rungs require code, and quality evidence remains missing. Reporting caveat about stage:off is documented above.
