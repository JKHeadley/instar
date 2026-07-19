---
change_type: fix
---

<!-- internal-only -->

## What Changed

- Persisted stable work-item identity in generated Instar development traces.
- Bound decision evidence to the staged change's matching trace before reading identity or tier, with a compatibility fallback for legacy traces.
- Added regressions for missing generated identity and a newer foreign `unknown` trace competing with the correct trace.

## Evidence

- Feedback: `fb-2b24aa04-540`
- Test: `tests/unit/instar-dev-precommit-audit-staging.test.ts`
- Test: `tests/unit/write-trace-tier.test.ts`
