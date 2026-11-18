## What Changed

- The Instar phone app can now list conversation grouping suggestions, accept one, or reject one (owner phone only, device-signed). Accepting is one request: the agent creates the group, names it and moves the conversations in, continuing on the next call if another machine is slow to confirm. Every step uses a request id derived from the suggestion, so accepting the same suggestion from two places makes one group. The dashboard uses the same single request.
- A group can become a Chief of Staff project from the phone: the agent drafts the binding (a goal from the group's name, a done checklist, the bound conversation; the owner can use their own words and repos) and the owner confirms it with Face ID. Only that confirmation creates the project, and it first re-checks that the group still matches the draft and that the conversation is not already a project.

## What to Tell Your User

The agent side of organizing conversations into groups from the Instar app is ready: I suggest groups, Accept groups them in one step, and a group can later become a tracked project that you confirm with Face ID. The app screens for this arrive in an app update; until then the dashboard does the same suggestions and Accept.

## Summary of New Capabilities

- `GET /mobile/conversation-graph/suggestions`, `POST /mobile/conversation-graph/suggestions/refresh`, `POST /mobile/conversation-graph/suggestions/:id/accept`, `POST /mobile/conversation-graph/suggestions/:id/reject` (and `POST /conversation-graph/suggestions/:id/accept` on the dashboard).
- `POST /mobile/conversation-graph/nodes/:ref/project-draft`, `POST /mobile/work/projects/drafts/:draftId/confirm` (Face ID over `group-project-confirm <draftId> <draftHash>`).

## Evidence

Unit and integration tests listed in `upgrades/side-effects/conversation-groups-phone.md`.
