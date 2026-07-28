# Login Flow Restart Recovery

## Problem

Pending-login metadata survived a server restart, but its framework login pane
did not. A user could therefore submit a code to a durable record whose backing
process was gone and receive a raw transport-style failure.

## Contract

1. On boot, every non-terminal pending login is re-driven before dashboard
   traffic is served. The replacement suppresses browser launch and persists
   only its fresh public URL/code.
2. A submit against a dead pane never types the stale code. The server refreshes
   that flow and returns `login-expired-fresh-ready`.
3. If the record vanished but the pool account still provably needs re-auth, the
   submit action mints a replacement flow from the account metadata and returns
   the same fresh-ready response.
4. If no replacement can honestly be produced, the response is
   `410 login-expired`, not a bare 404/502.
5. The dashboard recognizes both lifecycle outcomes and never renders
   “failed (status)” for them.

## Safety

No credential is stored or returned. A stale code is refused before `sendInput`.
Boot/dead-pane renewal uses the existing login driver and public-artifact store.
