# Side-Effects Review — E2E-Pairing Pre-Commit Gate

**Source:** Cherry-pick from GSD-Instar spike (Tier-3 "feature is alive" finding)
**Author:** Echo · autonomous run · 2026-05-23

## 1. Over-block
Could block legitimate server refactors / type-only changes that genuinely need no new e2e test. Mitigations: (a) `E2E-PAIRING: EXEMPT — <reason>` marker, (b) `INSTAR_SKIP_E2E_PAIRING=1` env bypass. Both are documented in the block message itself.

## 2. Under-block
Could pass a commit that stages a trivial/empty e2e test just to satisfy the gate. Accepted: the gate enforces PRESENCE, not quality. Quality is the reviewer's job + the existing CI E2E run. Presence-enforcement alone closes the "forgot the e2e test entirely" gap, which is the actual failure mode.

## 3. Level-of-abstraction fit
Pre-commit gate alongside check-rule3-coverage.cjs, protect-migration-guarantee.js, instar-dev-precommit.js. Same layer (instar dev discipline), same .husky/pre-commit wiring, same read-only-staged-diff pattern.

## 4. Signal-vs-authority compliance
This is a SIGNAL with commit-time authority (it blocks). Per signal-vs-authority: brittle low-context filters should only block when the defended-against failure is corruption-class and the false-positive cost is low. A route shipped without an e2e test silently 503s in prod (corruption-class); the false-positive cost is one comment marker or one env var (low). The two escape hatches keep the human/agent as the final authority. Compliant.

## 5. Cross-feature interactions
- Runs last in .husky/pre-commit, after lint + instar-dev-precommit + rule3 + migration-guarantee. Independent — reads staged diff, no shared state.
- Does not interact with CI (CI runs the actual E2E suite; this gate just enforces a test FILE is staged).
- Edge: a commit that splits a feature across two commits (server in commit 1, e2e test in commit 2) would block commit 1. Mitigation: the EXEMPT marker or env bypass for the intermediate commit; or stage both together. This is a deliberate nudge toward atomic feature commits.

## 6. Rollback cost
Trivial. One script + one line in .husky/pre-commit + one test file. Revert the commit; the gate stops running.

## 7. Migration parity
N/A — this is an instar-dev-repo gate (`.husky/pre-commit`), NOT an agent-installed file. It ships with the source repo and governs instar contributors' commits. Agents never receive `.husky/` hooks. No PostUpdateMigrator entry needed.

## Conclusion
Ship. Structurally enforces the Tier-3 discipline the spike identified as most-forgotten. Two escape hatches prevent tyranny. Trivial rollback. Seven-dimension review clean.
