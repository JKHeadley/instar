# Side-effects review — SelfHealGate extensions for the context budget sentinel

**Version / slug:** `cb-selfheal-ext`
**Date:** 2026-11-10
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.4 ("Each ladder is a `SelfHealGate` declaration … The gate needs four named extensions for this use, built in Phase 0: a `pool-shared` controller resource that **refuses** (not merely records) when this machine is not the owner; an asynchronous remediation …; **per-incident episode keys** (`topic+cause+incidentId`) with **bounded pruning** of terminal episodes …; and a **per-key ring** (the derived cap is four episodes per `topic+cause`, evicting the oldest terminal episode, refusing only when all four are live, and pruning terminal episodes at the next tick), in the sentinel's **own episode store file** so its cap is per controller and never darkens another consumer's gate"). Converged 6 rounds, approved 2026-11-09 17:22 PST. Phase 0 task 10, part a.
**Tier:** 2 (changes a gate with three production consumers). Size: 1 source file (~90 changed lines) + ~330 test LOC.

## Summary of the change

All four extensions are OPT-IN; a spec or store that does not ask for them behaves exactly as before.

1. **Pool-shared controller** — `controllerResource: 'pool-shared'` is now accepted only with an `isOwner(ctx)` check (constructor refuses it otherwise). `attempt` and `recordHealthy` return `governed: not-owner` unless `isOwner` is exactly `true` (`false`, `'unknown'` or a throw all refuse), BEFORE an episode is created, admission is asked or anything is touched. Ownership is re-checked at every later step: in the eligibility callback the governor re-runs for a queued admission, at the start of the admitted run (so a queued admission that fires after ownership moved touches nothing and sends no notice), inside the atomic claim, and after an async remediation's await.
2. **Async remediation** — `remediationMode: 'async'` with `remediationAsync` and a required `maxRemediationMs` (≤ `maxWallClockMs`, so also below the `setTimeout` overflow). A timeout is `not-healed: remediation-timeout`, a rejection or malformed result `not-healed: io-error`; the attempt was already counted by the claim (durable before the remediation runs). One remediation per episode key is in flight per process (`busy: remediation-in-flight`), and the hold lasts until the WORK settles — not just until the gate stops waiting — bounded by the episode's wall clock; after the await, ownership and the row are re-read. The sync path is unchanged (a returned promise is still refused).
3. **Per-incident keys + bounded pruning** — keys were already caller-defined. Stores gain `pruneWhere(select)` and `pruneTerminal()` (recovered, or exhausted with every notice enqueued — an exhausted row whose notice failed is kept, and the next attempt retries the notice). `SelfHealGate.pruneTerminal()` is the per-tick call over THIS ladder's rows only (pool-shared ids may not contain `:`, so the `<id>:` prefix cannot overlap another ladder): recovered episodes at once; exhausted ones only after `exhaustedRetentionMs` (default 24 h, the breaker's window), so the same incident can never re-open a ladder that already gave up and paged; and ABANDONED active ones — IDLE (not updated) for a whole wall clock, no restart pending, nothing in flight here — the case where ownership moved mid-incident and this machine can no longer close or exhaust the episode (audited as `pruned-abandoned-active` with a count). Idle, not old: a ladder still being attempted rewrites its row each attempt and so exhausts with its notice through `attempt`, whatever order a tick calls prune and attempt in. An unparseable row is never deleted.

   *Deviation, stated:* the spec says "pruning terminal episodes at the next tick". Recovered episodes are; exhausted ones wait 24 h, because the sentinel keeps the same incident id while an incident persists, and pruning an exhausted row at once would re-open its ladder and page again every wall clock (found in review). The ring can still evict an exhausted row under pressure, so retention never makes a topic+cause go dark.
4. **Per-group ring in an own store file** — `SelfHealStoreOptions { maxRows?, ring?: { groupOf(key), perGroup } }` on both stores: creating one more episode in a full group evicts the group's OLDEST TERMINAL episode and refuses only when all are active; with a ring the global cap also evicts the oldest terminal episode before refusing. The sentinel passes its own database path (task 10b). Defaults: `maxRows` 256, no ring — today's behaviour.

## Decision-point inventory

- **Changed:** `SelfHealGate` construction (accepts pool-shared with `isOwner`; validates the remediation mode) and attempt admission (owner refusal, in-flight refusal). Both only for specs that opt in.

