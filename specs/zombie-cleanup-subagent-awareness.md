# Spec: Zombie Cleanup Subagent Awareness

**Status:** Implemented
**Filed:** 2026-03-20
**Triggered by:** Session 8a1956eb (topic 1427, "command-trap") killed at 07:35 while waiting for spec review subagents spawned at 07:20.

---

## Problem

The zombie session cleanup in `SessionManager.ts` kills sessions that appear idle at the Claude prompt for 15 minutes. But sessions waiting for subagent results (spawned via the Agent tool) *look* idle — Claude is sitting at the prompt while subagents do work in the background. The cleanup has no visibility into subagent activity and kills these sessions as zombies.

This is a false positive with real consequences: the parent session is destroyed, orphaning any in-flight subagents and losing their results.

### Root Cause

`SessionManager.monitorSessions()` (line 206-240) checks terminal output against `IDLE_PROMPT_PATTERNS`. If matched for 15 minutes, it kills the session. It never consults `SubagentTracker`, which already tracks active subagents per session and could answer "is this session actually waiting on work?"

The two systems are completely disconnected:
- `SubagentTracker` is instantiated in `server.ts` (line 2792) and wired into the HTTP routes
- `SessionManager` is instantiated separately and has no reference to it
- There's no shared bus or query interface between them

## Proposed Fix

### Option A: Inject SubagentTracker into SessionManager (Recommended)

Pass a `SubagentTracker` reference (or a simple query function) into `SessionManager` so the zombie detection can check for active subagents before killing.

**Changes:**

1. **`SessionManager.ts` — Add subagent awareness to config/constructor**

```typescript
// In SessionManager class
private subagentChecker?: (session: Session) => boolean;

setSubagentChecker(fn: (session: Session) => boolean): void {
  this.subagentChecker = fn;
}
```

2. **`SessionManager.ts` — Guard the zombie kill (line ~213)**

Before the kill block, add:

```typescript
if (isIdleAtPrompt) {
  // Check if this session has active subagents — if so, it's not actually idle,
  // it's waiting for subagent results. Skip the zombie kill.
  if (this.subagentChecker?.(session)) {
    // Reset idle timer so we don't immediately kill when subagents finish
    this.idlePromptSince.delete(session.id);
    continue;
  }
  // ... existing idle timeout logic ...
}
```

3. **`types.ts` — Add `claudeSessionId` to Session type**

```typescript
interface Session {
  // ... existing fields ...
  /** Claude Code's own session UUID (from hook events). Populated lazily. */
  claudeSessionId?: string;
}
```

4. **`server.ts` (hook event route) — Populate `claudeSessionId` on first hook event**

When a hook event arrives with `session_id`, find the matching instar session (by tmux session name or other correlation) and set `session.claudeSessionId` if not already set. The hook events already flow through the `/hooks/events` route — add a small block there:

```typescript
// In the hook event handler, after processing:
if (payload.session_id) {
  // Find matching instar session and store Claude's session ID
  const instarSession = sessionManager.findSessionByClaudeId(payload.session_id)
    || sessionManager.findRunningSessionByTmux(/* derive tmux name */);
  if (instarSession && !instarSession.claudeSessionId) {
    instarSession.claudeSessionId = payload.session_id;
    sessionManager.saveSession(instarSession);
  }
}
```

5. **`server.ts` — Wire SubagentTracker into SessionManager**

Use a late-binding setter since SessionManager is constructed before SubagentTracker:

```typescript
// After both are constructed:
sessionManager.setSubagentChecker((session: Session) => {
  if (!session.claudeSessionId) return false;
  return subagentTracker.getActiveSubagents(session.claudeSessionId).length > 0;
});
```

**Ordering concern:** SessionManager is created before SubagentTracker in server.ts. Use a late-binding setter (`sessionManager.setSubagentChecker(fn)`) called after both are constructed. SubagentTracker has no server dependencies, so it could also be created earlier.

### Option B: Event-based approach (Alternative)

Have SubagentTracker emit `allComplete` events that SessionManager listens for. More decoupled but adds complexity for a simple boolean check.

**Not recommended** — the query function approach is simpler and more debuggable.

## Edge Cases

1. **Subagent tracking data stale/missing**: If SubagentTracker has no `onStop` event (e.g., subagent crashed without reporting), the session could be kept alive indefinitely.
   - **Mitigation**: Add a max subagent wait time (e.g., 60 minutes). If subagents have been "active" longer than this, treat the session as killable anyway and log a warning.

2. **Session ID mismatch (CONFIRMED)**: SubagentTracker is keyed by Claude Code's `session_id` (from hook event payloads — this is the JSONL UUID), while SessionManager uses its own `randomUUID()` stored as `session.id`. These are **different values** with no existing mapping.
   - **Required**: The `hasActiveSubagents` callback must bridge this gap. Options:
     - **(a)** Store the Claude Code session ID on the instar Session record (e.g., `session.claudeSessionId`). Populate it from the first hook event received for that tmux session. The `HookEventReceiver` already gets `session_id` on every event.
     - **(b)** Use the tmux session name as the correlation key instead of session ID. Hook events could include the tmux session name, or we can derive it.
     - **(c)** Have SubagentTracker also index by instar session ID (requires passing it as env var `INSTAR_SESSION_ID` to spawned sessions — this env var already exists in hooks but isn't set by SessionManager.spawnSession).
   - **Recommendation**: Option (a) is cleanest. Add a `claudeSessionId` field to the Session type, populate it lazily from the first hook event, and use it for the subagent lookup.

3. **Protected sessions**: Already excluded from zombie cleanup, so no interaction with this change.

4. **Orphaned subagents after parent kill**: Even with this fix, if a session IS killed (e.g., max duration exceeded), its subagents become orphaned. Consider emitting a `subagentsOrphaned` event so OrphanProcessReaper can clean them up. (Out of scope for this fix, but worth noting.)

## Testing

1. Spawn a session that uses the Agent tool to launch subagents
2. Verify zombie cleanup skips the session while subagents are active
3. Verify zombie cleanup resumes after all subagents complete
4. Verify stale subagent protection (max wait time) works
5. Verify logging indicates why a session was spared

## Scope

- **In scope**: Prevent false-positive zombie kills for sessions with active subagents
- **Out of scope**: Orphan subagent cleanup, SubagentTracker reliability improvements, changes to the 15-minute idle timeout itself
