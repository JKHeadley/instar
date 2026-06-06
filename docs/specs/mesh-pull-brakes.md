---
title: Mesh Lease-Transport Brakes — bounded failure logging + hung-socket timeouts
status: converged
tier: 2
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"
review-convergence: self-converged against the loop-safety audit finding (CMT-1109) verified at source (pullPeer logged one line per failed attempt at the ~5s anti-blinding cadence ≈17k lines/day per down peer; neither transport fetch carried an abort signal, and the pull loop's leasePulling re-entrancy guard means one hung socket wedges all future pulls); validated by an independent adversarial second-pass reviewer whose key finding (10s default timeout sits inside the fleet's documented 5–40s receiver-stall envelope → false self-suspend of a healthy lease holder via the renewal path) was APPLIED before commit — default raised to 30s and derived from leaseTtlMs at the server construction site.
approved: true
---

# Mesh Lease-Transport Brakes

> Approval ground: Justin's ratification of "No Unbounded Loops" (P19) and his
> direction to fix the audit's verified loops as individual PRs (2026-06-05,
> topic "Resource Limitation Mitigation"). This is audit fix #2, announced to
> him as "the lease-puller fix: kill its log flood and give its network calls a
> timeout." Merge gates on his word.

## Problem (loop-safety audit, verified at source)

The lease pull loop's ~5s cadence is DELIBERATE (anti-blinding: a quiet or
one-way network must not hide a takeover) — an Eternal-Sentinel-adjacent design
where backing off the attempts is wrong. Its brakes were missing elsewhere:

1. **Log amplification:** `HttpLeaseTransport.pullPeer` logged one line per
   failed attempt — a down peer wrote ~17,000 lines/day (the same flood
   signature as the reaper incident). `broadcast` non-ok responses and pull
   non-ok responses were conversely SILENT (a rejecting peer was invisible).
2. **Hung-socket wedge:** neither fetch carried an abort signal. The pull
   loop's `leasePulling` re-entrancy guard never releases while a pull is
   in flight — one TCP connection that hangs without erroring wedges every
   future pull tick forever (anti-blinding silently dead).

## Design

- **`src/core/PeerFailureLogGate.ts`** (new, pure, count-based — no clock):
  converts per-attempt logging into state-change logging. First failure →
  "became unreachable"; every Nth (default 360 ≈ 30min at 5s) → one reminder
  with the count; first success after a streak → "recovered after N"; steady
  states → silence. Exact bound: F consecutive failures log ⌈F/N⌉+1 lines.
  Keys are `<op> <machineId>` (broadcast and pull are independent channels —
  mirrors `isReachable()`'s bidirectional model); recovered keys are deleted,
  so retained state is bounded by currently-failing peer×op pairs.
- **`HttpLeaseTransport`**: both fetches carry
  `AbortSignal.timeout(requestTimeoutMs)`. Default 30s; `server.ts` derives
  `min(leaseTtlMs/2, 30_000)`. All failure/recovery logging routed through the
  gate; non-ok responses now gated-logged too (closing the silent-rejection
  blindspot).

## The timeout sizing (the reviewer's finding — applied)

The first draft defaulted 10s ("double the pull cadence"). The adversarial
second pass traced the consequential caller: `LeaseCoordinator.renew()` →
`broadcast()`; an unconfirmed renewal past `leaseTtlMs` (default 60s, renewal
cadence 120s) **self-suspends the holder**. The fleet's documented receiver-side
event-loop stalls run 5–40s — so a 10s abort converts "slow-but-alive peer"
into "no medium" and falsely demotes a healthy awake machine, the exact
opposite of the lease's purpose. Fix applied pre-commit: default 30s (above the
stall envelope's bulk; a truly hung socket never returns, so the wedge bound is
unchanged), derived from config at the construction site so an operator-widened
TTL keeps proportion. The pull path is insensitive (a lost learning tick
retries in 5s and never feeds self-suspend).

## What this does NOT change

The pull/broadcast cadence, the lease/renewal/suspend semantics, and the
anti-blinding guarantee are untouched. Sibling transports
(`HttpLiveTailTransport`, `ReplyMarkerTransport`) share the no-timeout +
per-attempt-log pattern at lower blast radius — next audit targets
<!-- tracked: CMT-1109 -->.

## Tests

`PeerFailureLogGate.test.ts` (6): state-change semantics, key independence,
streak restart, and the P19 sustained-failure bound (a day of 5s-cadence
failures → 49 lines, not 17,280). `HttpLeaseTransport.test.ts` (+5): every
outbound request carries an AbortSignal; pull and broadcast failure logging
gated (25 failures → 3 lines; non-ok 403 streak → 2 lines); recovery logs once;
server.ts timeout-derivation wiring pin. All pre-existing lease suites
(coordinator, convergence, stale-peer demotion, leasePull, standby observation)
green — no pin on the old per-attempt format existed (reviewer-verified).

## Rollback

Pure in-process; revert the commit. No persistent state, no config migration
(the derivation reads existing `leaseTtlMs`).
