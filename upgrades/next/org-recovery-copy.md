# An organization can save a recovery copy of its policy key

<!-- bump: patch -->

## What Changed

The admin of an organization can now save a recovery copy: a file encrypted with six words that the app shows once. If the Mac that publishes the policy is lost for good, another agent can take over the same organization from it, and colleagues' agents keep their policy without joining again. Recovery is refused while the old address still serves the policy, and the person must confirm the old Mac is retired. Keepers and invitation links come back switched off, and work agents come back unconfirmed, until the admin confirms each one. The first version published after a recovery jumps by 1000, so colleagues never refuse it as old.

## What to Tell Your User

- **Recovery copy**: "Save a recovery copy of your organization from the Organization tab: a file plus six words to keep apart. If this Mac is ever lost, another agent can take over without colleagues joining again."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Save a recovery copy | Organization tab |
| Recover an organization | Organization tab on the new agent |

## Evidence

- Unit: `tests/unit/org-recovery.test.ts`. Integration: `tests/integration/org-recovery-copy.test.ts`.
