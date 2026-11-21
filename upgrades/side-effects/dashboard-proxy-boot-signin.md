# Side-Effects Review — Stored sign-in survives a gateway outage at boot

**Date:** 2026-11-17
**Author:** Echo
**Independent reviewer:** fresh general-purpose reviewer, no defects; confirmed the wrapped fetch is in place for both callers. Its two test gaps (network exception, offline device) are now covered.
**Tier:** 1, small reversible client correction under app-weak-network §2.

## Decision-point inventory
One existing decision: whether the console keeps a stored sign-in at boot or shows the sign-in box. The rule is unchanged in intent: no connection is not a wrong sign-in. The change makes a gateway's "could not reach the agent" answer (HTTP 502, 504, 520-530) count as no connection, as a network exception already did. A typed value still needs a live success.

## Over-block and under-block
Before: a gateway outage with an empty saved-response cache signed the person out, so they met the PIN box while the agent was simply unreachable (over-block). After: the stored sign-in is kept and the existing "Still trying to reach the agent" line shows. Under-block guard: any answer from the agent itself (401, 403, 503 and others) still goes to the sign-in path, and a response replayed from the offline cache (X-Instar-Saved-At) never validates a typed token.

## Level of abstraction
The reachability classification reuses net-state.js frontCouldNotReach, the same rule the weak-network line already uses. validToken moves from console.js into ticket-model.js so the boot decision and its check are testable together. No new state store.

## Signal versus authority and judgment
No authority change. Keeping a token the server already issued grants nothing new; every later request is still checked by the server. docs/signal-vs-authority.md applies unchanged.

## Interactions and external surfaces
Web console only. Ticket redemption from the Instar app and PIN unlock paths are unchanged. No API, native app, migration or scaffold-awareness change.

## Multi-machine posture
Whichever machine serves the console answers the check. No persisted state or replication change.

## Rollback
Revert the static asset change. No data repair.

## Verification
Nine new cases in console-net-state.test.ts (502/504/522, a network exception and an offline device keep the stored sign-in; 401/403/503 go to the PIN box; a typed token needs a live success, including after a saved read). 62 tests across the five sign-in and net-state files passed; the net-state file passed again with the two added cases (34 tests). The console.js boot wiring itself is covered by review, not a test. Full validation belongs to Local Verify before merge.
