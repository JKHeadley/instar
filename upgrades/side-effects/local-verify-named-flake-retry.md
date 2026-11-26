# Local Verify named flake retry

## Behavior and authority

Local Verify may retry up to three named failed assertions per verification when the machine's setting is enabled. The rerun uses the same composed checkout and isolated output. Multi-test files must also pass a whole-file run with exactly the original test names and outcomes, except for the failures that must become passes. Malformed reports, unreadable quarantine, and repeated quarantined assertions keep the original failure in effect. The existing verdict evaluator and signed record still decide whether a run passes.

## State and rollback

The setting defaults off and is read at launch. Turn it off to restore the existing retry policy for new runs without restarting. Existing history files remain readable. The optional named history records same-machine observations, expires a quarantine after seven days, and never removes a test from the suite. The audit identifies Scaling the Test Line as the project responsible for triage.

## Second-pass review

**Reviewer:** peer_gate_design_review, independent source review.

Concur with the revised proof and quarantine reader. The whole-file proof enforces original names and expected outcomes. Strict reports, the signed name cap, and a fail-closed quarantine reader preserve the existing verdict authority.
