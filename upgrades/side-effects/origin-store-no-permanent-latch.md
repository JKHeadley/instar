# Side-Effects Review — origin store worker recovers instead of latching dead

**Version / slug:** `origin-store-no-permanent-latch`
**Date:** 2026-09-26
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (see below)

## Summary of the change

`src/messaging/telegram-origin/OriginStore.ts` used to latch itself unavailable for the life of the process on the first request past its 2-second timeout, or on any worker error or exit. It now manages worker generations:
- A caller deadline rejects only that caller (outcome unknown for writes), and the worker keeps serving.
- A separate stall deadline (30s of no worker progress while requests are outstanding, reset by every response) marks a generation stuck.
- A failed generation (stall, startup failure, error, exit) is replaced after exponential backoff (1s doubling to 30s, cap 6 consecutive failures, budget restored only after a generation stays failure-free for a 5-minute healthy window).
- Past the cap the store is `exhausted` and waits for the runtime's existing 15-minute recovery reopen. That reopen now uses `openReplacement()`, which inherits the spent count and the open outage episode.
- There is one `DegradationReporter` report per outage and a `health()` projection.

`TelegramOriginRuntime.recoverHeld()` reopens only on `needsReplacement()`, and it calls `restartNow()` for a store that is mid-backoff. `storageHealth()` is exposed through `status().storage` and through the authenticated `/health` → `telegramOriginStorage`. `StoreTypes.OriginStoreOptions` gains `stallTimeoutMs` and `restart`.

Other changes:
- New CLAUDE.md awareness paragraph (template, migration and shadow mirror).
- A docs paragraph.
- Registry entry `origin-store-worker-restart`.
- Test-only fault-injection wrapper worker.

## Decision-point inventory

- `OriginStore.call` admission (ready → post; otherwise reject): **modify**. Previously a latched flag; now a generation state. It still fails closed when not ready.
- `OriginStore.fail` (generation failure → restart or exhausted): **modify**. It was terminal, and is now a bounded restart.
- Caller deadline vs stall deadline: **add**. The caller deadline no longer terminates the worker.
- `TelegramOriginRuntime.recoverHeld` reopen condition: **modify**. It was `isUnavailable()` and is now `needsReplacement()`, plus `restartNow()` for a mid-backoff store.
- `TelegramOriginService.admit` / hold mapping: **pass-through**. It still maps store failures to `execution-admission-unavailable` and holds.

---

## 1. Over-block

Less over-block than before. A single slow request used to block every later send until a manual restart; now it holds only its own send.

One new transient over-block: while a generation is restarting (at most about 1s to 30s per step), sends are held. The old code held them forever. Held sends keep their memory-held payload and the durable outbox, and drain through the existing recovery tick.

A legitimately slow operation over 30 seconds (for example a very large archive pass) would now be treated as a stall and its generation replaced. Under the old code it would already have been killed at 2 seconds, so this is strictly more lenient.

---

## 2. Under-block

Fail-closed is kept: no ready generation means no admission, and nothing is sent unrecorded.

Remaining misses:
- A worker that answers but whose backend errors on every call (for example a corrupt database that opens) is "responsive". It is not restarted, and operations fail as operation errors. That is the correct classification: a restart would not fix it, and it is visible through the existing error paths.
- A process restart resets the restart budget. Process restarts are bounded by the lifeline's own controller.
- Sends held during the outage are delivered by the existing delivery-sentinel recovery tick (5-minute cadence), not immediately on recovery. New sends succeed immediately.

---

## 3. Level-of-abstraction fit

Recovery belongs to the owner of the worker, the store. Before, recovery lived only in the runtime's 15-minute reopen, which sat behind the 5-minute sentinel tick; that is too coarse for a transient stall.

The runtime keeps its slower replacement role for a store that has given up. The service's own 1-second `within()` stage deadline already bounds each send, so the store's caller deadline never needed to be the kill switch.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new block/allow surface. The existing fail-closed rule (no recording, no send) is unchanged. The change only shortens how long the store stays unable to record.

The new logic is deterministic infrastructure: timers, backoff and a cap. It holds no judgment over message content or destination.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The stall deadline, backoff and cap are a safety bound on an automatic restart. Each of them is a deterministic floor by design, and none weighs conflicting live signals.

---

## 5. Interactions

- **Runtime replacement vs self-restart:** a double worker could appear if the runtime replaced a store that was restarting on its own. `recoverHeld` now reopens only when `needsReplacement()` (exhausted or closed); a mid-backoff store gets `restartNow()`, which spawns in place. There is at most one live generation per store object. Test: integration "replaces only a store that has given up, never one mid-restart".
- **Deliberate close:** `close()` sets `closing` and cancels any pending restart. A closed store never restarts itself (unit test). Existing tests that close a store to simulate outage still see the runtime replace it.
- **Timed-out request vs later reads:** the worker keeps the timed-out request. Reads posted afterwards serialize behind it, so read-after-timeout sees the committed state. That is the same guarantee the old "resolve committed state before retry" contract relied on.
- **Late responses:** a late response to an already-rejected caller is dropped and releases its pending bytes. It also counts as proof the generation is responsive.
- **Outage notifier:** `onHold` still requests the fixed outage notice for `execution-admission-unavailable`, which is unchanged. The notice path is independent of the recording worker.
- **Boot tick:** `TelegramOriginBoot` calls `confirmRecordingHealthy` every 5s. Once a restarted generation has stayed failure-free for the 5-minute healthy window, the next of those served responses closes the outage episode and resets the budget.
- **Feedback loop:** restarts do not feed the pressure that causes them, and the cap plus inherited budget bounds them. See the class-closure section.

