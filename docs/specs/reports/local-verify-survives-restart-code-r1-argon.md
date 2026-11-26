# code review round 1 — Gemini 4 Argon (gemini CLI), 2026-10-25

**Verdict:** ready with changes

### Ranked Findings

1. **`checkStarved()` does not persist `starvedRaised: true` when no entry starts**
   - **Location:** `src/localVerify/LocalVerifyService.ts:1063`
   - **Problem:** When `checkStarved()` raises a starvation signal, it sets `e.starvedRaised = true` in memory. It relies on `this.pump()` (called at the end of `tick()`) to call `this.persistQueue()`. However, `pump()` only runs during `tick()`. More importantly, if `checkStarved()` mutates `e.starvedRaised = true` and `pump()` is skipped or if `persistQueue()` is called before `checkStarved()` in other paths, or if the process crashes right after emitting the signal before `pump()` persists, `starvedRaised` is not guaranteed to be flushed immediately upon raising the external signal. Calling `this.persistQueue()` inside `checkStarved()` when any entry transitions to `starvedRaised = true` ensures the once-per-entry guarantee survives an immediate crash/restart.
   - **Smallest fix:** Track `let changed = false;` in `checkStarved()`, set `changed = true` when `e.starvedRaised = true`, and call `if (changed) this.persistQueue();` after the loop.

2. **A drift restart (`keepServer: true`) suppresses a concurrent `keepServer: false` restart (e.g. `SIGTERM` / watchdog)**
   - **Location:** `src/lifeline/RestartOrchestrator.ts:86`
   - **Problem:** `RestartOrchestrator.requestRestart` serializes concurrent requests by dropping any request that arrives after `_state !== 'idle'`. If `LifelineDriftPromoter` triggers `requestRestart({ keepServer: true })` and, during the up-to-1500ms telemetry + quiesce + persist window, an external `SIGTERM` (`instar lifeline restart`) or watchdog trip arrives (which requires stopping the server via `supervisor.stop()`), the second request is suppressed and the lifeline exits leaving the server running when a full stop was requested.
   - **Smallest fix:** In `RestartOrchestrator`, if a new `requestRestart` arrives without `keepServer` while `_state === 'quiescing'` or `'persisting'` for a `keepServer: true` request, invoke a fallback or upgrade the in-flight request so `quiesce` (or a post-quiesce hook) stops the server before exiting.

3. **`decideStart` only checks `resumeFirst` on the first ready PR in queue order, not any ready PR with `resumeFirst`**
   - **Location:** `src/localVerify/LocalVerifyService.ts:337` (`const prIdx = i.queue.findIndex((e) => ready(e) && e.kind !== 'main');`) and `342` (`if (i.queue[prIdx].resumeFirst && !fs.mainRed)`)
   - **Problem:** `shutdown()` unshifts the interrupted entry to index 0, and `restoreQueue()` restores entries in saved order, so normally the `resumeFirst` entry is at `prIdx`. However, if a capacity requeue or error retry or in-place head move happens before the interrupted PR gets to start, or if multiple PRs were interrupted across restarts, an entry with `resumeFirst: true` could sit behind a ready PR without `resumeFirst`. `decideStart` only inspects `i.queue[prIdx].resumeFirst`.
   - **Smallest fix:** Find `const resumeIdx = i.queue.findIndex((e) => ready(e) && e.kind !== 'main' && e.resumeFirst);` and if `resumeIdx >= 0 && !fs.mainRed`, return `{ kind: 'start', index: resumeIdx }`.

4. **In-place head move (`keptPlace`) drops `interruptions` and `resumeFirst` history or leaves stale starvation state**
   - **Location:** `src/localVerify/LocalVerifyService.ts:873`
   - **Problem:** When a queued or in-flight PR pushes a new head SHA, `request()` preserves `firstQueuedAt`, `pausedMs`, and `starvedRaised` via `keptPlace`, and constructs a new `QueueEntry` with `attempts: 0, errorRetries: 0`. That resets `interruptions` and `resumeFirst` (which is fine since `starvedSignalKey` is keyed by `headSha.slice(0, 12)`), **except** `keptPlace` copies `starvedRaised: e.starvedRaised` onto the new head! If the old head raised `starved` (e.g. after 2 interruptions), the new head inherits `starvedRaised: true` and can **never** raise a starved signal (`local-verify:starved:<pr>:<newHead12>`) even though `localVerifyWiring.ts:43` states "one item per head; a new head is a new episode".
   - **Smallest fix:** In `src/localVerify/LocalVerifyService.ts:918`, do not carry `starvedRaised: true` across a head change (or reset `starvedRaised: false` when `headSha` changed).

5. **Spec promises `tests/unit/lifeline/drift-restart-keeps-server.test.ts` and E2E shutdown/restore test, which are missing from the diff**
   - **Location:** `docs/specs/local-verify-survives-restart.md:62-64` and `tests/e2e/local-verify-lifecycle.test.ts:97`
   - **Problem:**
     1. The spec (`docs/specs/local-verify-survives-restart.md` §Tests) explicitly lists `tests/unit/lifeline/drift-restart-keeps-server.test.ts` (`detach()` touches no session; lifeline wiring pinned), but this file is not in `git diff origin/main`.
     2. The spec §Tests states for E2E: `tests/e2e/local-verify-lifecycle.test.ts — the production wiring: a run stopped by shutdown restores first after boot and a second stop raises the local-verify:starved: signal through hooks.signal.` However, the test added in `tests/e2e/local-verify-lifecycle.test.ts:97` only directly invokes `seams.onStarved!({...})` on the seam instead of driving a run stopped by `shutdown()`, restoring across `boot()`, and triggering `onStarved` on a second stop.
   - **Smallest fix:** Add `tests/unit/lifeline/drift-restart-keeps-server.test.ts` covering `ServerSupervisor.detach()` and `TelegramLifeline` drift-promoter `keepServer: true` wiring, and expand the E2E test in `tests/e2e/local-verify-lifecycle.test.ts` to exercise two `shutdown()` interruptions + `boot()` + `tick()` driving `hooks.signal`.

6. **Unclean exit (`inFlight: true` at boot) stops at `errorAutoRetries` (1) before reaching `INTERRUPTION_LIMITS.starvedAfter` (2)**
   - **Location:** `src/localVerify/LocalVerifyService.ts:716-731`
   - **Problem:** In `doRestoreQueue()`, when `e.inFlight` is true, `entry.interruptions` is incremented, and then `decideVerifyRetry(entry, 'error')` is called. Because `LOCAL_VERIFY_LIMITS.errorAutoRetries` is 1, on the **second** unclean server crash during this PR's run, `d.action` is `'stop'`: the entry is dropped from the queue (`drops['server-restarted']++`) and completed with a synthetic `error` record, so it never enters `this.queue` and `checkStarved()` never raises the `interrupted` starved signal for it.
   - **Smallest fix:** Before `continue` on `d.action !== 're-run'` in `doRestoreQueue()` (line 725), check `decideStarved` (or call `onStarved` when `entry.interruptions >= INTERRUPTION_LIMITS.starvedAfter`) so a PR killed twice by unclean server crashes still raises the starved attention item.
