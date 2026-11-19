# Groundwork: one signed record of who owns the agent

<!-- bump: patch -->

## What Changed

Internal groundwork for the identity and security plan. This adds the code that reads a signed owner record, a list of signed entries saying which keys speak for the owner, and works out the same answer on every machine. Nothing uses it yet, so nothing changes for you.

## What to Tell Your User

- **Owner record groundwork**: "Nothing changes for you yet; this is the foundation for a signed record of who owns your agent, shared by all your machines."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| (none yet) | The owner record is used from the next step on |

## Evidence

- Unit: `tests/unit/identity-piece2a-owner-record.test.ts`.
