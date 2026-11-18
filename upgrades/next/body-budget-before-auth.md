# Strangers can no longer make the server read large request bodies

<!-- bump: patch -->

## What Changed

SEC-103. The general JSON parser (12 MB) and the per-path parsers for `/mobile/org/recover` (32 MB) and `/hooks/post-compact` (2 MB) ran before the auth gate, so anyone with the tunnel URL could make the server buffer and parse large bodies per request (memory and event-loop time; about 34 ms blocking and 41 MB heap per 12 MB body). Malformed JSON also reached the error handler as a 500 with a full stack trace logged per request.

A new credential-aware parser (`src/server/bodyBudget.ts`) now picks the body budget before reading anything:

- **Full budget** (the route's own limit): the agent token (constant-time compare), a valid `dst_` dashboard session (when that feature is on), or a known `mps_` memory-privacy session. Also a narrowed admission for signed peers, whose ids are not secrets, so the real signature check still runs later on the body: an active paired device that presents its signature header and a signing time within 2 minutes (never on `/internal/`), or an active paired machine (never this machine's own id) that presents the full machine signature header set with a timestamp within 2 minutes on an `/api/` machine route.
- **Peer budget, 2 MB**: POST/PUT to the exact public routes that check a peer's credential inside their handler (mesh RPC, a2a inbox, relay, the Threadline peer routes, project-app api, WhatsApp webhook).
- **64 KB**: everyone else, including Secret Drop and the document page. A declared larger Content-Length is answered 413 `body-too-large` before any byte is read. A body with no declared length is read only up to the budget and then answered 413. Both close the connection.

Body-parser errors are now plain answers: 400 `invalid-json`, 413 `body-too-large`, 415 for an unsupported charset or encoding. They log at most one line per code per minute, naming only the first path segment, because some paths carry a token.

## What to Tell Your User

- **Harder to overload from outside**: "Someone who knows my web address can no longer make me read and decode big uploads before I check who they are. Strangers get a small limit; you, your phones and your other machines keep the full one."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Body size limit depends on the caller's credential | Automatic |
| Malformed JSON answered with a plain 400 | Automatic |

## Evidence

- Unit: `tests/unit/body-budget-before-auth.test.ts` (real Express app on a real socket, the real auth middleware and error handler): a stranger declaring 2 MB gets 413 with zero body bytes read; a wrong token and an unknown device id get the same; a small stranger body still reaches the auth gate (401); the agent token parses 2 MB; a peer route parses 900 KB and refuses a declared 3 MB; Secret Drop gets only 64 KB; a stranger body with no declared length stops at 413; malformed JSON is 400 `invalid-json` for both a stranger and the agent; the per-path full limit holds for an active device; each credential kind and its near miss, including a device without its signature header or with a stale time, a machine off a machine route, with missing headers, a stale timestamp, or this machine's own id.
