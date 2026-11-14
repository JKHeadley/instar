# Side-Effects Review — a standby waits for the lease before it polls

**Version / slug:** `lease-poll-boot-hold`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** codex-cli gpt-6-astra, three rounds, concurred on the last; see docs/specs/reports/lease-poll-boot-hold-convergence.md

## Summary of the change

With `pollFollowsLease` live, the lifeline no longer polls at boot. The existing 15-second reconcile decides from the lease, and with no opinion for 3 minutes it polls as boot always did. The start path that promotion uses is made safe, because a held boot now always takes it: one pending start, cancelled by standby, stop or a refused token, intent read again after the flush, and only the newest poll loop continues.

## Decision-point inventory

- Boot poll — add — hold while poll-follows-lease is live. Poll start — modify — serialized and revalidated. Poll loop — modify — retired loops stop, including their error handling.

---

## 1. Over-block

The harm here is silence. A live holder restarting its lifeline starts about 35 seconds later than today; Telegram keeps the updates. A machine told standby stays quiet until promoted, which is the point. If its server then dies it stays quiet, as a standby does today under runtime reconcile; the other machine holds the lease, or takes over on the lease rule.

## 2. Under-block

A blind start remains at the 3-minute bound, on purpose: a single machine writes no intent. If a standby's server fails to boot it polls then, which is what every boot does today, and 409 is the backstop.

## 3. Level-of-abstraction fit

Decisions are pure functions in `pollDecision.ts`; the lifeline applies them. No second poll-ownership path is added.

## 4. Signal vs authority compliance

No new authority. The lease stays the authority for polling and force-poll and force-mute stay the local floor.

## 5. Interactions

The loop-generation check and the serialized start also apply to any agent already running poll-follows-lease live; they only remove races. The boot path's first loop uses id 0, unchanged. `holdsLease` reads `this.polling`, so it is false during a hold, which is true. The poll-owner lease is written only by a polling loop, so a server that reads it stays as it would on a standby.

## 6. External surfaces

None. No route, config default or message changes. One log line per hold.

## 7. Multi-machine posture

Machine-local: each lifeline reads its own config and its own server's intent. It supports the single-poller rule across machines and adds no cross-machine state.

## 8. Rollback cost

Set `pollFollowsLease.dryRun:true`, or revert. No state depends on it.
