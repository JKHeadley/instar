<!-- bump: patch -->
## What Changed

The fourth piece of the Chief of Staff (docs/specs/chief-of-staff-topic.md §1.4, §3, §4, §6): its own conversation and the surfaces around it. On an agent where the feature is on, the lease holder creates one Telegram topic for it, pins the greeting inside that topic (the app and the dashboard are where it floats to the top; Telegram cannot pin a topic itself), renames it when the owner changes the display name, and only ever unpins (never deletes) it when the feature is switched off; standby machines adopt the holder's topic like the Attention and Updates topics. Only the owner's messages in that topic are routed; anything else is dropped, logged, and answered once a day with a plain line saying only the owner can talk there. The app's conversation list carries the pinned conversation on the first page and a parent link on every row for the owner, so a new app build can draw the tree while older builds keep seeing the conversation where it always was. The dashboard's conversations page now leads with whatever the Chief of Staff needs from the owner (the same rows Home counts), lists the pinned conversation first with sub-topics indented under their projects, and offers a PIN-gated Check-in button (the app's own check-in arrives with the next piece). The note's "Needs you" items carry one-tap buttons (Unpark, Confirm done) that are owner-checked before anything runs, and a tap also counts as a check-in. The agent's own CLAUDE.md gains one line: when the owner starts an effort in that conversation, draft its binding.

Dev-gated like the earlier pieces: nothing is created, pinned or shown on an agent where `chiefOfStaff.enabled` is off.

## What to Tell Your User

Nothing yet on a normal agent. On a development agent: there is now a Chief of Staff conversation in your Telegram forum, shown first in the app and the dashboard. Say anything in it to check in, tap Check in on the dashboard, or use the daily note's buttons; the dashboard shows what it needs from you.

## Summary of New Capabilities

- `ChiefOfStaffTopic`: create-once, pin, rename, unpin-on-rollback; `chief-of-staff-topic` is a system-topic key (standbys adopt it).
- Owner-only Chief of Staff conversation; `cos:` tap family routed through the Telegram adapter to the loop.
- `GET /mobile/conversations`: `pinned` (first page) and `parentConversationKey` for owner-role callers.
- `GET /chief-of-staff` adds `conversationKey` and `displayName`; `POST /chief-of-staff/check-in` (PIN-gated).
- Console: Chief of Staff entry in the needs registry; conversations page leads with it; pinned-first tree list.
- CLAUDE.md template: the Chief of Staff awareness line and registry row.

## Evidence

- `tests/unit/chief-of-staff-topic.test.ts` (10): dark, unreadable gate, standby no-mint, create + pin + record, reuse, rename once, rollback unpin + re-pin, standby off, Telegram failures.
- `tests/unit/chief-of-staff-tree.test.ts` (5), `tests/unit/console-chats-model.test.ts` (+4), `tests/unit/console-chief-of-staff-needs.test.ts` (4), `tests/unit/chief-of-staff-surfaces-wiring.test.ts` (8, including the adapter's owner-only tap behaviour), `tests/unit/console-needs-first-screen.test.ts` (new fixture: the page leads with the need).
- `tests/integration/chief-of-staff-app-surface.test.ts` (4): owner Bearer and owner device get the fields, cursor pages carry no pin, feature off emits neither.
- `tests/integration/chief-of-staff-check-in.test.ts` (2): 503 off; wrong/missing PIN renews nothing; the right PIN writes a signed renewal and the lease reads live.
- `tests/e2e/chief-of-staff-alive.test.ts`: the system-topic listing carries the key and the status route carries the conversation key.
