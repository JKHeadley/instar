# Old versions are kept out once you set up your phone

<!-- bump: patch -->

## What Changed

Groundwork for the identity and security plan. Each of your agent's computers now tells the others which version of Instar it runs, in a signed message. Nothing changes yet. Once you set up your phone to approve risky actions, a computer on an older version can't join, can't be rolled back to an older version, and doesn't get the ownership ledger. The agent tells you which computer to update.

## What to Tell Your User

- **Version check across your computers**: "Nothing changes for you now. Later, before you set up your phone for approvals, I'll make sure all your computers run a new enough version, and I'll tell you which one to update if not."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Version fence status | `GET /owner-record` → `fence` |

## Evidence

- Unit: `tests/unit/identity-piece2c-build-fence.test.ts`.
- Integration: `tests/integration/identity-piece2c-join-fence.test.ts`.
- E2E: `tests/e2e/identity-piece2b-owner-record-lifecycle.test.ts` (the build in every pull).
