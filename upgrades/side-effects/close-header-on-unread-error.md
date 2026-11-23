# Side effects: the error answer to an unread body says Connection: close (SEC-118-R2)

In plain words: when the server refuses a request whose body it never read, it already closes the connection after its answer (SEC-118-R1, #3513). Now it also says so in the answer's headers, so a proxy that reuses connections closes cleanly instead of seeing an abrupt cut.

Tier 1. Size: 1 source file, 2 new unit cases.

## What changes for running agents
- `closeUnreadBodyOnError` also wraps `res.writeHead` for requests with a body. When the status is 400 or above and the body is still unread (`!req.complete`), it sets `Connection: close` before the headers go out.
- Answers to fully read bodies, and successful answers, are unchanged.

## Signal vs authority
Connection handling only.

## Rollback
Revert the commit.

## Not covered here
Responses whose headers were flushed early (none known on refusal paths) still get only the socket close.

## Tests

Unit: `tests/unit/body-budget-before-auth.test.ts` (26 pass, 2 new: the header on an unread body, and no header after a fully read body). E2E: `tests/e2e/close-unread-body-alive.test.ts` boots the real AgentServer and checks that an unauthenticated chunked body of an unknown type gets 401 with `Connection: close`; not run on the M5 per the machine rule, so Local Verify runs it.

## Second-pass review
**Reviewer:** independent read-only review subagent (fresh context, ran the unit file plus a throwaway check on Node v24.15.0, where the 401 header was keep-alive without the wrap and close with it). It concurred with no blocking findings. Notes: an explicit `writeHead(4xx, {Connection: 'keep-alive'})` would override the header (only the SSE route passes Connection, and it sends 200), and the finish-time socket close still applies either way. The header and the close can disagree if the body completes between them, and Node's own close handling covers that case. Implicit headers through `res.json`/`res.end` reach the wrap.
