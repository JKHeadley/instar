# Side-Effects Review — Live-Tail Stale-Standby Signal

**Version / slug:** `livetail-stale-signal`
**Date:** `2026-06-06`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `focused adversarial reviewer subagent — CONCUR (all four novel-integration probes clean; the episode-latch pattern itself carries two same-night CONCUR reviews)`

## Summary of the change

`LiveTailSource` gains the Eternal Sentinel's condition-4 observability for its capped-backoff retry loop: per-topic `failingSince` episode stamp + episode-keyed one-shot latch; the first attempt at/after `staleSignalAfterMs` (default 30min) logs once and calls the optional `reportStaleStandby` dep once per episode; success clears both. `server.ts` wires the dep to `DegradationReporter` (`LiveTail.standbyFreshness`, topic name resolved). Files: `LiveTailSource.ts`, one wiring block in `server.ts`, tests.

## Decision-point inventory

- `LiveTailSource` failure branch — **modify (additive)** — adds episode accounting + one-shot signal; backoff, retry, delta, and seq semantics untouched.
- `server.ts` LiveTailSource construction — **modify** — wires the reporter dep.

## 1. Over-block / 2. Under-block

Nothing blocked — pure signal. Detection bound: threshold + one backoff window (≤5min at cap; reviewer-confirmed attempts always resume when the window opens). Known pre-existing edge (traced by reviewer, probe 3): content reverted to exactly-streamed state while failures>0 keeps rebuilding content per tick (version gate stays bypassed) — a #867-era micro-inefficiency in a bizarre edge, unchanged here; `failingSince` persisting there is correct (success remains the only exit). Remaining audit targets <!-- tracked: CMT-1109 -->.

## 3. Level-of-abstraction fit / 4. Signal vs authority

The latch lives in the loop it observes (third use of the established suppressor shape tonight); delivery rides the standard degradation channel — deliberately NOT the attention queue or Telegram (a stale standby copy is operator-relevant housekeeping, not a user decision). **Signal-only** per `docs/signal-vs-authority.md`: the dep can only record; removing it restores byte-identical behavior (test-pinned).

## 5. Interactions

- **Concurrency:** flushAll is sequential; all map mutations are post-await synchronous code — no double-stamp path (reviewer probe 1).
- **Flood:** all topics share ONE reporter feature key with a 1h alert cooldown — N simultaneously-stale topics ⇒ at most one user-facing alert; per-topic records remain for inspection (reviewer probe 4). Bounded Notification Surface: no topic creation, no per-element pings.
- **Handoff force path:** shares failure accounting — a forced attempt's failure correctly extends the episode.

## 6. External surfaces / 7. Rollback

Logs + degradation records only; no API/schema/config/persistent state (defaults in code; dep optional). Rollback = revert; only the silence returns.

## Conclusion

Third and final observability fix in tonight's P19 series: the reaper loop got its back-off (#863), the supervisor healer got its voice (#871), the lease wire got its brakes (#874), and now the live-tail's sanctioned forever-retry can no longer go quietly stale. Persistence everywhere, silence nowhere.

---

## Phase 5 — Second-pass review (cross-machine continuity → performed)

The episode-keyed one-shot latch pattern carries two same-night line-level CONCUR reviews (supervisor escalation; mesh brakes). A focused adversarial pass probed only this PR's novel integration points: (1) episode-stamp timing across the awaited broadcast + same-topic concurrency — no double-stamp (sequential flushAll, single-threaded post-await mutations); (2) firing bound under backoff gating — threshold + ≤1 backoff window, and no stuck-in-backoff-without-attempts path exists; (3) the `recordNoNewContent`-while-failing edge — traced: cannot fire spuriously, cannot wedge, success is the only episode exit; (4) DegradationReporter flood analysis — per-feature 1h cooldown caps user-facing volume at one alert regardless of topic count. Ran the 21-test suite + tsc — green/clean. **Verdict: CONCUR.**
