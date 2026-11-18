<!-- bump: patch -->
## What Changed

- The dashboard Conversations pages say "group" where they said "effort": "Your groups", "Suggested groups", "Back to your groups", "Create group", "Rename group", "Group name", "Open group", "Forget group name", "No groups yet. Your conversations are in All.", the Overview tile "Groups", and the related status lines. Owner decision 2026-11-17. Routes, data, the `effort` node kind and stored records keep their names.
- The agent's Conversations awareness says "group" and tells the agent to call them groups to the user (a group may be linked to a project the Chief of Staff tracks, or be plain). Existing agents on the full CLAUDE.md layout have the three old phrases rewritten once by `migrateClaudeMd`.
- `GET /conversation-graph/nodes/:ref/messages` now gates on the graph runtime's private-serving check (`privateReadsServable()`: alive and private custody allowed, the same check the owner's read view needs) instead of the 60-second write-readiness proof. On a busy lease holder that proof is absent most of the time, and the route answered 503 `conversation-graph-off` to 25 of 30 owner reads while the page itself loaded. Owner proof, source resolution and the post-fetch re-checks are unchanged.

## What to Tell Your User

The Conversations page now calls your bundles of related chats "groups" instead of "efforts", and I will use that word too. Opening a conversation there should now show its original messages instead of "The original history could not be loaded."

## Summary of New Capabilities

- None new. Wording change on the Conversations pages, and the conversation history panel loads reliably on a busy machine.

## Evidence

- Live, Studio 2026-11-17 15:48-15:51 PT: 30 owner reads of the Chief of Staff conversation's history: 3 × 200, 2 × 502 `source-history-unavailable`, 25 × 503 `conversation-graph-off`, while `/conversation-graph/roots` and `/conversation-graph/nodes/:ref` answered 200 (partialReasons `evidence-missing`, `replica-lag`). Log last readiness line: "ready".
- Integration: `tests/integration/conversation-graph-replication-runtime.test.ts` "keeps owner private reads servable after the 60 s write-readiness proof ages out, and withdraws them with the runtime"; `tests/integration/conversation-graph-history.test.ts` unchanged and passing.
- Unit: the five console Conversations test files updated to the new words; `tests/unit/PostUpdateMigrator-conversationsSuggestionsAwareness.test.ts` adds the old-wording rewrite and idempotency case.
