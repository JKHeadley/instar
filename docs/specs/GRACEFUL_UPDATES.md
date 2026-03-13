# Graceful Update System — Spec

> Eliminate disruptive restarts from the Instar update pipeline.

## Problem Statement

Every npm update triggers a full server restart that:
1. Kills all active sessions (Claude processes become inaccessible)
2. Triggers lifeline "server went down" alerts (looks like a crash)
3. Sends reconnection messages when server comes back
4. Creates user-facing noise for what should be a routine maintenance event

With increasing update frequency (bug fixes, features), this becomes untenable.

## Current Architecture

> Note: Since v0.17.3, updates use shadow installs instead of global npm install.

```
AutoUpdater.tick() (every 30min)
  → npm view instar@latest
  → shadow install to .instar/shadow-install/
  → writes state/restart-requested.json
  → ForegroundRestartWatcher detects (10s poll)
  → process.exit(0)
  → tmux respawns with new binary
  → lifeline detects "server down" → alerts fire
  → server comes back → lifeline "reconnected" message
```

**Key existing interfaces:**
- `sessionManager.listRunningSessions()` — all live sessions
- `sessionMonitor.getStatus().sessionHealth` — idle/active/unresponsive per session
- `telegram.getActiveTopicSessions()` — sessions with human conversations
- `state/restart-requested.json` — restart trigger flag
- `state/update-restart.json` — legacy flag that suppresses serverDown alerts (unused by current AutoUpdater)

## Design — Three Phases

---

### Phase 1: Silent Planned Restarts

**Goal:** Eliminate noise. Planned restarts should be invisible to the user unless they have active sessions.

#### 1A. Planned Restart Flag

When AutoUpdater writes `restart-requested.json`, it already includes `requestedBy: 'auto-updater'`. Add a new field:

```json
{
  "requestedAt": "...",
  "requestedBy": "auto-updater",
  "targetVersion": "0.9.76",
  "previousVersion": "0.9.75",
  "plannedRestart": true,
  "expiresAt": "..."
}
```

#### 1B. Lifeline Suppression

Modify `ServerSupervisor` to check for a planned restart before firing `serverDown`:

```typescript
// In checkHealth() failure path:
if (this.isPendingPlannedRestart()) {
  // Don't emit serverDown — this is expected downtime
  // Don't count as failure — don't trigger restart attempts
  // Just wait for the server to come back
  return;
}
```

The supervisor reads `restart-requested.json` to detect planned restarts. When a planned restart is in progress, it enters a "maintenance wait" state:
- Suppresses `serverDown` event (no Telegram alert)
- Suppresses restart attempt counter (no exponential backoff)
- Waits up to 5 minutes for server to return (configurable via `maintenanceWaitMinutes`; default 5 — npm installs can take 2-5 min on slow networks, and the existing `startupGraceMs = 90_000` already acknowledges slow boot)
- If server doesn't return within the maintenance wait window, THEN fire normal alerts

Also suppress the reconnection message after a planned restart. Replace with a quiet log entry.

#### 1C. ForegroundRestartWatcher Notification Cleanup

Currently sends: `"Update installed: vX → vY\nRestarting now..."`

Change to only notify if there are active sessions. If no sessions are running, restart silently. If sessions exist, send a brief notice to the Updates topic only (not the Lifeline topic).

#### Testing — Phase 1

**Unit tests:**
- `ServerSupervisor` correctly reads planned restart flag and suppresses alerts
- `ServerSupervisor` falls back to normal alerting after maintenance wait timeout (default 5 min)
- `ServerSupervisor` correctly clears maintenance wait state on server recovery
- `ForegroundRestartWatcher` sends notification only when sessions are active

**Integration tests:**
- Simulate update cycle: write restart-requested.json with `plannedRestart: true`, verify no serverDown event fires, verify server recovery is detected cleanly
- Simulate failed planned restart: write flag, server doesn't come back within 5 min, verify alerts DO fire

---

### Phase 2: Update Coalescing + Session-Aware Timing

**Goal:** Minimize restart frequency and avoid interrupting active work.

#### 2A. Update Coalescing

Add a configurable `applyDelayMinutes` (default: 5) to AutoUpdater. After detecting an update:

1. Record `pendingUpdate` with timestamp
2. Start a delay timer
3. If another update is detected during the delay, reset the timer and update `pendingUpdate` to the newer version
4. After the delay expires with no new updates, proceed to apply

This handles the common pattern of rapid-fire publishes (0.9.74, 0.9.75, 0.9.76 in 10 minutes → single restart to 0.9.76).

```typescript
// In AutoUpdater.tick():
if (info.updateAvailable) {
  this.pendingUpdate = info.latestVersion;
  this.pendingUpdateDetectedAt = Date.now();

  if (!this.applyTimer) {
    this.applyTimer = setTimeout(() => this.applyPendingUpdate(), this.config.applyDelayMinutes * 60_000);
  } else {
    // Reset timer — more updates might come
    clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => this.applyPendingUpdate(), this.config.applyDelayMinutes * 60_000);
  }
}
```

