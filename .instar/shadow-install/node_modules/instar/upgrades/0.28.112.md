# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Ships S-3 of Tier-3 from the self-healing remediator spec — the **commit-time** half of the promotion gate that pairs with the **PR-merge-time** half shipped in C-1 (PR #204).

A "proposal-derived runbook" is a runbook source file that the SystemReviewer's clustering pipeline (Tier-3 S-1, not yet shipped) emits when it spots a repeating failure pattern that warrants a new automated remediation. Those files carry two special markers: `__proposalDerivedFrom = '<proposalId>'` and `__producingAgentId = '<agentId>'`. Before this release, nothing checked those markers locally — the only enforcement happened in CI at PR review.

This release adds a second check at commit time, inside the `/instar-dev` skill's pre-commit hook:

- If you stage a runbook source under `src/remediation/runbooks/` that carries `__proposalDerivedFrom`, the hook reads the proposal JSON at `.instar/remediation/proposals-<machineId>/<proposalId>.json`, verifies the agent IDs match, and (if a signature and pubkey are present) verifies the Ed25519 signature.
- If anything is missing or mismatched, the commit is refused with a structured message pointing at the proposal pipeline as the responsible surface.
- Runbooks without the markers — every runbook on main today — pass through with no work.

This catches author mistakes before a PR is pushed. The CI gate (C-1) remains the authoritative check at PR-merge time because only CI can verify signing identity for the different-principal rule.

## What to Tell Your User

No behavior change for users. This is a developer-side guardrail that prevents a malformed runbook from being committed in the first place. The user-visible promotion flow (proposal review and approval via the dashboard or Telegram) still works the same way.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Commit-time promotion gate for proposal-derived runbooks | Automatic; runs inside `/instar-dev` pre-commit |
| `verify-proposal-derived-runbook.mjs` CLI | `node skills/instar-dev/scripts/verify-proposal-derived-runbook.mjs --files <csv>` |
