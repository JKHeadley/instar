<!-- bump: patch -->
<!-- internal-only -->

## What Changed

- Strengthened the unreachable messaging gate lint so it detects default-off `messaging.*` LiveConfig keys built from literal string concatenation.

## Evidence

- `npx vitest run tests/unit/lint-no-unreachable-messaging-gate.test.ts`
- `node scripts/lint-no-unreachable-messaging-gate.js`
