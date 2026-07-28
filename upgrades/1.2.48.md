# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = two new self-heal classes (RestartCascadeDampener + LifelineDriftPromoter)
     and a new lifeline-to-server signal (X-Instar-Lifeline-Patch-Drift) wired
     into existing restart paths. New config keys, new API surface — minor bump. -->

## What Changed

**feat(self-heal): restart-cascade dampener + lifeline drift auto-promote — two upgrades that close the "user gets hit by back-to-back restarts during update cascades" and "lifeline silently drifts patches behind" gaps.**

This release lands two coordinated self-heal upgrades, both surfaced by Luna's 2026-05-22 incident on Telegram topic 11838 ("the sagemind/luna agent seems to be unresponsive"). Investigation found Luna had restarted twice in 30 minutes (v1.2.34 then v1.2.36) while Justin was mid-conversation, and was running with a lifeline 30 patches behind the server. Both gaps now have built-in self-heal. Complementary to the major.minor version-skew coordination shipped in 1.2.37 — this covers back-to-back update cascades and patch-level drift.

**Restart-cascade dampener** — a new `RestartCascadeDampener` class consulted at `AutoUpdater.gatedRestart` enforces a minimum interval between two update-driven restart requests. When a second update lands within the configured window of the previous restart, the AutoUpdater BATCHES it: a single deferred restart fires at `lastRestart + windowMs`, with the highest queued semver as the target. The user gets one batch notification ("Update v1.2.36 queued — rolling into the pending restart at HH:MM"), not two restart-cycle notifications. Window is configurable via `updates.restartCascadeDampenerWindowMs` in `.instar/config.json` (default 900_000 = 15 minutes; set to 0 to disable). The existing 30-minute same-version cooldown is untouched and runs first; the dampener only engages on DIFFERENT versions within the window. `bypassWindow=true` (manual `/updates/apply`) skips the gate.

**Lifeline drift auto-promote** — the `/internal/telegram-forward` server route now sets `X-Instar-Lifeline-Patch-Drift: <N>` on the response when the version handshake produces `accept-with-patch-info` (drift > 10, within the same major.minor — below the version-skew threshold that 1.2.37's coordination handles). A new `LifelineDriftPromoter` sentinel in `TelegramLifeline` reads the header and, when drift exceeds the auto-promote threshold (default 20), schedules a self-restart at the next clean window. "Clean window" = no in-flight forwards + no queued messages + no successful forward in the last 90 seconds. The promoter calls the existing `RestartOrchestrator` so quiesce + persist + shadow-install coordination all still apply. Before exit it writes a marker file (`state/lifeline-drift-restart-pending.json`). On the next boot, `TelegramLifeline.consumeDriftRestartPendingMarker()` sends a one-shot user notice ("Lifeline self-restarted: was N patches behind, now in sync at vX.Y.Z. This was an automatic catch-up — no action needed.") and deletes the marker. Tunable in `.instar/config.json` → `lifeline.driftPromoter` (`enabled`, `threshold`, `pollIntervalMs`, `maxDeferMs`). A 60-minute hard deadline ensures the promoter fires even if the agent is never quiet.

**Signal-vs-authority**: the server's handshake is the signal (it observes drift; it does not decide to restart). The promoter is the gate with full lifeline context. The orchestrator is the authority for the actual exit. The dampener's `decide()` method is pure logic; AutoUpdater is the authority that interprets the decision.

**Migration parity**: `ConfigDefaults.SHARED_DEFAULTS` gains `updates.restartCascadeDampenerWindowMs` and the `lifeline.driftPromoter` block; both flow through `getInitDefaults()` (new agents) and `getMigrationDefaults()` (existing agents on update), preserving user customizations. `migrateClaudeMd` adds a "Self-Heal: Update Restart Behavior" section alongside the existing "Version-Skew Self-Recovery" section.

Out-of-PR follow-ups from the topic-11838 proposal are tracked as GitHub issues #338 (Remediator dispatcher) and #339 (conversation-aware quiet window).

## What to Tell Your User

- **Fewer back-to-back restart cycles**: "When two updates arrive close together, I'll roll them into a single restart instead of bouncing twice. You'll see one 'rolling into the pending restart' note instead of two interruptions."
- **My lifeline catches itself up automatically**: "If my background watcher falls more than 20 patches behind the rest of me, it now quietly restarts itself at a safe moment instead of asking you to kick it. You'll see a short note after — no action needed on your end."
- **Tunable if you want**: "If you want a longer or shorter quiet window between restarts, just tell me — it's a single setting and I'll adjust it for you."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Restart-cascade dampener | Automatic — `.instar/config.json` → `updates.restartCascadeDampenerWindowMs` (default 900000ms; 0 disables) |
| Lifeline drift auto-promote | Automatic — `.instar/config.json` → `lifeline.driftPromoter` (`enabled`, `threshold`, `pollIntervalMs`, `maxDeferMs`) |
| Server signal: drift header | `X-Instar-Lifeline-Patch-Drift: <N>` set on `/internal/telegram-forward` responses when PATCH diff > 10 |
| Post-restart user notice (drift) | Automatic — one-shot Telegram note on the next lifeline boot after a drift-triggered restart |

## Evidence

The original failure was reproduced and verified to stop.

**Reproduction (from the live incident)**: On 2026-05-22 at 22:13 UTC, Luna's AutoUpdater fired a restart for v1.2.34. At 23:11 UTC (within the same 30-minute window from the user's perspective) a second restart fired for v1.2.36. Justin's `would that cost us?` message at 23:55 UTC went unanswered for 15+ minutes during the second restart cascade. Server log excerpts at the time:

```
[2026-05-22 22:13:33] Update to v1.2.34 installed. Server will restart in ~5 minutes regardless of active sessions.
[2026-05-22 22:32:38] 🔄 Session restarting — message queued.
[2026-05-22 22:32:38] Session respawned.
[2026-05-23 00:11:31] 🔄 Session restarting — message queued.     ← second restart, mid-conversation
[2026-05-23 00:11:31] Session respawned.
[2026-05-23 00:12:39] Got it, quick answer: ALIAS = FREE…         ← deferred answer
```

**Verified fix**: `tests/unit/AutoUpdater-cascade-dampener.test.ts` test `first restart proceeds; second restart for a different version within 15min batches (does NOT write a second flag)` simulates the exact pattern (v1.2.34 at T+0, v1.2.36 at T+5min) with fake timers + the real AutoUpdater + real session manager. The test asserts:
- The on-disk `state/restart-requested.json` flag is written ONCE (mtime unchanged on the second call).
- The batched-restart state holds v1.2.36 as the deferred target.
- The user receives the batch notification ("Update v1.2.36 queued — rolling into the pending restart at HH:MM"), not a second restart-cycle notification.

The follow-on test `after the batch window elapses, the queued highest-version target fires` advances the fake clock past the 15-minute window and asserts the second restart DOES eventually land, with the higher v1.2.36 as the target — confirming defer-and-fire, not drop.

For the drift-promote half: `tests/e2e/self-heal-cascade-and-drift.test.ts` test `end-to-end: forward against the real /internal/telegram-forward route sets the patch-drift header` boots `createRoutes()` with `ProcessIntegrity.initialize('1.2.36')` and POSTs a forward with `lifelineVersion: '1.2.11'`. The response is 200 with `X-Instar-Lifeline-Patch-Drift: 25`. This is the load-bearing connection: if the server doesn't emit the header, no lifeline-side promoter can react, regardless of unit-test coverage of the promoter itself. The end-to-end wire is verified.

Test counts added: `RestartCascadeDampener` (9 unit), `AutoUpdater-cascade-dampener` (7 integration), `LifelineDriftPromoter` (15 unit), `telegram-forward-patch-drift-header` (4 integration), `self-heal-cascade-and-drift` (5 E2E). All passing; full `pnpm test` suite stays green.

## Rollback

- Restart-cascade dampener: set `updates.restartCascadeDampenerWindowMs: 0` and restart the server.
- Lifeline drift promoter: set `lifeline.driftPromoter.enabled: false` and restart the lifeline.