---

## 6. External surfaces

- The authenticated `/health` gains `telegramOriginStorage`. Unauthenticated `/health` is unchanged (tested).
- `GET /telegram/origins/status` gains `storage`.
- Error text keeps the `origin worker is closed/unavailable` prefix, with the state appended in parentheses. Existing matchers keep working.
- Operator surface: no operator-facing actions. The state is read-only and shows in `/health` and the origin status.
- One degradation report per outage reaches the existing attention and feedback path.

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** The origin worker owns this machine's local SQLite outbox. Its health is a per-machine truth, like the process it lives in.

- Pool-wide origin reads keep their existing `?scope=pool` paths.
- No new user-facing notices: the existing one-voice outage notice path is unchanged.
- No new durable state: restart counters are in memory.
- No URLs.

---

## 8. Rollback cost

Pure code change. Revert and ship a patch. There is no persistent state, schema change or migration to undo.

The CLAUDE.md paragraph would remain in migrated agents, where it would be stale but harmless; a revert would also remove its migration. Users see no regression during the rollback window: the old behavior was the latch.

---

## Conclusion

Review-driven design changes:
1. The caller deadline was separated from the worker kill. This is the root of the incident: the 2-second timeout was both.
2. `recoverHeld` reopens only a store that has given up, and hastens one that is mid-backoff, so there is never a second worker racing the first.
3. `openReplacement()` carries the spent budget and outage, so the long-standing 15-minute reopen cannot turn into a fresh 6-restart burst and a fresh report every 15 minutes. That is what makes the restart loop settle under sustained pressure.

4. Second-pass findings (below) led to two more changes. The budget and outage episode now close only after a 5-minute failure-free healthy window, and the stall check became a single progress watchdog that every response resets.

The change is clear to ship once the full suite is green.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude), 2026-09-26
**Independent read of the artifact: concern → resolved → concur** (re-check of the two fixes: "Concur with the review")

- **Concern 1, unbounded restart cycle.** Any served response reset the budget and closed the episode. A stall that recurs between served responses (for example a retention or recovery operation that always takes more than 30s, with the 5s health transaction served in between) would therefore restart forever and file a new report each cycle. The class-closure claim was false.
  - **Resolved:** `markResponsive()` restores the budget and closes the episode only when the generation has been ready for `restart.healthyWindowMs` (default 5 minutes).
  - **Test:** a stall recurring between served responses reaches `exhausted` with one report.
- **Concern 2, stall clock included queue wait.** Each request's own 30s timer started at posting, so a busy but healthy worker at boot could be killed.
  - **Resolved:** there is now one progress watchdog. It fires only when the worker has answered nothing for the stall deadline while requests are outstanding, and every response re-arms it.
  - **Test:** three 400ms operations posted together, with 600ms of stall budget and about 1.2s of queue wait for the last one, keep generation 1.
- **Checked sound by the reviewer:**
  - stale-generation event guards
  - pending cleanup
  - the ready promise per generation
  - close during restart or startup
  - admission stays fail-closed
  - `openReplacement` after the cap (one attempt per 15 minutes, no new report)
  - keeping the worker alive after a caller deadline breaks no invariant (the synchronous worker serializes re-reads, and the service's `within()` already abandoned callers without a kill)
  - unknown-outcome writes are never replayed or reported as not-committed
  - no timer leaks

---

## Evidence pointers

- Incident log lines: `~/.instar/agents/echo/logs/server.log` 2026-09-26T07:00:06Z–07:03:42Z.
- `tests/unit/telegram-origin/store-worker-recovery.test.ts`, `tests/integration/telegram-origin-worker-recovery.test.ts`, `tests/e2e/telegram-origin-worker-recovery-boot.test.ts`.
- `tests/unit/self-action-convergence.test.ts` with `origin-store-worker-restart`.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action` (this change adds a self-triggered restart controller).
- **`closure`:** `guard`
- **`guardEvidence`:** `{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (controller origin-store-worker-restart), howCaught: "control-loop edge: generation failure → backoff → spawn; steady-state bound: at most 6 restarts per outage under sustained failure, horizon-independent; settling brake: consecutive-failure cap restored only after a 5-minute failure-free healthy window (a served response between recurring stalls restores nothing), and openReplacement() carries the spent count across the runtime's 15-minute recovery reopen so reconstruction adds no burst" }`
