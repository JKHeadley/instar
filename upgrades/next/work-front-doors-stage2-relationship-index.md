<!-- bump: patch -->
## What Changed

The agent can now ask what a conversation is connected to (work-front-doors stage 2, the relationship foundation; spec `docs/specs/work-front-doors.md` §4, CMT-2065).

- New `GET /conversation-neighbourhood?conversation=telegram:<topic>|app:<key>`. It returns the conversation's project (the conversation graph's effort first, else its Chief of Staff project, found through the tree at any depth) and the open work-board cards in that project or made from this conversation, each with whose turn it is. It also returns sibling conversations in the same effort, the people named on those cards, and open promises made in the conversation, joined on origin machine plus id, never a bare CMT number.
- Every group carries `complete` and its reasons. `couldNotCheck` names a source that is off or unreadable. A board that is behind, graph lag, an old copy of another machine's promises, or a ceiling cut is labelled, never shown as zero.
- It is scoped to the conversation's least-privileged audience: everyone who may read it now, from this machine's team record and phones. A neighbour is included only when every reader may read it, checked at both ends. A project's name is shown only when the owner is the only reader, and a project a reader may not read is left out entirely. When the team record cannot be confirmed, nothing is shown and the read says why.
- New `GET /conversation-neighbourhood/session-context?topicId=N`: a labelled `<conversation-neighbourhood>` reference block, at most 1,800 bytes by default (`relationshipIndex.maxBlockBytes`). The session-start hook and its compaction-recovery twin inject it. The per-prompt hook carries it again, once per session, whenever it changes, so running sessions stay current.
- A session token reads only its own conversation. A phone or browser is refused, because this is the agent's read.
- Dev-gated (`relationshipIndex.enabled`): live on development agents, dark on the fleet (503 `relationship-index-off`). Off switch: `relationshipIndex.enabled: false`, read live. It is read-only, derived on read, and stores nothing.

## What to Tell Your User

When I start work in a conversation, I now know which project it belongs to, which cards in that project are open and whose turn each one is, and what I promised there. You don't have to remind me. In a conversation you share with someone on your team, I only see what they can see. For now this is on only for development agents.

## Summary of New Capabilities

- `GET /conversation-neighbourhood`: a conversation's project, open cards with whose turn, related conversations, people and open promises, with completeness labels (dev-gated `relationshipIndex.enabled`).
- `GET /conversation-neighbourhood/session-context`: the injected block, delivered at session start, after compaction, and on change while a session runs.

## Evidence

- Unit: `tests/unit/relationship-index.test.ts`, 28 tests: derivation, the least-privileged audience on both sides, sources off or unreadable, ceilings, block fit and neutralisation, delivery memory.
- Integration: `tests/integration/conversation-neighbourhood-routes.test.ts`, 8 tests: the routes, session scoping, phone refusal, a team member narrowing the view, and rule 117 (a new card reaches two running sessions on their next prompt).
- E2E: `tests/e2e/conversation-neighbourhood-alive.test.ts`, 7 tests: 200 through the real AgentServer on a development agent and 503 on the fleet; the generated hooks fetch the block; dev-gate and awareness registration.
