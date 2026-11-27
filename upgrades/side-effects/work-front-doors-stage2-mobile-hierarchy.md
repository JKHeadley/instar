# Side-Effects Review — Work front doors, stage 2: the phone tree of Conversations

**Version / slug:** `work-front-doors-stage2-mobile-hierarchy`
**Date:** `2026-11-20`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Spec `docs/specs/work-front-doors.md` §7 stage 2, "Mobile hierarchy routes (hierarchy v3 §7.4), so the phone shows the tree, not only the flat list". What already existed on main: device-signed, owner-only `GET /mobile/conversation-graph/roots` and `/nodes/:ref` (one level per request). What the phone lacked: the tree itself without one request per group, and the console's Project label (which the console works out in the browser from `/work/projects`).

- `ConversationGraphReadModel.tree(viewer, {cursor, projects})` (`src/core/conversationGraphRead.ts`): the viewer's root efforts, paged with the existing signed, viewer-bound snapshot cursor (own scope `tree`), each with its visible children nested to 4 levels, at most 20 children a node and 400 nodes a response; a cut node says `childrenComplete: false` and is opened with the existing node read. Each node: `ref`, `routeRef`, `title`, `kind`, `role`, `placedBy`, `state`, `source`, `sourceFreshness`, `visibleChildCount`, `frontDoor` (efforts), `project` (efforts), `children`, `childrenComplete`, `proposed`. The Chief of Staff root conversation heads the first page as `root`. Envelope as roots (`revision`, `asOf`, `partial`, `partialReasons`, `replicationState`, `capabilities`) plus `projects: known|unknown` and `limits`.
- The card-proposal computation in `node()` moved unchanged into a private `proposedFor()` that both reads use.
- Project label: an effort is labelled when its front door, else a conversation directly in it, is a Chief of Staff project's conversation (the console's rule from PR #3547). Source: the projects the suggestion service already receives (`options.suggestions.projects` in `ConversationGraphSurface`), converted by `treeProjects()` in `src/core/workFrontDoorsGraph.ts` to `{ref, title, conversationKey}`. Unreadable projects → `projects: 'unknown'` and no labels.
- Route `GET /mobile/conversation-graph/tree` in `src/server/conversationGraphRoutes.ts` (phone only; the dashboard keeps composing roots/nodes) and its device rule in `src/server/mobilePairingRoutes.ts` (`ownerOnly`, bucket `conversation-graph-reads`, 30/min, no body).
- Capability index entry `mobileConversationTree` (no new prefix) and awareness entry `src/data/awareness/phone-conversation-tree.md`.

## Decision-point inventory
No new decision point. Who may read is decided by the existing device-auth owner rule and the existing owner viewer resolver (`conversationGraphViewer.ts`); what is visible by the existing projection `mayView` filter. The new route adds neither.

## 1. Over-block
A member (MSP) or guest phone gets 403 `hierarchy-owner-only`. That is the spec, not an over-block: hierarchy v3 §7.4 says an MSP "does not receive the owner's effort tree" in v1, and work-front-doors stage 2 requires "a member's Work door working with no tree and no project names". Members keep the flat `GET /mobile/conversations`. A Slack project conversation gets no Project label (no Work-page key exists for it yet; same as the console).

## 2. Under-block
The response is bounded: at most 50 root efforts (one page) plus the root conversation, and nested children and proposals together draw on one 400-node budget (proposals are also capped at 50 an effort by the existing cap). A cut of children says `childrenComplete: false`; a cut of proposals says `proposedComplete: false`. The card record is read once per tree request. A very wide tree is cut, and says so per node; nothing is silently dropped. Hidden nodes: the projection filter runs before nesting, counting, proposals and labels, so a hidden conversation never shows, never counts, and never labels an effort as a project (unit test with a hidden front door and a hidden project conversation).

## 3. Level-of-abstraction fit
The tree is one more read on the shared read model, built from the same single projection per request (`scoped`), as hierarchy v3 §7.1 asks ("The app and dashboard consume one shared projection module"). The route sits in the existing graph router beside roots/nodes and reuses `authorizedSend` (re-resolves the viewer before sending; grant change → 409).

