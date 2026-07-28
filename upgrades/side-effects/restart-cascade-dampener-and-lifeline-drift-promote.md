# Side-effects review — restart-cascade dampener + lifeline drift auto-promote

**Scope**: Two coordinated self-heal upgrades surfaced by Luna's 2026-05-22 incident on Telegram topic 11838. Justin pinged Echo with "the sagemind/luna agent seems to be unresponsive." Investigation found Luna had restarted twice in 30 minutes (v1.2.34 at 22:13 UTC then v1.2.36 at 23:11 UTC), with the second restart firing while Justin was mid-conversation. Lifeline was 30 patches behind the server, surfacing as a degradation but never acted on. Both gaps are addressed here.

**Files touched**:
- `src/core/RestartCascadeDampener.ts` — NEW. Pure-logic decision class. Given `requestedVersion`, `lastRequestedAt`, and a window, returns `proceed` or `batch` with `eligibleAt`.
- `src/core/AutoUpdater.ts` — wires the dampener into `gatedRestart`. Adds `restartCascadeDampenerWindowMs` config (default 900_000 = 15min). New private methods `handleDampenerBatch`, `pickHigherVersion`, `_getBatchedRestartState` (test helper). Adds `batchedRestartTimer/TargetVersion/EligibleAt/OriginalVersion` fields. Inserts the dampener gate AFTER the existing same-version 30min cooldown and BEFORE the restart-window gate.
- `src/lifeline/LifelineDriftPromoter.ts` — NEW. Sentinel that owns the detect → defer → verify → request → finalize lifecycle for lifeline self-promotion on patch drift.
- `src/lifeline/TelegramLifeline.ts` — constructs `LifelineDriftPromoter` in `installOrchestratorAndWatchdog()`. New helpers: `loadDriftPromoterConfig`, `isCleanRestartWindow`, `writeDriftRestartPendingMarker`, `consumeDriftRestartPendingMarker`, `observeForwardResponseDriftHeader`. The forward path's `if (response.ok)` branch now calls `observeForwardResponseDriftHeader(response)` so the drift signal is fed into the promoter. `start()` calls `consumeDriftRestartPendingMarker()` after orchestrator install so the post-restart user notice fires.
- `src/server/routes.ts` — `/internal/telegram-forward` handler sets `X-Instar-Lifeline-Patch-Drift: <N>` response header when the version handshake produces `accept-with-patch-info` (PATCH diff > 10). Existing degradation message updated to credit the promoter instead of "consider manual kick."
- `src/core/types.ts` — `UpdateConfig.restartCascadeDampenerWindowMs?: number` added with doc comment.
- `src/commands/server.ts` — AutoUpdater construction passes `config.updates?.restartCascadeDampenerWindowMs` through.
- `src/config/ConfigDefaults.ts` — adds `updates.restartCascadeDampenerWindowMs: 900_000` and `lifeline.driftPromoter: { enabled, threshold, pollIntervalMs, maxDeferMs }` to `SHARED_DEFAULTS`. This single change makes both `init` and `migrate` paths apply the defaults automatically (per the file's contract).
- `src/core/PostUpdateMigrator.ts` — `migrateClaudeMd` adds a "Self-Heal: Update Restart Behavior" section to existing agent CLAUDE.md files (content-sniffed for idempotency).
- `src/scaffold/templates.ts` — `generateClaudeMd` adds the same section for new agents.
- `tests/unit/RestartCascadeDampener.test.ts` — 9 unit tests covering the pure decision logic + boundaries.
- `tests/unit/AutoUpdater-cascade-dampener.test.ts` — 7 integration tests exercising the AutoUpdater wiring: batches a second within-window restart, fires the queued highest-semver target after the window elapses, proceeds when outside the window, never downgrades on lower-version requests during a batch, leaves the same-version 30min cooldown alone, bypassWindow=true skips the gate, windowMs=0 disables.
- `tests/unit/lifeline/LifelineDriftPromoter.test.ts` — 15 unit tests covering: config validation, disabled, threshold gating, immediate-fire on clean window, defer-then-fire when busy then clean, max observed diff retention, throw-tolerance in `isCleanWindow`, hard deadline, deadline=0 disables, fired idempotency, double-fire prevention under concurrent ticks, stop() clearing the timer.
- `tests/integration/telegram-forward-patch-drift-header.test.ts` — 4 tests against the real `createRoutes()` route confirming the header is set at the correct boundary (omitted on same-version, omitted at diff=10 boundary, set to N when diff > 10, omitted on 426).
- `tests/e2e/self-heal-cascade-and-drift.test.ts` — 5 lifecycle tests: PostUpdateMigrator injects defaults into an existing config; idempotent re-run preserves user customizations; AutoUpdater constructed without config has the 15min default active; LifelineDriftPromoter respects the enabled toggle; end-to-end forward against the real route sets the drift header.

**Under-block** (problems we do NOT catch):

- Two updates further apart than the 15-minute window will still each fire their own restart. Tuning the window is the lever — `updates.restartCascadeDampenerWindowMs: 30 * 60_000` is a reasonable setting for agents that update frequently. Default holds the line at 15min so we don't artificially delay important updates.
- Drift below 20 patches is not auto-promoted. The server still emits the patch-info degradation at >10 (the existing PATCH_INFO_THRESHOLD), but the promoter waits until >20 before acting. This is intentional: PATCH 10–20 is normal during a release rollout window and self-correcting via the next update cycle.
- The drift promoter waits for a clean window — no in-flight forwards, no queued messages, no traffic in the last 90s. An agent under sustained Telegram load will defer the auto-promote until traffic dies down. The 60-minute hard deadline (`maxDeferMs`) is the backstop; an agent that's never quiet for 60 minutes is also signaling that a forced restart could disrupt a real conversation.
- Crash / health-fail restarts are NOT dampened. The 15-minute gate is explicit to `gatedRestart` (update-driven). A crash-loop is a separate concern, handled by the existing `CrashLoopPauser` machinery.

**Over-block** (cases that fire when they shouldn't):

- If an update lands within 15min of the previous restart AND the user has no active sessions, we still defer the restart by up to 15min. The cost is "agent runs old code for up to 15 more minutes during an idle period." Acceptable — that's the whole point.
- `bypassWindow=true` (manual `/updates/apply`) skips the dampener. A user who explicitly requests a restart gets one immediately, even if it's seconds after the last one. This is correct: the user knows what they're asking for.
- The drift promoter's clean-window predicate treats "any queued message" as not-clean, even if the queue is just system-internal. This is conservative by design — we'd rather defer a self-restart than restart while a single message is waiting to flush.

**Level-of-abstraction fit**:

- The `RestartCascadeDampener` is a pure decision class. It owns the time-window math; it does not touch the filesystem, the supervisor, or Telegram. AutoUpdater is the authority that interprets a `batch` decision (sets timer, sends notify). The notify text and timer setup live in `AutoUpdater.handleDampenerBatch`, alongside the existing notify machinery — same level of abstraction as the pre-existing restart-cooldown notification.
- The `LifelineDriftPromoter` owns its lifecycle (idle → pending → fired) and the clean-window polling cadence. It does not know how the lifeline restarts (it calls `deps.requestSelfRestart`, which delegates to the existing `RestartOrchestrator`). It does not write the post-restart user notice (it calls `deps.recordPendingNotice`, which delegates to the lifeline's marker-file helper). Three seams = three test boundaries.

**Signal vs authority** (per `feedback_signal_vs_authority`):

- Server handshake = signal. It reports the observed drift via a response header. It does not decide whether to restart.
- `LifelineDriftPromoter` = gate with full context (knows the lifeline's queue state, clean-window predicate, hard deadline). It decides to act.
- `RestartOrchestrator` = authority for the actual exit. The promoter calls `orchestrator.requestRestart(...)`; the orchestrator owns quiesce + persist + `process.exit`.
- For the cascade dampener: AutoUpdater is the existing authority for update-driven restarts. The dampener is a pure helper consulted at the gate, not a separate authority.

**Interactions**:

- **Existing same-version 30min cooldown** (`AutoUpdater.gatedRestart` line ~554) is untouched and runs FIRST. Test `same-version retry within window is caught by the existing 30min same-version cooldown — dampener stays out of the way` proves the dampener does not re-handle same-version. The dampener only consults state when the requested version differs from the last requested.
- **Existing restart-window gate** (e.g. "restart only between 02:00 and 05:00") runs AFTER the dampener. A restart within the dampener window AND outside the restart window will be deferred TWICE — first by the dampener, then by the restart window. This is correct: both are valid concerns, and the user has opted into both.
- **Existing session-aware gating** (`UpdateGate.canRestart`) runs AFTER both window gates. Sessions that block a restart still block. The dampener does not bypass session protection.
- **`CrashLoopPauser`** is unaffected. It runs against job execution failures, not server restarts.
- **`RestartOrchestrator`** is reused unchanged for the lifeline drift path. Quiesce / persist / shadow-install coordination all still apply.
- **`LifelineHealthWatchdog`** continues to handle its own restart triggers (noForwardStuckMs, conflict409StuckMs, etc.) independent of drift. The two are orthogonal — drift is a long-term version concern; the watchdog handles short-term stuckness.
- **`ForegroundRestartWatcher`** in `server.ts` reads the `restart-requested.json` flag the same way; the dampener only changes WHEN that flag is written, not its format.

**Rollback cost**:

- Disable the cascade dampener: set `updates.restartCascadeDampenerWindowMs: 0` in `.instar/config.json` and restart the server. The decision class returns `proceed` for all input; behavior reverts to the pre-feature state.
- Disable the drift promoter: set `lifeline.driftPromoter.enabled: false` and restart the lifeline. The promoter is constructed in the `disabled` state and `noteDrift` becomes a noop. The server still emits the patch-info degradation; just no one acts on it (pre-feature behavior).
- Revert the code: the feature is contained to the two new classes + the AutoUpdater wiring + a few server-route lines + the config defaults. A `git revert` of this commit would be clean — no migrations to undo on the config (the keys remain harmless if the code no longer reads them).

**Test evidence** (per `feedback_bug_fix_evidence_bar`):

The first integration test in `AutoUpdater-cascade-dampener.test.ts` reproduces the exact symptom from Luna's incident — two restarts arrive 5 minutes apart, a session is active during the second, and the user would have been hit by a second pre-restart notification. The test asserts:
- The first restart's flag file is written.
- The second restart's flag file is NOT overwritten (the on-disk flag still points to v1.2.34).
- The batched-restart state holds v1.2.36 as the deferred target.
- The user receives a "rolling into the pending restart" batch notification, not a second "Just updated to vX, restarting" notification.

The second test (`after the batch window elapses, the queued highest-version target fires`) advances the fake clock past the 15-minute window and asserts the second restart DOES eventually land, with the higher v1.2.36 as the target. This confirms the dampener defers rather than drops.

For drift auto-promote, the E2E test asserts the actual wire — a real `createRoutes()` route handler returns `X-Instar-Lifeline-Patch-Drift: 25` for a lifeline 25 patches behind. This is the load-bearing connection: if the header is missing, the lifeline-side promoter never engages, regardless of what the unit tests prove.
