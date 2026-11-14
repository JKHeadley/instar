<!-- bump: patch -->
## What Changed

- **Conversations suggests efforts.** The Conversations Overview has a new "Review suggestions" page. The agent proposes groups of the owner's unassigned conversations (one model call per build, `ConversationGraphSuggestions`, reflector tier), each with a one-line reason and Accept/Reject. Plain code validates every group before it is shown: only conversations it was offered, 2 to 12 per group, none in two groups, no group mixing two bound projects, nothing already rejected. Accept runs the ordinary owner changes from the dashboard (create effort, name it, preview and move each conversation), waiting for each to commit and resuming from opaque progress if a machine is slow. A rejection is remembered. Routes: `GET /conversation-graph/suggestions`, `POST …/refresh`, `POST …/:id/reject`, `POST …/:id/accepted` (owner operator session; mounted with owner corrections). Spec: docs/specs/conversation-graph-suggestions.md.
- **The Chief of Staff conversation is the root of the Overview.** `GET /conversation-graph/roots?view=overview` returns it as `root`, and the dashboard draws it as the top row with every effort under it. It cannot be placed under anything: node reads report `moveEligible:false` (`chief-of-staff-is-root`), it has no move destinations, preview says not eligible, and the write ingress refuses the placement with 409 `chief-of-staff-is-root`.

## What to Tell Your User

Your Conversations page can now organize itself. Open "Review suggestions" and I'll show you groups of your conversations that look like one piece of work, each with a short reason. Tap Accept and I'll make the effort and move those conversations in, or Reject and that suggestion won't come back. Nothing moves until you accept. Your Chief of Staff conversation now always sits at the top, with every effort under it.

## Summary of New Capabilities

- Owner-reviewed effort suggestions for existing conversations, with one-tap Accept or Reject.
- The Chief of Staff conversation is always the top of the Conversations Overview and cannot be moved under anything.

## Evidence

- Unit: `tests/unit/conversation-graph-suggestions.test.ts` (parser rules, service build/reject/accept/rate bounds, Chief of Staff root in the read model), `tests/unit/console-conversation-suggestions.test.ts` (Accept order, resume without a second effort, refusal stops, no title or proof in storage), `tests/unit/PostUpdateMigrator-conversationsSuggestionsAwareness.test.ts`.
- Integration: `tests/integration/conversation-graph-suggestions.test.ts` (actual replicated runtime: owner-only routes, not mounted without corrections, the root refused at preview and at the real write ingress while an ordinary move commits).
- E2E: `tests/e2e/conversation-graph-suggestions-alive.test.ts` (production AgentServer from a real PIN unlock: suggestions 200 for the owner, 403 without the proof).
