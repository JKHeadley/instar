# Side-effects review — Codex-instar audit Item 4: restart-handshake

**Scope:** New two-phase handshake that defers the "Just updated, restarting" user notification until the NEW process has booted and verified `ProcessIntegrity.runningVersion === expectedVersion`. Eliminates the bug where AutoUpdater told operators an update was live before the restart had actually taken effect (codey observed runtime v1.2.48 while installed v1.2.50).

Phase 1 (old process, just applied update): `AutoUpdater` writes `state/restart-handshake.json` with `{expectedVersion, previousVersion, deferredNotification}` instead of calling `notify()` immediately.

Phase 2 (new process, server startup): `verifyRestartHandshake()` compares `processIntegrity.runningVersion` against `expectedVersion`. On match, emit the deferred notification and clear the marker. On mismatch, emit an honest "applied but not running new code yet" message and bump retry count; after the escalation threshold, the next boot's message phrasing escalates to operator-attention.

Discovered by codey during the 2026-05-22 Codex-instar shortcomings audit (blocker #4).

**Files touched:**
- `src/core/UpdateRestartHandshake.ts` — new module. `UpdateRestartHandshake` class (write/read/clear/bumpRetryCount) + `verifyRestartHandshake()` function returning a discriminated `HandshakeVerificationOutcome` union.
- `src/core/AutoUpdater.ts` — `AutoUpdaterConfig.restartHandshake?` added. The "Just updated, restarting" branch now defers via the handshake when configured, falling back to immediate-notify when not (back-compat for tests + agents without the handshake wired). New `UpdateRestartHandshake` import.
- `src/commands/server.ts` — new instantiation of `UpdateRestartHandshake`, verification step pre-AutoUpdater (sends deferred notification if verified, failure notification if mismatched), and the handshake is passed into `AutoUpdater`'s config.
- `tests/unit/UpdateRestartHandshake.test.ts` — new test file, 17 cases.

**Under-block:** None. When no handshake is wired (older code paths, tests), the AutoUpdater falls back to its prior immediate-notify behavior. When the handshake is wired but verification can't run (telegram absent, topic unset), the deferred notification logs to console instead of dropping silently.

**Over-block:** None for the operator. A genuine update that succeeded and the new process booted on the new code: notification fires as before, just AFTER restart instead of before. The only behavior change is that the message now matches reality. For a FAILED restart (new process still running old code), the operator gets an honest failure message instead of a lying success message — strictly an improvement.

**Level-of-abstraction fit:** The handshake is a small standalone primitive in `core/`, used by:
- `AutoUpdater` (writes the marker before restart) — one branch in `gatedRestart`, no other surface touched.
- `server.ts` startup (reads + verifies the marker) — one block before AutoUpdater construction, no other surface touched.

No new dependency, no new config knob, no migration. The marker file lives in `state/` next to the existing `restart-requested.json` for symmetry.

**Signal vs authority compliance:** `restart-handshake.json` is a SIGNAL (the OLD process's intent). `ProcessIntegrity.runningVersion` is the AUTHORITY (what code actually loaded). The verifier resolves signal-against-authority and produces an outcome. No new authority introduced.

**Interactions:**
- `RestartCascadeDampener` (existing) batches rapid-fire restart requests. Untouched — the dampener fires before the handshake write, so the handshake's expectedVersion is the highest version queued for restart at the moment the batch fires.
- `ForegroundRestartWatcher` (existing) picks up `restart-requested.json` and triggers the actual exit. Untouched — the watcher fires AFTER the handshake is written, so the new process starts with the marker present.
- `lastNotifiedRestartVersion` dedup logic (existing) still gates whether the handshake is written at all — preventing duplicate handshakes across rapid-fire restart cycles for the same version.
- `crossesBreaking` + lifeline restart signal (existing) untouched; orthogonal concern.
- ProcessIntegrity is already wired at server startup — the handshake just reuses its `runningVersion`.

**External surfaces:** None. No new HTTP route, no new CLI command, no new config field that operators need to set. The handshake file is internal state.

**Migration parity:** No agent-installed file change. Existing agents pick up the fix on next update + server restart — but there's a subtle bootstrap edge: when a deployed agent updates to a version that ships this feature for the FIRST time, the OLD process doesn't know about the handshake (it doesn't write the marker), so the post-restart NEW process finds no marker (`outcome.kind === 'no-handshake'`) and falls through silently. This is correct behavior — there's nothing to verify yet. From the SECOND update onward, the feature is fully active.

**Rollback cost:** Trivial. Delete `UpdateRestartHandshake.ts`, revert the two edits in AutoUpdater (remove the `restartHandshake` field + revert the `gatedRestart` branch to the immediate-notify path), revert the four added lines + import in server.ts, delete the test file. ~120 lines total.

**Tests:**
- `tests/unit/UpdateRestartHandshake.test.ts`: 17/17 pass. Covers write/read/clear/bumpRetryCount I/O, verifier's three outcomes (no-handshake, verified, failed), escalation threshold (default + custom), end-to-end happy path (write → verify match → clear), and end-to-end failure path (write → verify mismatch → escalate).
- `tsc --noEmit`: clean.
- Empirical confirmation: pending until the next codey update cycle ships through the handshake — the feature is wired but requires an update event to exercise the full loop. The unit-level evidence is strong; the structural integration is tsc-clean and exercises both code paths (handshake-wired AutoUpdater and handshake-unwired fallback).

**Decision-point inventory:**
1. **Defer the notification vs always-send + add a follow-up "verified" notification.** Deferring is the cleaner contract — only one message goes out, and it goes out at the truthful moment. Always-sending + follow-up would mean two messages per update (the second contradicting the first on failure), which is noisier and more confusing.
2. **Verifier emits a discriminated union vs throws on mismatch.** Union lets the server's startup code branch on outcome.kind and route appropriately (success notification, failure notification, escalation). Throwing would force the caller into a try/catch and lose the structured payload.
3. **Escalation threshold default = 2.** First boot after a failed restart logs the issue without spamming the operator (a single missed restart is recoverable — supervisor retries are normal). Second boot still showing the mismatch indicates a deeper problem and earns the escalation phrasing.
4. **Pass handshake via AutoUpdater's config rather than as a separate setter.** Symmetric with how `sessionMonitor` and `sessionManager` are passed; keeps the wiring discoverable from one place.