## 1. Over-block

- A pool-shared ladder refuses whenever ownership is `'unknown'` — deliberate (§9.4: sentinels elsewhere observe and record). During an ownership move the ladder pauses until the new owner acts.
- With a ring, a fifth incident while four are live is refused (`state-failure: create-failed`, which notices once per boot) — the spec's "refusing only when all four are live".

## 2. Under-block

- The in-flight guard is per process. Two processes on one store (not a production shape: one server per agent home) could each run a remediation for the same key; the durable attempt counter still bounds the total. Remediations themselves must be idempotent (`remediationActions.idempotencyGuard`), as for every consumer.
- A timed-out remediation is not cancelled (JavaScript cannot cancel a promise); it may still finish after the gate has counted it `not-healed`, and its result is not recorded. No second remediation for that key starts until it settles (or the wall clock passes). Async remediations must still be fenced on their own state (the fold's fenced lease and record CAS, §9.3).
- Pruning an abandoned active episode skips its exhaustion notice. On an ex-owner a notice is forbidden anyway; on the owner, an episode only goes untouched past its wall clock if the sentinel stopped ticking it, and the sentinel's own breaker (task 10b) is where repeated failures are counted.
- Pruning deletes exhausted episodes, so an exhausted per-incident key could be reused after pruning. Callers mint a fresh incident id per incident (the spec's `topic+cause+incidentId`); the 24 h same-cause breaker lives in the sentinel (task 10b), not in the episode rows.

## 3. Level-of-abstraction fit

Extends the existing gate as the spec requires ("declared once, not re-implemented per watcher") instead of a parallel ladder engine.

## 4. Signal vs authority compliance

The gate's authority is unchanged in kind (it bounds a consumer's own remediations). The new owner refusal only narrows what a pool-shared consumer may do.

## 5. Interactions

- **Existing consumers** (the two construction sites: feedback-defaults heal and skill-learning attention): both hardware-bound, sync, default store — untouched; their tests pass unchanged, and an integration test runs the feedback-defaults consumer beside a FULL ladder store in the same state directory.
- **Self-action governor:** unchanged; the new paths call `admit`/`consumeToken` exactly as before, and the not-owner refusal happens before admission (no governor traffic from non-owners).

## 6. External surfaces

None.

## 7. Multi-machine posture

The pool-shared mode IS the multi-machine posture: each machine keeps a machine-local episode store and only the topic's owner acts; ownership moving moves who acts (integration test with two machines).

## 8. Rollback cost

Revert. No consumer uses the extensions until task 10b; no stored data changes shape.

## Class-Closure Declaration

- `unbounded-self-action` — closure `bounded`: every ladder stays under `maxAttempts`, `maxWallClockMs`, flap and the governor; the ring and `maxRows` bound the episode store; the async wait is bounded by `maxRemediationMs`.

## Evidence

- `tests/unit/SelfHealGate-extensions.test.ts` (32): pool-shared requires `isOwner`; `false`/`'unknown'`/throw ⇒ not-owner with no episode, no remediation, no admission (also `recordHealthy`); ownership lost before the admitted run, or exactly at the claim, refuses; a QUEUED admission that fires after ownership moved touches nothing and sends no notice (and the governor's eligibility callback sees the move); ownership lost during an async await is `not-owner` with nothing recorded; owner remediates. Async: construction rules; awaited heal; timeout ⇒ `remediation-timeout` and counted; rejection and malformed result ⇒ `io-error`; one in flight per key (a second attempt is busy; a different incident proceeds); a timed-out remediation still running keeps its key busy and the next attempt proceeds once it settles; `maxRemediationMs` above the wall clock or 2^31 is refused; the sync path still refuses a promise. Abandoned episodes: four incidents whose ownership moved fill the ring, and the prune frees them once past the wall clock; prune never touches another ladder's rows; an exhausted row with a failed notice is kept and the notice retried; a ring needs a `groupOf` function; an unreadable SQLite row is kept and never blocks other keys. Ring + prune on BOTH stores: oldest terminal evicted; refuse only when all live; another group unaffected; global cap evicts terminal first; prune keeps active. Defaults: no options keeps the 256 cap and never evicts; per-incident keys free the next incident after one is exhausted.
- `tests/integration/self-heal-gate-pool-ladder.test.ts` (2): a full ladder store in its own file never darkens the production feedback-defaults consumer in the same state directory; two machines, one owner — only the owner remediates, ownership moving moves who acts, non-owners create no episode, prune per machine.
- `tests/e2e/self-heal-gate-async-crash.test.ts` (1): a REAL child process dies inside an async remediation; the next boot finds the attempt durably counted, nothing stuck in flight, the ladder exhausts with exactly one notice, prune removes it and the next incident starts.
- Existing `SelfHealGate.test.ts`, `skill-learning-attention.test.ts`, `SqliteRegistry-wiring.test.ts` and `self-heal-gate-alive.test.ts` unchanged and green; `tsc --noEmit` clean.

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-10 03:25 PST): "Concern raised."** BLOCKING: (B1) a queued admission that fired after ownership moved ran `runAdmitted` with no owner check — the probe saw the episode revised, the latch rewritten and a `latency` notice sent from the non-owner, and the `eligible` callback checked only the fence; (B2) live episodes leaked when ownership moved mid-incident (the ex-owner's `recordHealthy` refuses, prune took only terminal rows), so after four such incidents the ring refused that topic+cause permanently. MINOR: (1) a timeout released the in-flight guard while the work still ran (two concurrent remediations for one key); (2) `maxRemediationMs` unbounded (2^31 overflows `setTimeout` to ~1 ms); (3) no ownership re-check after the await; (4) prune deleted an exhausted row whose notice never went out; (5) per-tick `refused-not-owner` audit rows overwrite the 1024-slot audit ring; (6) `groupOf` not validated; (7) the doc named consumers that do not construct the gate; (8) test gaps (queued path, ownership during the await, retry after timeout, unparseable row).

**Resolution:** B1 fixed — ownership checked first in `runAdmitted` and in the governor's eligibility callback (test: queued admission fired after the move leaves the revision unchanged, no remediation, no notice). B2 fixed — the gate's per-tick prune also removes this ladder's ABANDONED active episodes (past the wall clock, no restart pending, nothing in flight), scoped to the ladder's own key prefix (test: four ownership-moved incidents fill the ring; past the wall clock the prune frees it and the next incident proceeds). Minors 1–6 fixed as described in the Summary (in-flight held until the work settles, bounded by the wall clock; `maxRemediationMs` ≤ wall clock; owner re-check after the await; exhausted rows with a pending notice kept and the notice retried; non-owner refusals not audited; `groupOf` validated). 7 corrected. 8: tests added for each.

**Re-check 1 (same reviewer, 2026-11-10 03:34 PST): "Concern raised."** B1, P2–P5 and P7 verified fixed by probe. New BLOCKING in the B2 fix: the abandoned rule keyed on `startedAt` fired at the same instant `attempt` would exhaust, so a tick that prunes before it attempts silently deleted a live ladder on the owner — 8 remediations in 40 ticks, zero notices, never exhausted. MINOR: prefix overlap if a ladder id contains `:`.

**Resolution:** abandoned now means IDLE for a wall clock (`updatedAt`), audited with a count. Fixing it exposed a second path to the same loop — pruning an exhausted row at once let the same incident start a new ladder and page every cycle — so exhausted episodes are retained for `exhaustedRetentionMs` (default 24 h; deviation stated above). Pool-shared ids may not contain `:`. Tests: prune-before-attempt on the owner for 40 ticks ends `exhausted` with exactly one exhaustion notice; recovered pruned at once and exhausted only after 24 h; the e2e checks the exhausted incident stays exhausted after a prune while the next incident starts.

**Re-check 2 (same reviewer, 2026-11-10 03:39 PST): "Concur with the review."** Probe PA over 50 simulated hours: 6 remediations and 3 `wall-clock` notices (one bounded ladder and one page per retention period for an incident that never closes), identical for either call order; all earlier probes still fixed; the 24 h retention judged right and unable to darken the ring. MINOR: (1) `exhaustedRetentionMs` was unvalidated — fixed: finite and ≥ `maxWallClockMs`, tested; (2) the idle rule assumes the caller ticks more often than the wall clock — the sentinel (task 10b) attempts before it prunes and ticks every 5 minutes against a 15-minute-plus wall clock; that ordering is part of its contract. <!-- tracked: CMT-1536 (Phase 0 task 10b: sentinel attempts before it prunes; tick interval below every ladder's wall clock) -->
