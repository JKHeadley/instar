# Side-effects: graph routes answer 503 `conversation-graph-off` when Conversations is off

## Summary

When `multiMachine.conversationGraph.readEnabled` is not true, no graph surface was mounted. `createConversationGraphSurface` and `createConversationGraphDefaultSurface` returned empty routers, and AgentServer skipped both. So `/conversation-graph/*` and `/mobile/conversation-graph/*` fell through to Express's HTML 404 "Cannot GET". The console maps 404 to "This conversation is unavailable." and only 503 to "Conversations is not switched on here yet." (`dashboard/console/conversations.js` 88-89), so an operator on a machine with the feature off was told a conversation was unavailable.

The change adds `createConversationGraphOffRouter()`, one catch-all in `ConversationGraphSurface.ts`. It answers every method on `/conversation-graph` and `/mobile/conversation-graph` (and anything below them) with 503 JSON `{code:'conversation-graph-off'}` and `Cache-Control: no-store`. This is the code the history route already uses for not-ready. It is used in three places: both surface factories return it when `readEnabled` is not true, and AgentServer mounts it when neither surface is mounted (configured off, or on with no runtime and no default manager to serve it). The path pattern is shared as `CONVERSATION_GRAPH_PATH`, which the default surface now uses too.

## 1. Over-block
None. Only paths that previously had no handler at all are answered. Mounted surfaces are unchanged. The pattern needs `/` or end of path after `conversation-graph`, so `/conversation-graph-elsewhere` and `/internal/conversation-graph*` are not matched (a test covers this).

## 2. Under-block
None. The catch-all is mounted at the same point as the surfaces, after `authMiddleware`. A request with no bearer and no device signature still gets 401 first (e2e covers both prefixes). Mobile device-signed requests pass the device verifier and the route allowlist (`mobilePairingRoutes.ts` 2237-2244, owner-only) before reaching it, the same as when the feature is on. An unlisted mobile graph path is refused by the device layer as before. The answer reveals only that the feature is off here.

## 3. Level-of-abstraction fit
One router, defined next to the surface it stands in for, used by every place that decides not to mount the surface.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`. A refusal with a typed code; it grants nothing.

## 5. Interactions
- Write admission (`WriteDomainRegistry`) can still refuse a graph write path earlier on a read-only machine. That is unchanged and is a refusal too.
- Nothing is mounted on these prefixes after this point in AgentServer, so the catch-all shadows no other route.

## 6. External surfaces
Dashboard and phone now show "Conversations is not switched on here yet." instead of "This conversation is unavailable." when the feature is off. JSON instead of HTML on these paths.

## 7. Multi-machine posture
Machine-local: each machine answers for its own configuration.

## 8. Rollback cost
Revert the commit. No state change.

## Class-Closure Declaration
Defect class: unmounted-feature-falls-through-to-framework-404. Closure: every graph route prefix, both surfaces, and the AgentServer composition share the one catch-all.

## Evidence
- tests/integration/conversation-graph-surface.test.ts: the off surface answers 503 `conversation-graph-off` for dashboard GET, POST and the mobile prefix, and 404 for a non-graph path.
- tests/e2e/conversation-graph-surface-alive.test.ts: the real AgentServer with Conversations configured off. No credentials gives 401 on both prefixes. A bearer gives 503 JSON on roots, node, history, changes and mobile roots. A signed owner phone gives 503 through the device allowlist.

- Focused runs: integration `conversation-graph-surface.test.ts` 2/2 and `conversation-graph-device-auth.test.ts` 3/3. E2E `conversation-graph-surface-alive.test.ts` 3/3, rerun 3/3 after the phone branch was made unconditional (the test now asserts the pairing service exists).

## Second-pass review
A fresh reviewer read the diff and the code paths without my conclusion. Concur. It confirmed:
- auth is mounted before the catch-all (`authMiddleware` around line 2364);
- device-signed requests pass the allowlist and owner checks first, and unlisted device paths are refused 403 `device-not-allowed`;
- the anchored pattern shadows no route mounted later, and does not match `/internal/conversation-graph*` or `/conversation-graph-bootstrap`;
- the surface factory is only called with `readEnabled: true` from the default surface;
- the console already maps any 503 to "not switched on here yet".

Low notes, recorded and not changed:
- The catch-all also answers when reads are configured on but nothing can serve them (a runtime with no identity manager, or no runtime and no default manager). That case now says "off" rather than giving an HTML 404. A `reason` field could separate the two later.
- The console's correction and effort-action panels offer Dismiss only on a 404 or status 0. A stale page posting after the feature was switched off gets no Dismiss button.
- A bearer holder now learns the feature is off on the mobile prefix. That reveals nothing beyond what the agent token already allows.
