# spec review round 1 — Gemini 4 Argon (gemini CLI), 2026-10-25

### 1. Verdict
**Ready with changes.**

Leaving the server running across a lifeline drift self-restart is structurally sound and safe:
- **Process groups & launchd:** The server lives inside the detached `tmux` server daemon (separate session and process group from the lifeline). When the lifeline calls `process.exit(0)`, launchd reaps only the lifeline's process group (`AbandonProcessGroup` or standard job scoping does not reach the `tmux` server).
- **Locks & ports:** `quiesceEverything` releases the lifeline lockfile (`this.lockPath`), unregisters `<projectDir>-lifeline` (PID-guarded), and closes `telegramOriginBoot` before exiting. The server holds its own port and state locks independently.
- **Adoption & health-check gaps:** The new lifeline's `ServerSupervisor.start()` runs `isServerSessionAlive() && (await verifyServerResponding())`, sets `this.isRunning = true`, `this.lastHealthy = Date.now()`, and `this.spawnedAt = Date.now()` (giving a fresh startup grace period), and resumes health checks seamlessly.

---

### 2. Factual errors against the code
None. Every method signature, state field, and line of wiring in the spec matches the branch diff (`RestartOrchestrator.ts`, `ServerSupervisor.ts`, `TelegramLifeline.ts`, `LocalVerifyService.ts`, `localVerifyWiring.ts`, and `server.ts`).

---

### 3. Safety problems, 4. Gaps against the incident, 5. Over-engineering (Ranked Findings)

#### 1. [Gap / Bug] In-place head update or base refresh drops `interruptions` and `resumeFirst`
- **Where:** `src/localVerify/LocalVerifyService.ts` (`request()` around lines 870–925).
- **Problem:** When a queued PR entry is updated because its head moved (`keptPlace` at lines 879, 895) or when `entry` is reconstructed at lines 920–924, `keptPlace` only copies `{ index, firstQueuedAt, pausedMs, starvedRaised }`. If a PR was interrupted (or if a push happens while an interrupted PR is queued), `interruptions` is wiped back to `undefined`. Even worse, if the same head is re-requested while already queued (`pendingIdx >= 0` at line 882), it returns early (safe), *unless* the base branch was retargeted or head moved. And if `error` record retry or `failure` rerun happens, `interruptions` is lost.
- **Smallest fix:** Preserve `interruptions` on `keptPlace` when the head has not changed (or if you want starvation to track the PR slot across rebases, carry `interruptions` in `keptPlace`). Note: if `starvedSignalKey` is keyed by `(pr, headSha.slice(0, 12))`, resetting `interruptions` on a new `headSha` is intentional, but make sure `resumeFirst` is preserved in `keptPlace` if a user rebases an interrupted PR while it's waiting!

#### 2. [Gap] `checkStarved()` is not persisted immediately when `starvedRaised` flips to `true`
- **Where:** `src/localVerify/LocalVerifyService.ts:1051-1068` (`checkStarved`) and `934-941` (`tick`).
- **Problem:** In `tick()`, `this.checkStarved()` runs *before* `this.pump()`. `pump()` calls `this.persistQueue()` at the top, which normally saves `e.starvedRaised = true`. However, if `pump()` starts `e` on that very same `tick()`, `this.queue.splice(d.index, 1)` removes `e` from `this.queue` and moves it to `this.inFlight` (or `this.starting` during `refreshBaseThenPump`). While `persistQueue()` includes `this.inFlight`, if `e` enters `this.starting` (async `refreshBaseThenPump`), `this.starting` is **still in `this.queue`**, so it persists. *However*, once `e` is in-flight and finishes or is interrupted again, if `persistQueue()` was skipped or if `shutdown()` happens before `tick()` runs after `restoreQueue()`, `starvedRaised` is safe. Still, calling `this.persistQueue()` inside `checkStarved()` whenever any entry flips `starvedRaised = true` makes `checkStarved()` self-contained rather than relying on `pump()`'s side effect.
- **Smallest fix:** In `checkStarved()`, if any candidate raises starved, call `this.persistQueue()` at the end of the loop.

#### 3. [Gap] Unclean exit (`inFlight: true` at boot) past `errorAutoRetries` drops the entry without raising `starved`
- **Where:** `src/localVerify/LocalVerifyService.ts:716-729` (`doRestoreQueue`).
- **Problem:** When the server crashes uncleanly mid-run (`e.inFlight === true`), `doRestoreQueue` increments `entry.interruptions` and checks `decideVerifyRetry(entry, 'error')`. Because `LOCAL_VERIFY_LIMITS.errorAutoRetries` is 1, on the **second** unclean crash (`errorRetries` already 1), `d.action` is `'stop'`. The code writes a synthetic `server-restarted` error record and `continue`s — dropping the entry from the queue *before* `checkStarved()` ever sees `interruptions === 2`. Thus, two unclean server crashes silently kill the verify into an `error` state without firing the `local-verify:starved` attention item.
- **Smallest fix:** Before `continue` in the `if (d.action !== 're-run')` block (line 723), check `decideStarved(entry, this.now())` and fire `onStarved` / audit if it crosses the threshold.

#### 4. [Safety / Edge Case] `RestartOrchestrator` 1000ms quiesce timeout vs `keepServer: false` vs `keepServer: true`
- **Where:** `src/lifeline/RestartOrchestrator.ts:139-142` and `src/lifeline/TelegramLifeline.ts:550-574`.
- **Problem:** In `quiesceEverything()`, `await this.telegramOriginBoot?.close()` runs *before* `unregisterAgent`, `releaseLockFile`, and `this.supervisor.detach()`. `RestartOrchestrator` wraps `this.deps.quiesce(req)` in a `Promise.race` with a 1000ms timeout. If `telegramOriginBoot.close()` takes > 1000ms, the orchestrator moves on to `persistAll()` and `exitFn(0)` **before** `releaseLockFile(this.lockPath)` and `supervisor.detach()` execute! For a `keepServer: true` restart, leaving a health-check timer active for a few milliseconds before `process.exit(0)` is harmless, but failing to release `this.lockPath` or unregister the PID before `exit(0)` can race the newly spawned lifeline.
- **Smallest fix:** In `quiesceEverything()`, stop timers (`pollTimeout`, `replayInterval`, `watchdog`, `supervisor.detach()` when `keepServer: true`) and release the lock/registration synchronously (or before awaiting `telegramOriginBoot?.close()`).

#### 5. [Over-engineering] Separate `starvedSignalKey` helper in `localVerifyWiring.ts`
- **Where:** `src/localVerify/localVerifyWiring.ts:44-46`.
- **Problem:** Exporting a 3-line `starvedSignalKey` function for a single template literal `` `local-verify:starved:${pr}:${headSha.slice(0, 12)}` `` used in one place adds unnecessary surface area unless external callers need it.
- **Smallest fix:** Inline the template string in `buildLocalVerifyService` (or keep it unexported).
