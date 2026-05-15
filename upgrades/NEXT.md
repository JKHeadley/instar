# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

### fix(release): pre-push gate now validates upgrade-guide well-formedness

`scripts/pre-push-gate.js` now imports `validateGuideContent` from
`scripts/upgrade-guide-validator.mjs` and runs it on the active upgrade
guide (NEXT.md or the versioned fallback). Same authority as the
publish-time `check-upgrade-guide.js`, just enforced one step earlier.

Before this fix, malformed release notes (inline code or camelCase
config keys in "What to Tell Your User", missing "## Evidence" when
fixes are claimed) passed pre-push, merged on main, and only failed at
publish-time — silently. Between 2026-05-13 and 2026-05-15 that pattern
stranded four PRs on main without reaching npm: the token-ledger Phase
1 (#112), the PromptGate token-burn fix (#226), and the entire
remediation track for over a day.

Test coverage: 4 new integration tests in `tests/unit/pre-push-gate.test.ts`
spawn the actual gate script against handcrafted malformed-NEXT.md fixtures
in a scratch directory and assert the right exit code + error text for
each shape, plus a well-formed control case that the gate must accept.

Spec: `docs/specs/pre-push-upgrade-guide-validation.md`. Side-effects
review: `upgrades/side-effects/pre-push-upgrade-guide-validation.md`.

## What to Tell Your User

**Releases stop failing silently.** Before today, a small wording issue
in a release notes file could quietly stop your agent from getting any
new code at all — the release just wouldn't ship to the package registry,
and nothing would alert anyone. This release moves the same check the
release pipeline already runs into the developer's push step, so the
issue is caught the moment the change is made instead of two days later
when someone notices the silence. Nothing changes from your side; this
is about how the developer running instar catches their own mistakes
before they reach you.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Pre-push upgrade-guide validation | automatic at git push time |

## Evidence

Four consecutive publish workflow runs failed silently between
2026-05-14 05:00 and 2026-05-15 16:00 against the following commits on
main: 529e0726, 97f90e4e, 79a2c0e8, 656360b5. All four were merged
through pre-push with malformed NEXT.md, then dropped by the publish
workflow's check-upgrade-guide.js step. No alert; the agent that needed
to react never did.

After this fix, the same malformed shapes are rejected at push time
with the same error message the publish workflow would have produced.
Verified by running the new integration tests:

```
npx vitest run tests/unit/pre-push-gate.test.ts
✓ tests/unit/pre-push-gate.test.ts (10 tests) 2798ms
  Test Files  1 passed (1)
       Tests  10 passed (10)
```

The three known publish-blocker shapes (inline code in WTTYU, camelCase
config in WTTYU, missing Evidence with fix-claim) are pinned by
dedicated integration tests that spawn the actual gate script.
