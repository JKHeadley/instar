# Side effects: an error answer to an unread body closes the connection (SEC-118-R1)

In plain words: a refused request whose body was never read used to be drained to the end by Node, to keep the connection alive. Now the connection is closed instead.

Tier 1. Size: 2 source files, 2 new unit cases. Stacked on SEC-118 (PR 3510); merge after it.

## What changes for running agents
- A new middleware, `closeUnreadBodyOnError`, is mounted first in `AgentServer`. When a response with status 400 or above finishes and the request still has unread body bytes (`!req.complete`), it destroys the socket.
- This covers every refusal in one place: the auth gate's 401 and 403, rate limits, and route checks.
- Successful responses (below 400) are untouched.
- A client that sent a body and got an error must open a new connection for its next request. Clients already do this after an error with an unread body.

## Signal vs authority
Connection handling only. Nothing is admitted or refused differently.

## Rollback
Revert the commit.

## Not covered here
A successful response that never reads a sent body still lets Node drain it. Only error answers close.

## Second-pass review
**Reviewer:** Echo security session, self-review against the SEC-118 independent review's note 3, which named this residual. The unit test fails with the guard disabled (Node keeps reading) and passes with it. It is a small, one-place change.
