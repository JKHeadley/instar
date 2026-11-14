# Side-Effects Review — update restarts wait for peer verifies; helper skips are recorded

**Version / slug:** `local-verify-peer-skew-audit`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** independent reviewer subagent, see below

## Summary of the change

Tier 1, 3 source files, about 110 source lines, two commits plus a merge from main. Two throughput changes in the Local Verify coordinator.

1. **Update restarts wait for accepted peer attempts.** `LocalVerifyService.restartHolds()` now also names each accepted peer attempt that qualifies for the existing peer hold (live lease, same epoch, peer answered within two poll periods), bounded by `sentAt + 21 min` and the updater's deferral ceiling. The updater consults these holds before it writes `restart-requested.json`. When fewer attempts qualify, for any reason, the existing recheck runs, so the restart does not sit out its retry timer.
2. **Helper skips are recorded.** `dispatchOnce` already skips a peer whose verifier version or policy hash differs. It now appends `peer-skipped-skew` once per version change and `peer-skew-cleared` when it ends.

Why (1): #2835 published these attempts in `peer-hold.json` for the restart consumers to read. On Studio, the lifeline's supervisor consumes the request, and that process started 2026-11-06T01:25Z, before #2835 merged, so it restarted past the file. Between 17:40Z and 01:30Z there were 10 `lease-changed` abandons (109.9 peer-minutes) and 0 `restart-held-for-peer` rows. Log line order for v1.3.1694 shows the supervisor restarting, while the newer `ForegroundRestartWatcher` in the server logged a deferral for the same request. The updater runs in the server process, so it always has current code.

Why (2): on 2026-11-06 the M5 peer stopped receiving work at about 13:13Z and the log showed nothing for over four hours.

## Decision-point inventory

- Update restart gate (`gatedRestart` holds) — modified: one new kind of bounded hold through the existing provider.
- Verifier pause (`decideUpdatePause`) — pass-through. Peer hold names start `local-verify:`, so they count as this verifier's own hold and no new dispatch starts while the pause applies (limits in section 1).
- Peer dispatch admission — pass-through. The skip condition is unchanged; the new call only records it.

## 1. Over-block

While the verifier's pause applies, an update waits at most 21 minutes per attempt with no new work starting, as already happens for a local run. Peer runs had a 13.0-minute median and 14.5-minute p95 in the pass 7 sample. The pause lifts when other blockers exist or the update has been pending over 120 minutes; attempts can then chain, and the limit is the existing deferral ceiling (`maxDeferralHours`, default 4 h), after which holds are bypassed. Local runs already chain this way. A new target version resets that ceiling. A peer that stops answering drops out within two poll periods (about 2 minutes), and the recheck then runs. `bypassHolds` (a forced apply or the deferral ceiling) skips the hold. Only the lease-holding coordinator has reserved attempts, so helper machines and agents without peers behave exactly as before.

## 2. Under-block

A coordinator stall or sleep over about two minutes, while a restart is deferred on a peer, can make a healthy peer look quiet; if its next answer takes over a second, the restart goes ahead and that attempt is lost, as it was before this change. Accepted as the worst case. Restarts not written by the updater (config restarts, the watchdog) still reach the lifeline directly and are not held until it reloads. Skew rows are written only while `dispatchOnce` reaches the peer, so they mark the first skip that mattered, not the moment skew began; a coordinator restart forgets the dedupe key, so one further row can appear.

## 3. Level-of-abstraction fit

It reuses the qualifying rule from `writePeerHold`, now a shared method, and the provider already used by the local run hold. No parallel check is added. `peer-hold.json` stays for the other restart writers.

## 4. Signal vs authority compliance

Reference: `docs/signal-vs-authority.md`. The hold has narrow authority to delay a restart. It is bounded per attempt and by the deferral ceiling, fails open when the peer is quiet or the provider throws, and can be bypassed. Skew rows are pure signal.

## 5. Interactions

`recheckRestartHolds` only brings forward a retry already scheduled, and it runs the whole gate again. `getRestartBlockers` also feeds Threadline connect-enable, whose five-minute wait can now give up on a coordinator with a peer attempt running, as it already can for a local run. The audit row is written only when the durable deferral names a peer attempt, so window and session deferrals do not count as holds. Its end row can be missing when the request is written first; the restart follows either way. The audit trail uses the durable deferral state rather than the moving pending time, so retries do not write duplicate rows. When the supervisor later has the new code, both paths agree: the request is not written until the hold ends. The cached peer status is read, so no extra network call is made, and the peer breaker is untouched.

## 6. External surfaces

Restart blockers may show `hold:local-verify:peer-pr-N`. `restart-held-for-peer` rows now also appear for update restarts, plus two new event names in `logs/local-verify.jsonl`. No route or config change. The hold path sends no message; the existing once-only loop-breaker notice could include the peer hold's reason. Row rate is bounded by attempts and version changes.

## 7. Multi-machine posture

Machine-local by design: reservations belong to the lease-holding coordinator. A lease change drops the attempt from the hold, and a new holder starts with no dedupe key and records any skew afresh.

## 8. Rollback cost

Revert the commits. No state, migration or config involved. Durable deferral records already clear themselves when holds end.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, Claude Code), two rounds, 2026-11-06.

Round 1: "Concern raised": the 21-minute bound and pause claim held only while the pause applies. It found no code defect that strands an update. Also raised: audit rows could count window and session deferrals, a quiet peer waited on the retry timer, and the test bypassed the recheck. All fixed in this change.

Round 2: "Concur with the review". Traced all 9 `abandonRemote` call sites, `peerHoldCount` drift and the recheck during the poll loop. One non-blocking limit, recorded in section 2 and accepted.
