# Side-Effects Review — Age-Timeout Kill Back-off

**Version / slug:** `age-kill-backoff`
**Date:** `2026-06-05`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent — CONCUR (with one non-blocking accuracy fix, since applied)`

## Summary of the change

The `SessionManager` age-gate (`monitorTick`, runs every 5s) used to re-request a kill for an over-age, idle-at-prompt session on every tick. When the §P2 KEEP-guard inside `terminateSession` vetoed the kill (returning `{ terminated:false, skipped:<reason> }` for a session with a recent user message / topic binding / open commitment), the session survived but the gate threw away that verdict and re-asked 5s later — forever (the 2026-06-05 17,503-line flood + wasted CPU read as "heavy load"). This change adds a pure, bounded back-off ledger (`src/core/AgeKillBackoff.ts`) and wires it into the age-gate (`src/core/SessionManager.ts`): after a veto, `recordVeto` suppresses re-requests for `ageKillBackoffMinutes` (default 10, new optional field on `SessionManagerConfig` in `src/core/types.ts`); `shouldRequest` gates the re-ask; `recordKilled` cleans up on an actual kill. Files touched: `AgeKillBackoff.ts` (new), `SessionManager.ts` (import + construct + gate the age-kill branch), `types.ts` (one optional config field). Decision point: the age-gate's kill-request *frequency* only — never the kill *decision* itself.

## Decision-point inventory

- `SessionManager.monitorTick age-gate` — **modify** — gates how OFTEN it re-requests a kill for a kept over-age session; does not change the kill predicate.
- `§P2 KEEP-guard inside terminateSession` — **pass-through** — unchanged; remains the sole authority over WHICH sessions die. The back-off only consumes its verdict.
- `AgeKillBackoff ledger` — **add** — a pure signal-suppressor (no kill authority of its own).

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The only thing "suppressed" is a redundant *kill request* for a session the guard ALREADY decided to keep within the last `backoffMs`. It never suppresses a kill of a genuinely-reapable session: a session is only in back-off because its most recent kill request was vetoed (kept). The one edge worth naming: a session kept at T0 whose keep-reason lapses at T0+1min is not re-evaluated until the back-off window expires (≤10min) — so a now-abandoned session lingers at most ~10 extra minutes before its first re-ask. That is a delay in *cleanup of an idle session*, not an over-block of any live work, and it is bounded and reversible (`ageKillBackoffMinutes: 0` restores instant re-checks). Note a re-engaged session needs no special handling: its new injection makes it non-idle, so the age-gate takes its active-work branch (never the kill branch) — it is never age-killed while active regardless of the back-off window. (`reset()`/`clear()` exist as ledger-maintenance API exercised by the unit suite but are intentionally NOT wired into the injection/removal paths in this PR — they would be redundant given the active-work branch, and memory is already bounded by `maxTracked` eviction.)

## 2. Under-block

**What failure modes does this still miss?**

It does not unify the two redundant mechanisms (the crude age-gate and the sophisticated `SessionReaper`) — that larger refactor is tracked separately (spec §Follow-up, topic-18423). It also does not change the age THRESHOLD (still `maxDurationMinutes + 20%`); a mis-tuned threshold would still mis-classify, just without the flood. Neither is a regression — both are pre-existing and out of this fix's stated scope. A `backoffMs` set absurdly high by an operator would delay legitimate cleanup of abandoned sessions, but the KEEP-guard still gates the eventual kill, so nothing dies wrongly.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. It is a low-level, deterministic suppressor sitting at the exact layer that was generating the redundant requests (the age-gate inside `monitorTick`). It deliberately does NOT re-implement the reap decision — it consumes the existing authority's verdict. It mirrors the established `AttentionTopicGuard` pattern (pure logic, injectable clock, bounded memory) rather than inventing a new shape. The smarter authority (`terminateSession`/KEEP-guard) already exists and is FED by this, not duplicated.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] No — this change produces a signal (a "stop asking for now" suppressor) consumed by / feeding the existing smart authority; it holds NO kill authority.

The back-off ledger cannot kill anything. It can only make the age-gate *skip a redundant request*. The kill decision remains 100% with `terminateSession`'s KEEP-guard, which has the full multi-signal context. Brittle-detector-with-block-authority is explicitly avoided: the brittle part (an age timer) was ALREADY there; this change strictly *reduces* how often that brittle part speaks, and routes nothing past the smart authority.

## 5. Interactions

- **Shadowing:** The `!shouldRequest` branch falls through to the existing idle-detection block exactly as the prior code path did on a kept session — it does not shadow idle detection or any other monitor check. Verified in the diff: the new `else if` sits between the active-work branch and the kill branch and `continue`s to the same place.
- **Double-fire:** No. Two paths exist (`terminated` → `recordKilled`; `!terminated` → `recordVeto`) and they are mutually exclusive on a single `terminateSession` result. No other component writes the ledger.
- **Races:** The ledger is a plain in-process `Map` touched only from the single-threaded `monitorTick` loop (`shouldRequest`/`recordVeto`/`recordKilled`) — no cross-thread/async sharing, and no write from the injection path. Bounded by `maxTracked` (1024) with oldest-eviction, so it cannot grow unbounded even across thousands of session ids; a stale entry for a removed session id self-evicts and is harmless (that id never returns).
- **Feedback loops:** None. Suppressing a request cannot change whether the guard would keep the session; it only changes cadence.

## 6. External surfaces

- **Other agents / users:** None directly. The behavior ships to every agent on update, but the only observable change is *fewer* log lines and *less* wasted CPU — strictly a reduction in noise. No API, message, or schema surface changes.
- **External systems:** None (no Telegram/Slack/GitHub/Cloudflare interaction).
- **Persistent state:** None. The ledger is in-memory only; nothing is written to disk, no migration, no new column.
- **Logs (the intended visible change):** the per-tick "Requesting kill" flood for kept sessions collapses to ONE "over age but KEPT (reason); backing off re-checks" line per back-off window. Operators / log scrapers keying on the old high-volume line will see far fewer of them — a benign reduction.
- **Timing:** Introduces a bounded ≤`backoffMs` delay before re-checking a kept-then-lapsed session (analyzed in §1).

## 7. Rollback cost

Pure in-process code change. Back-out = revert the commit and ship a patch, OR set `ageKillBackoffMinutes: 0` in config (instant per-agent disable, restoring exact legacy every-tick behavior with no restart-coupled migration). No persistent state to clean up, no agent-state repair, no user-visible regression during the rollback window (the only difference users could notice is the log flood returning).

## Conclusion

This review produced no design changes — the implementation already matched the converged spec's signal-not-authority shape. The review confirmed: (a) the KEEP-guard remains the sole kill authority (no over-block of live work; at most a bounded ≤10min delay in cleaning up a session whose keep-reason just lapsed), (b) no persistent state / external surface / race, and (c) a trivial dual rollback (revert or `ageKillBackoffMinutes:0`). Migration parity is met by the in-code default, consistent with the sibling `defaultMaxDurationMinutes` dial (neither is in `migrateConfig`). Because this touches session lifecycle (kill path), a Phase-5 second-pass reviewer audit is required before commit; this artifact awaits that concurrence.

---

## Phase 5 — Second-pass review (session-lifecycle change → required)

An independent reviewer subagent audited the diff, spec, artifact, and both test files at line level, specifically probing whether the back-off could ever prevent a genuinely-abandoned session from being killed, ledger memory safety, veto/kill mutual-exclusion, the `!shouldRequest` fall-through, and migration safety.

**Verdict: Concur with the review.** The core safety invariants hold under line-level inspection: `recordVeto` is only reachable when `terminateSession` returns `terminated:false`, so a no-keep-reason session is never backed off and dies on its first ask; the `!shouldRequest` branch falls through to the fully independent idle-detection / idle-zombie kill path, so a genuinely-abandoned backed-off session is still reaped; `recordVeto`/`recordKilled` are mutually exclusive on one result (no ledger corruption); the `Map` is bounded by `maxTracked` oldest-eviction; and the in-code default safely mirrors the sibling `defaultMaxDurationMinutes` with no migration needed. The change alters only the FREQUENCY of asking, never WHICH sessions die.

**One non-blocking accuracy defect raised — and fixed:** the reviewer noted that the spec (Design step 3) and this artifact (§1/§5) originally claimed `reset()` was wired into the injection path and `clear()` on session removal, but neither is actually called in production (they are API exercised only by the unit suite). Practical impact was nil (a re-engaged session is already protected by the age-gate's active-work branch; memory is bounded by eviction), but the docs were inaccurate. Resolution: the spec and this artifact were corrected to state accurately that `reset()`/`clear()` are unwired maintenance API and that a re-engaged session is protected by the active-work branch — the implementation was left as-is (wiring `reset()` across the tmux→session.id key boundary would add risk for zero behavioral benefit, per the reviewer's own analysis). Spec and code now agree.