#### 2B. Session-Aware Restart Gating

Add an `UpdateGate` that checks session activity before allowing a restart:

```typescript
class UpdateGate {
  canRestart(sessionManager, sessionMonitor): { allowed: boolean; reason?: string; retryInMs?: number } {
    const sessions = sessionManager.listRunningSessions();

    // No sessions → restart immediately
    if (sessions.length === 0) return { allowed: true };

    // Check if any sessions are actively working
    // Only 'healthy' (actively producing output) sessions block restarts.
    // 'unresponsive' sessions are already broken — blocking an update for them
    // serves no user interest. 'idle' and 'dead' sessions are safe to restart around.
    const health = sessionMonitor.getStatus().sessionHealth;
    const activeSessions = health.filter(s => s.status === 'healthy');
    const unresponsiveSessions = health.filter(s => s.status === 'unresponsive');

    // Warn about unresponsive sessions but don't let them block
    if (unresponsiveSessions.length > 0) {
      // Notify via Telegram: "Session {id} unresponsive — proceeding with restart"
    }

    if (activeSessions.length === 0) return { allowed: true };

    // Active sessions exist — defer
    return {
      allowed: false,
      reason: `${activeSessions.length} active session(s)`,
      retryInMs: 5 * 60_000, // check again in 5 minutes
    };
  }
}
```

**Maximum deferral:** 4 hours. Advance warnings at T-30min and T-5min before the forced restart fires, giving active sessions a chance to reach a checkpoint. After 4 hours of deferral, restart with a final notification. Updates shouldn't queue up indefinitely.

**Note on `urgentUpdate`:** A future enhancement may add a mechanism for critical security updates to skip session-aware waiting. The design for how urgency is signaled (local config, authenticated advisory channel, etc.) is deferred to a separate spec when the need arises. For now, all updates follow the same session-aware path with the 4-hour maximum deferral cap.

#### 2C. Notify-Only Update Mode

When `autoApply: false`, the system should not silently do nothing. Define the explicit opt-out path:

1. AutoUpdater detects new version
2. Sends Telegram notification: "Update available: vX.Y.Z. Run `instar update apply` to install, or say 'apply the update'."
3. User can trigger manually via:
   - CLI: `instar update apply`
   - Telegram: "apply the update" / "update" in the Lifeline topic
   - API: `POST /updates/apply`
4. Once triggered, the update follows the same coalescing + session-aware path as auto-apply

This ensures users who disable auto-apply still get notified and have a clear action path.

#### 2D. Update Status Endpoint

Add `GET /updates/status` (authenticated) returning:

```json
{
  "currentVersion": "0.9.75",
  "pendingUpdate": "0.9.76",
  "pendingUpdateDetectedAt": "...",
  "coalescingUntil": "...",
  "deferralReason": "2 active session(s)",
  "deferralStartedAt": "...",
  "deferralElapsedMinutes": 45,
  "maxDeferralHours": 4,
  "autoApply": true,
  "lastCheck": "...",
  "lastApply": "...",
  "lastError": null
}
```

This gives users and monitoring tools full visibility into update state.

#### 2E. Pre-Restart Session Notification

When the gate allows restart and sessions ARE running (but idle):

1. Send a notification to each session's Telegram topic: "Server updating to vX.Y.Z — restarting in 60 seconds"
2. Wait 60 seconds
3. Proceed with restart

This gives any sessions that happen to be mid-work a chance to checkpoint.

#### Testing — Phase 2

**Unit tests:**
- Update coalescing: rapid version bumps produce single apply
- Coalescing timer resets correctly on each new version
- UpdateGate allows restart when no sessions
- UpdateGate allows restart when all sessions idle
- UpdateGate defers when active sessions exist
- Maximum deferral timeout forces restart after 4 hours
- Pre-restart notification fires for each active topic session

**Integration tests:**
- Full coalescing flow: publish 3 versions in 5 minutes, verify single restart to latest
- Session-aware deferral: start a session, trigger update, verify restart waits, end session, verify restart proceeds
- Maximum deferral: start long-running session, trigger update, verify restart happens after 4hr cap
- Pre-restart notification: session is running, restart triggered, verify notification sent before shutdown

**End-to-end tests:**
- Full update cycle with active session: update detected → coalescing delay → session check → deferral → session ends → restart → server comes back → no spurious alerts
- Full update cycle with no sessions: update detected → coalescing delay → immediate restart → silent recovery

---

### Phase 3: Zero-Downtime Restart

**Goal:** Near-invisible restarts even when sessions are active.

#### 3A. Dual-Process Swap

Instead of exit-and-respawn, start the new version alongside the old:

1. AutoUpdater installs the update
2. Write `restart-requested.json` with `strategy: 'zero-downtime'`
3. ForegroundRestartWatcher (or a new `GracefulRestarter`):
   a. Spawn new process on a temporary port (current port + 1)
   b. Wait for new process health check to pass
   c. Signal old process to stop accepting new connections
   d. Wait for in-flight requests to drain (5s timeout)
   e. Swap ports (new process takes over the main port)
   f. Old process exits

