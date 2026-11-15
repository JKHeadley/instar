## What Changed
- **Pin conversations to the top of the list.** A person can now pin whole conversations so they always lead their conversation list. Pins belong to each person (all of the owner's phones and the owner's dashboard browser share one set; a team member or shared person has their own), at most 50, newest pin first, and they are the same on every machine (a new replicated kind, `conversation-list-pin`).
- `POST /mobile/conversations/pins {ref, pinned}` pins or unpins (`ref` is `app:<uuid>`, `telegram:<topicId>` or `slack:<machine>:<id>`). A person may pin only a conversation they can see. The first page of `GET /mobile/conversations` now carries `pinnedRefs` and `pinnedRows` (full rows, so a pinned conversation older than the page still shows at the top).
- The dashboard's Conversations page shows a "Pinned" group at the top and a Pin or Unpin button on every conversation.
- Off switch: `mobilePairing.native.listPins.enabled: false` (on by default wherever app conversations are on).

## What to Tell Your User
You can now pin conversations so they stay at the top of your list. In the dashboard's Conversations page, use the Pin button beside a conversation; it moves into a "Pinned" group at the top, and Unpin puts it back. Your pins are yours and show up the same on every one of your devices and machines.

## Summary of New Capabilities
- Pin up to 50 conversations per person to the top of the conversation list, shared across that person's devices and the agent's machines.
- A "Pinned" group with Pin and Unpin buttons on the dashboard's Conversations page.

## Evidence
- `tests/unit/conversation-list-pins.test.ts`: the fold (latest row wins in any order), pin order, the 50 cap, idempotency, strict validation of replicated rows, landing peers' rows, the re-send of unshared rows at boot.
- `tests/integration/conversation-list-pins.test.ts`: the HTTP contract (pin, repeat, pinned rows older than the page, later page, deleted conversation, shared person refused, Bearer needs a reader, cap, off switch).
- `tests/e2e/conversation-list-pins-alive.test.ts`: a production-booted server: a phone pins and the owner's browser sees the same pin.
