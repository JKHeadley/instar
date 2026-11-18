# Old computers are kept out of charge once you set up your phone

<!-- bump: patch -->

## What Changed

Groundwork for the identity and security plan. Nothing changes yet. Once you set up your phone for approvals, if one of your agent's computers runs an older version of Instar, the agent pauses risky actions on all of them until that computer is updated or removed. It doesn't send that computer new work or secrets, and it doesn't leave it in charge.

## What to Tell Your User

- **Safety with mixed versions**: "Nothing changes for you now. Later, if one of your computers falls behind on versions after you set up your phone, I'll pause risky actions and tell you which computer to update."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Mixed-version hold | `GET /owner-record` → `gate.reason` |

## Evidence

- Unit: `tests/unit/identity-piece2d-fence-lease-routing.test.ts`, plus a dispatcher case in `tests/unit/MeshRpc.test.ts`.