**Session continuity:** Sessions are tmux processes managed by the old server. The new server needs to "adopt" them:
- Sessions are tracked in state files (JSON), not in server memory
- The new server reads the same state directory and picks up existing sessions
- tmux sessions themselves survive the server restart — they're independent processes
- The new server's SessionManager loads state and verifies each tmux session is alive

This is the key insight: **tmux sessions already survive server restarts.** The disruption isn't that sessions die — it's that the server process managing them dies, health checks fail, and alerts fire. If we swap servers without a gap, tmux sessions continue uninterrupted.

#### 3B. Port Handoff

Two approaches, from simplest to most robust:

**Option A — Sequential swap (simpler):**
1. New server starts on port+1
2. Old server stops listening on main port
3. New server immediately binds to main port
4. Gap: ~100ms (time between old unbind and new bind)

**Option B — SO_REUSEPORT (Linux only — NOT viable on macOS):**
1. Both processes listen on the same port simultaneously
2. New process starts accepting connections
3. Old process stops accepting
4. Old process exits after draining

*Note: Node.js SO_REUSEPORT support is Linux-only. Since Instar primarily targets macOS, this option is documented for completeness but is not the recommended path.*

**Option C — Unix socket proxy (fallback if Option A gap is problematic):**
1. Internal communication over unix socket
2. A tiny proxy (or the lifeline) forwards TCP to whichever process is active
3. Swap is instant — just change which socket the proxy points to

Recommend starting with Option A. The gap under normal HTTP is brief, but note: under HTTP keep-alive connections, `server.close()` does not release the port until existing connections close. The old process shutdown MUST call `server.closeAllConnections()` (Node.js 18.2+) before the new process attempts to bind. The actual gap should be measured empirically before declaring Phase 3 stable. If the gap proves problematic, Option C is the recommended macOS fallback.

#### Testing — Phase 3

**Unit tests:**
- New process startup on alternate port
- Health check verification of new process
- State file adoption by new process
- Session continuity verification (tmux sessions survive)

**Integration tests:**
- Full dual-process swap: old server running → new server spawns → health verified → port swap → old server exits
- Session adoption: create sessions on old server → swap → verify new server sees and manages all sessions
- Failed swap: new server fails health check → old server remains active, no disruption
- Concurrent requests during swap: fire requests during the swap window, verify none are dropped

**End-to-end tests:**
- Complete zero-downtime update: sessions active → update detected → new server spawns → swap → sessions continue → no alerts → no notifications → health endpoint reports new version

---

## Implementation Order

| Phase | What | Effort | Impact |
|-------|------|--------|--------|
| 1A | Planned restart flag | Small | Enables 1B |
| 1B | Lifeline suppression | Small | Eliminates false alerts |
| 1C | Notification cleanup | Small | Reduces noise |
| 2A | Update coalescing | Medium | Fewer restarts |
| 2B | Session-aware gating | Medium | No active-session disruption |
| 2C | Notify-only update mode | Small | Explicit opt-out path |
| 2D | Update status endpoint | Small | Observability |
| 2E | Pre-restart notification | Small | User awareness |
| 3A | Dual-process swap | Large | Near-zero downtime |
| 3B | Port handoff | Medium | Seamless swap |

**Recommended build sequence:** 1A → 1B → 1C → 2A → 2B → 2C → 2D → 2E → 3A → 3B

Each phase is independently valuable and testable. Phase 1 can ship in a single version. Phase 2 can ship incrementally (2A first, then 2B+2C). Phase 3 is a standalone project.

## Configuration

All new behavior is configurable via `config.json` or constructor options:

```json
{
  "updates": {
    "autoApply": true,
    "checkIntervalMinutes": 30,
    "applyDelayMinutes": 5,
    "sessionAwareRestart": true,
    "maxDeferralHours": 4,
    "preRestartNoticeSeconds": 60,
    "silentPlannedRestarts": true,
    "maintenanceWaitMinutes": 5,
    "zeroDtRestart": false
  }
}
```

All features default to backwards-compatible behavior. `silentPlannedRestarts` and `sessionAwareRestart` default to `true` since they're strictly better. `zeroDtRestart` defaults to `false` until Phase 3 is proven stable.

## Future Considerations (from spec review)

Items noted by the review team that are valid but out of scope for this spec:

- **npm supply chain integrity**: Hash verification against out-of-band manifest, `--ignore-scripts`, publisher key pinning. Important but orthogonal to graceful restarts — deserves its own spec.
- **`restart-requested.json` authentication**: PID + timestamp validation is sufficient for local-only infrastructure. HMAC/nonce considered over-engineering for current threat model.
- **`urgentUpdate` mechanism**: Full design deferred until the need arises. When implemented, should use an authenticated advisory channel (not package.json), with user opt-in config.
- **Multi-agent concurrent npm install race**: Machine-level install lock (`/tmp/instar-install.lock`) needed when multiple agents run on the same machine. Address in Phase 2.
- **Phase 3 as separate spec**: Consider splitting Phase 3 into its own spec revision after Phases 1-2 are production-proven.
