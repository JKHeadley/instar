# Side-effects review — retain upstream fixture isolation

## Summary

Documentation/release cleanup after merging current main9eb59f4fa. Main independently delivered the stronger isolated test using the actual template population and manifest. The merge keeps that version instead of the earlier measurement candidate's smaller synthetic population. The candidate's duplicate release fragment is removed; its review artifacts remain history. No production behavior or checker policy changes.

## Decision points

None changed. The same checker runs on the real source tree and an isolated copy of its actual declared population, then refuses an undeclared Python fixture.

## 1. Over-block

No new runtime refusal. The corrected test uses existing guarded cleanup for only its temporary directory.

## 2. Under-block

The actual population and manifest are exercised, preserving declaration/content-pin coverage. No weakened negative control, skipped test, source deletion exception or unavailable-source-as-zero behavior.

## 3. Level of abstraction

Keep the upstream-owned test once, rather than competing cleanup implementations or duplicate release claims.

## 4. Signal vs authority

Per docs/signal-vs-authority.md, no detector/authority changes. No hook bypass. Merge conflict was resolved explicitly to the source already on main.

## 5. Interactions

Original review artifacts remain in the repository for audit. Their ELI16 entry is marked historical; the old release fragment no longer claims a separate shipped fix. Other measurement release notes are unchanged.

## 6. External surfaces

Release text cleanup only; no new capability or user setup.

## 6b. Operator-surface quality

Avoids duplicate claims about the same test repair. The pending runtime still requires full verification and deployment before success is reported.

## 7. Multi-machine posture

No new state or transport. Each verifier uses its own existing temporary-storage path.

## 8. Rollback cost

Revert the documentation cleanup; no data/config/service repair. Restoring the duplicate release fragment would add redundant communication.

## Verification

After current-main merge:100targeted unit checks pass (FD-17,97console and2upstream fixture tests),6production-AgentServer E2E pass, and all51normal merge lints pass. The earlier full59514unit run had two coverage regressions, now repaired; it is not called green. Full verification remains pending.
