# Side-effects: the Conversations "off" answer is a fallback, never in front of a graph route

## Summary

Commit 3182f4956e added a catch-all that answers every `/conversation-graph/*` and `/mobile/conversation-graph/*` request with 503 `conversation-graph-off` when Conversations is off or has nothing to serve it. AgentServer mounted it in the middle of route setup. Anything registered on the app after that point could never be reached on a graph path. 28 integration tests (graph-member-loss-historical-execution, graph-owner-member-loss-execution, graph-member-loss-surface) build an AgentServer with no graph manager and add their own `/conversation-graph/member-loss/*` routes afterwards; all 28 failed with 503 at 2ef62f2048.

Two changes:

1. AgentServer records whether it mounted a graph surface. The fallback is mounted when it did not, which is the same condition as before (the `else` after the two surface mounts). It is now mounted at the end of route setup, just before the error handler, instead of in the middle.
2. The fallback steps aside (`next()`) when a non-error layer registered after it in the same app matches the request: a route for that path and method, or middleware or a router mounted on a matching path. Error handlers do not count. So a graph route added later is never shadowed, and with nothing later the fallback answers as before.

Why both: mounting last alone does not cover routes added after the constructor through `getApp()`, which is how those tests (and any later mount) add routes. Stepping aside alone, at the old position, would never answer, because the pathless routers mounted after it in AgentServer match every path. Together the fallback answers exactly the graph requests nothing else handles.

Production order is unchanged when Conversations is on: `src/commands/server.ts` passes `conversationGraphDefault` (or the replication runtime) to AgentServer, which mounts the graph surface, including the member-loss routes inside `ConversationGraphDefaultSurface`. The fallback is not mounted at all in that case. No router between the old and new mount positions serves graph paths.

## 1. Over-block
None added. The fallback now answers fewer requests: only those no later layer matches.

## 2. Under-block
A graph path that a later pathless middleware matches but does not answer (it calls `next()`) now falls through to Express's 404 instead of the 503. In AgentServer nothing is mounted after the fallback except the error handler, so this applies only to an app that adds layers later, such as a test. The auth middleware still runs first: an unauthenticated graph request is refused with 401 before reaching any of this.

## 3. Level-of-abstraction fit
The fallback logic lives in the factory that owns the 503 answer (`ConversationGraphSurface.ts`). AgentServer only decides whether and where to mount it.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`: no authority changes. The fallback is not a gate; it is the answer given when nothing else handles a graph request.

## 5. Interactions
- The step-aside check reads Express 4's app stack (`app._router.stack`, `layer.match`, `layer.route._handles_method`). If the stack is unreadable (a different Express major), the check reports nothing later and the fallback answers as it did in 3182f4956e.
- The check uses the path as the app's own stack sees it: an absolute-form request line's origin, the query, and a sub-app's mount prefix are removed first.
- Calling `layer.match` outside routing overwrites that layer's `params`/`path`; Express runs `match` again when it reaches the layer, so this has no effect on routing.
- `ConversationGraphSurface` and `ConversationGraphDefaultSurface` still return the same fallback when reads are off. A test app that mounts one and adds graph routes after it now reaches them.

## 6. External surfaces
None changed. Off: graph requests still get 401 unauthenticated and 503 `conversation-graph-off` authenticated, including signed phones through the device allowlist. On: unchanged.

## 7. Multi-machine posture
Machine-local route setup.

## 8. Rollback cost
Revert the commit. No state or format change.

## Class-Closure Declaration
Defect class: a catch-all mounted mid-stack shadows routes registered after it. Closure: complete for the graph fallback; it now answers only unhandled graph requests.

## Evidence
- tests/integration/conversation-graph-surface.test.ts: a new case mounts the fallback, then a later route, a later path-mounted handler and an error handler. The later ones are reached; another method on the later route, and a path with no later handler, still get 503.
- tests/e2e/conversation-graph-surface-alive.test.ts, "configured off": on the real AgentServer, a graph route added after construction is reached behind auth (401 without it), and `/conversation-graph/roots` still answers 503.
- The 28 member-loss tests, conversation-graph-surface, conversation-graph-device-auth and conversation-graph-surface-alive, run from a clean checkout of this commit.

## Second-pass review
A fresh reviewer read the diff and code paths without my conclusion, and ran small Express 4.22.1 experiments. Verdict: concur with notes.
- Confirmed: the fallback is mounted in exactly the old cases. Nothing between the old and new positions returns early, and no router there serves graph paths. Nothing in `src/` adds routes after the error handler or calls `getApp()`. Production order when on is unchanged. Auth (including signed phones) still runs first. No security concern.
- Notes applied: an absolute-form request line and a fallback inside a mounted sub-app made the check miss a later route; the path is now normalised for both, and the sub-app case is tested. The comment now says plainly that a later pathless middleware makes the fallback step aside (see Under-block).
- Noted, not changed: the new integration case uses a bare Express app; the AgentServer mount position is pinned by the e2e "configured off" case and the 28 member-loss tests, which add routes through `getApp()`.
