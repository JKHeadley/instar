# An organization sees its work agents, can mark someone as gone, and can name a second policy keeper

<!-- bump: patch -->

## What Changed

The admin of an organization now sees a Work agents list in the Instar app. It shows each joined agent, its person, the policy version it runs, and when it last checked in. Joined agents check in once a day with their daily update check, signed with their own key. A new agent can appear only by using an invitation link the admin made, and links can be cancelled. The admin can mark someone as gone. That person's app then asks them once whether to remove the organization's policy; nothing is removed without their tap. The admin can add up to three policy keepers. A keeper proposes new versions, and the organization's agent checks each one and signs it with the organization key, so members still trust only one key. A keeper can tighten the policy but never loosen the limits. Members who joined before this version check in only after allowing it once in the app.

## What to Tell Your User

- **Work agents**: "If you publish your organization's policy, the Organization tab now lists each colleague's agent, which version it runs and when it last checked in."
- **Second keeper**: "You can add a second person who can update the policy. Ask them for their keeper code, and read the key code back to them before adding it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Work agents list | Organization tab in the Instar app; `GET /org/members` |
| Mark as gone / restore | Organization tab |
| Policy keepers | Organization tab: paste a keeper's code |

## Evidence

- Unit: `tests/unit/org-members.test.ts`, `tests/unit/org-keepers.test.ts`.
- Integration: `tests/integration/org-members-and-keepers.test.ts`.
- E2E: `tests/e2e/org-members-and-keepers-alive.test.ts`.
