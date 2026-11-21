# A refused request with an unread body is told the connection is closing

<!-- bump: patch -->

## What Changed

SEC-118-R2, the follow-up from the independent review of #3513. The error answer to a request whose body was never read now carries `Connection: close` in its headers, as well as closing the socket after the answer. Proxies that reuse connections, such as the tunnel, then close cleanly and pass the real answer through, instead of seeing an abrupt cut.

## What to Tell Your User

- **Cleaner refusals through the tunnel**: "When my server refuses a request, it now says it is closing the connection, so the tunnel passes my real answer along instead of an error page."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Connection: close on error answers to unread bodies | Automatic |

## Evidence

- `tests/unit/body-budget-before-auth.test.ts`:
  - the 401 to an unread chunked body carries `Connection: close`;
  - a 422 after a fully read body keeps the connection.
