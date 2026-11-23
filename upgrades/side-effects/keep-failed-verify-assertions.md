# Side-Effects Review

## Summary
Tier 1, SMALL. This reversible fix retains diagnostic evidence from failed test runs. It does not change test results or merge requirements.

## Decision Points
Only diagnostic retention changes. Verification decisions remain unchanged.

## Over-block
There is no block or allow decision.

## Under-block
If capturing or storing evidence fails, a metadata event reports that failure. The original test verdict remains unchanged.

## Layer
The existing verifier orchestrator captures evidence before raw reports are cleaned up.

## Signal versus Authority
This change produces diagnostic data and holds no blocking authority. See docs/signal-vs-authority.md.

## Judgment
No static heuristic is added at a competing-signals decision point.

## Interactions
Successfully parsed lane and solo-run details are copied before mutable reports or cleanup discards them. Unavailable reports remain unavailable. The existing retention policy keeps three failed checkouts; its corrupt-registry exception remains unchanged.

## External Surfaces
One private JSON file is retained, limited to 64 KiB in UTF-8. Omitted evidence is disclosed. No HTTP or peer schema changes are introduced.

## Multi-Machine Posture
The evidence stays on the machine that ran the tests. No replicated state or duplicate notices are added.

## Rollback
Revert the change. Existing artifacts are diagnostic only and expire with retained-checkout cleanup. No migration is required.

## Conclusion
One independent review pass concurred. Targeted checks: 137 tests passed. All three full Local Verify groups passed for 07d2a1f0dc742e98bc37e0b63e98ed544b7c9c53. This metadata correction still follows the normal verification gate.

## Second-pass review

**Reviewer:** Codex independent reviewer `/root/retain_failure_evidence`. The reviewer completed the source review and concurred after the capture-exception and truncation findings were fixed.

Concur with the review. Successfully parsed failures are preserved before cleanup, the artifact is bounded to64 KiB in UTF-8, private exclusive creation avoids following an existing file or symlink, and diagnostic failures preserve the test verdict. Existing checkout retention owns eviction, including its documented corrupt-registry exception.

## Class Closure
No agent-authored prompt, config, hook, or skill artifact defect is fixed; not applicable.

Review evidence: independent code review concurred;137targeted tests passed; complete LocalVerify validation remains pending.
