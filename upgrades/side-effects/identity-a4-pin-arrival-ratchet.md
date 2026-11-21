# Side-Effects Review — the shared PIN budget asks the request's arrival first (A4 ratchet)

**Version / slug:** `identity-a4-pin-arrival-ratchet`
**Date:** `2026-11-20`
**Author:** `Echo`
**Second-pass reviewer:** `not required (Tier 1, behaviour unchanged)`

## Summary of the change

Tier 1. Main's identity piece 1c (#3412) added a loopback test in `AgentServer.publicPinContext`
(`isLoopbackSource(raw)`, which decides whether a PIN attempt is charged to the unattributable global
budget). It merged after the A4 same-network listener's ratchet was written, so the merged tree failed
`tests/unit/request-arrival-ratchet.test.ts` (Local Verify, PR #3518, 2026-11-21T03:06Z). The check now
asks `mayBeLocalArrival(req)` first, as the ratchet requires of every local test.

## Decision-point inventory

- `AgentServer.publicPinContext` — modify — the loopback branch is taken only for a request that did not
  arrive on the same-network listener. Behaviour is unchanged: that listener already rewrites its sockets'
  address to `sn:<address>`, which `isLoopbackSource` never accepts, so such a request was never treated
  as loopback here.

## Over-block / under-block

None. Same answer for every request; the change makes the arrival rule explicit at the site.

## Rollback

Revert the commit. No state, config or migration.

## Evidence

- `tests/unit/request-arrival-ratchet.test.ts`: failed on the merged tree (`server/AgentServer.ts: 1 (baseline 0)`), passes with the change (3/3).
- PIN tests: `owner-pin-verifier`, `pin-attempt-store-hardening`, `dashboard-pair-page`, `identity-pin-throttle` — 53 pass.
- `tsc --noEmit` clean.
