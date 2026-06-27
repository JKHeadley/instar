# Side-effects review — dynamic-MCP operator-approval route (POST /mcp/approve)

**Change:** Add `POST /mcp/approve` to routes.ts — the operator-authenticated approval
for a non-preapproved interactive load/offload. The DYNAMIC-MCP-LIFECYCLE-SPEC named
this as the follow-up so an INTERACTIVE session (not just an autonomous-preapproved
one) can complete a load-on-demand.

## 1. Blast radius
Zero until enabled. The route 503s when `dynamicMcpService` is absent/disabled (dark
default), exactly like the other /mcp/* routes.

## 2. Reversibility
Fully reversible — remove the handler + route.

## 3. State / data touched
None new. On a valid PIN + nonce it calls the existing
`DynamicMcpService.requestLoad/Offload(..., {kind:'operator-approved', nonce})`, which
consumes the server-minted nonce and (on success) drives the existing gated change.

## 4. Failure modes
Fail-closed: 503 (dark) / 403 (no PIN, wrong PIN) / 400 (missing topicId/server/nonce)
/ 403 needs-approval (nonce wrong/expired ⇒ the approval did NOT take). A wrong nonce
can never approve; a wrong PIN can never approve.

## 5. Security / authority — THE load-bearing review (C4 + Know Your Principal)
The route is **PIN-GATED** (the dashboard PIN, via the existing rate-limited
checkMandatePin). The agent holds only the shared Bearer token and NEVER the PIN
(CLAUDE.md: the PIN is operator-only), so the agent **structurally cannot reach this
route to self-approve** — this is the concrete completion of the C4 invariant: an
interactive change completes only via a live preapproval OR this operator-PIN-
authenticated path. The agent-facing /mcp/load|offload routes still NEVER honor a body
nonce. The operator supplies the nonce (which the agent surfaced) + the PIN together.

## 6. Operator-surface quality (honest)
This commit ships the MECHANISM (the route), not yet the Mobile-Complete tap surface.
Until a dashboard "Approve" button lands (the explicit next increment), an operator
would have to POST the route — which does NOT meet "Operators Act in Taps, Not Text".
So this is NOT operator-complete yet; it is the auth-correct mechanism the tap surface
will call. Not claimed as done.

## 7. Tests
14 integration tests (+5): 503 dark; PIN required (no pin ⇒ 403 — agent can't
self-approve); wrong PIN ⇒ 403; the real round trip (agent needs-approval → nonce →
operator PIN+nonce ⇒ applied); wrong nonce ⇒ 403 needs-approval. tsc clean.