## 4. Signal vs authority compliance
A read. No blocking authority, no brittle check (docs/signal-vs-authority.md): authority stays with the existing owner admission.

## 5. Interactions
- `node()` behaviour is unchanged (the proposal logic moved verbatim; existing read tests pass).
- The tree's cursor scope is `tree`; a roots or children cursor is refused (409 `cursor-invalid`), and vice versa.
- `projects()` is the same function the suggestion service calls; it reads the Chief of Staff loop in memory. A throwing source is caught (`@silent-fallback-ok`, reported as `projects: 'unknown'` in the body).
- PR #3374 adds suggestion routes to the same router family and the same device-rule table; this change adds one rule line and one route block, no shared lines edited.

## 6. External surfaces
One new device-signed GET for the owner's phone. No app screen ships here (app builds are on hold); the iPhone, Android and Mac apps can draw the tree from this one read. Agent instructions gain one feature note.

## 6b. Operator-surface quality
No operator surface in this change (a server read). The field names and the plain words the awareness entry uses ("group", "Project") match the console.

## 7. Multi-machine posture
Proxied by design through replication already in place: the graph events, the conversation inventory and the Chief of Staff tree replicate, and every machine builds the same projection; replica lag is reported (`partial`, `replicationState: pending`) exactly as on roots. The device rule and rate bucket are per machine like every phone route. Snapshot cursors are machine-local (a cursor from another machine is refused as expired, and the phone starts again), the same as roots/nodes.

## 8. Rollback cost
Revert the commit. No stored data, no migration, no config. A phone build that uses the route would fall back to roots/nodes.

## Evidence
- Unit: `tests/unit/conversation-graph-tree.test.ts` (13): 503 before projecting; nesting with front door, roles and route refs; Project label from front door then child, `unknown` labels nothing; hidden conversations never nested/counted/labelled; hidden effort hides its subtree; per-node and depth cuts; response-budget cut with separate childrenComplete and proposedComplete, card record read once; viewer-bound paging, root on page 1 only, foreign-scope cursor refused; proposals only with a visible project conversation; `treeProjects`; router owner-only, phone-only, throwing projects, bad cursor. `tests/unit/mobile-session-terminal.test.ts` names the new owner-only rule.
- Integration: `tests/integration/conversation-graph-tree-device.test.ts` (4): real device-auth middleware, ledger and owner resolver: owner phone gets the nested tree with Project label; bearer, member and forged requests refused before the inventory is read; revoked 401; 503 until ready; dashboard proof does not open it.
- E2E: `tests/e2e/conversation-graph-tree-alive.test.ts` (1): production AgentServer with Conversations on, the owned graph started by a real PIN visit; a signed phone builds a parent and nested group and reads them nested from the tree, opens the nested node by its `routeRef`, and is refused once revoked.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Opus 5.5). **Independent read: Concur with the review.** Traced: only an owner phone reaches the body (ownerOnly device rule → 403 hierarchy-owner-only for member/MSP/guest; not a browser route; resolveViewer requires a current signature admission, so bearer and revoked fail; viewer re-resolved in authorizedSend; dashboard path 404). Every field comes from the one viewer-filtered projection; project labels need `projection.has`; proposals keep the both-ends check. Tree cursor scope `tree` is refused by roots/children and vice versa, and bound to viewer and grant. `proposedFor()` is a verbatim move. Minor notes: (a) `cardPlacements()` was scanned once per effort; (b) a proposal cut set `childrenComplete:false` though all children were present; (c) on later pages an effort moved between reads could appear twice (same snapshot behaviour as roots, cosmetic); (d) §2 wording on the proposal cap was loose.

**Author:** (a) the card record is now read once per tree request; (b) a proposal cut now sets its own `proposedComplete: false`; (d) §2 reworded. (c) left as is: it matches the existing roots snapshot contract (§7.3: unrelated graph events do not invalidate a cursor).
