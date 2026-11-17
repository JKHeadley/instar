# Organizations can give every colleague's agent the same AI policy, by invitation

<!-- bump: patch -->

## What Changed

An agent's owner can now publish an organization's AI policy and invite colleagues. The agent drafts it in conversation (`POST /org/draft`: reads it back, places every line under Never, Ask first or Normally, and tries twenty everyday requests against it), and the owner publishes it by tapping in the Instar app (`/mobile/org/publish`, owner device only). An invitation link (`POST /org/invitations`) carries the whole signed policy in its fragment; instar.sh/join shows a colleague every line their agent will read, what the organization can and can't see, and a key code to check. The colleague joins by tapping in their app. Their agent then reads the rules at the start of every conversation ("Ask first" items as their own section, never as blocks), its independence is capped by the policy, and it checks daily for a newer version, holding any wording change until the colleague accepts it. Leaving restores what the cap changed. The session text now says honestly whether outgoing messages are checked.

## What to Tell Your User

- **Organization policy**: "If your organization has an AI policy, I can help you publish it and invite colleagues, so every colleague's agent follows it from the start. You confirm publishing and joining in the Instar app."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Draft and try a policy | `POST /org/draft` with the policy text |
| Publish (owner device) | The Instar app's "Publish this policy?" card |
| Invite colleagues | `POST /org/invitations` → an instar.sh/join link |
| Join / leave / accept an update | The Instar app |
| Status | `GET /org/status` |

## Evidence

- Unit: `tests/unit/org-pack.test.ts` (15).
- Integration: `tests/integration/org-pack-and-join.test.ts`.
- E2E: `tests/e2e/org-pack-alive.test.ts`.
