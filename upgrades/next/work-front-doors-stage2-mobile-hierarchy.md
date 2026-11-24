# The phone can read the Conversations tree

<!-- bump: patch -->
## What Changed

Work-front-doors stage 2, "Mobile hierarchy routes" (`docs/specs/work-front-doors.md` §7; `docs/specs/conversation-effort-hierarchy-v3.md` §7.4).

- New `GET /mobile/conversation-graph/tree` (owner phone, device-signed): the owner's top-level groups with their front door, conversations and nested groups in one read, from the same viewer-filtered projection as the existing roots and node reads. Each node carries a `routeRef` for `GET /mobile/conversation-graph/nodes/:ref`; a node cut at 4 levels, 20 children or 400 nodes says `childrenComplete: false`. Proposed card conversations ride along as on the node read.
- A group holding a project the Chief of Staff tracks carries `project {title, conversationKey}` (the console's Project rule); `projects: known|unknown` says whether projects could be read.
- Member and guest phones are refused (`hierarchy-owner-only`) and keep the flat conversation list, as hierarchy v3 §7.4 requires.

## What to Tell Your User

Your phone app can now be shown your conversations as groups and projects, the same tree you see in the dashboard, instead of only one long list. The app screen comes with the next app update; nothing to do now. People you share the agent with still see only the conversations they may read, never your group or project names.

## Summary of New Capabilities

- `GET /mobile/conversation-graph/tree` (owner phone): the Conversations tree in one read, with front doors, nested groups and Project labels.

## Evidence

- Unit: `tests/unit/conversation-graph-tree.test.ts` (13 tests).
- Integration: `tests/integration/conversation-graph-tree-device.test.ts` (4 tests, real device auth).
- E2E: `tests/e2e/conversation-graph-tree-alive.test.ts` (production AgentServer, signed phone).
