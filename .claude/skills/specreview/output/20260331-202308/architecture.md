# Architecture Review: PR #30 iMessage Adapter

### Approval Status: CONDITIONAL APPROVE

**Score: 8/10**

---

## Critical Issues

**1. Port mismatch: imessage-reply.sh defaults to 4040, server runs on 4042**

`src/templates/scripts/imessage-reply.sh` line 69: `PORT="${INSTAR_PORT:-4040}"` -- every send that doesn't explicitly set `INSTAR_PORT` silently fails the server notification. The message is sent (imsg handles that), but stall clearing and outbound logging don't happen. Fix: change default to 4042, or read it from `.instar/config.json` the same way the auth token is read.

**2. Hash collision risk in injectIMessageMessage / clearIMessageInjectionTracker**

The synthetic `topicId` is a 32-bit djb2 hash of the sender string. The clear logic iterates `pendingInjections` and deletes any entry whose `topicId` matches -- meaning two senders who hash to the same value would share stall state. With 32-bit hash space and multiple users this is plausible. The fix is simple: the sender string IS the natural key; add a parallel `pendingIMessageInjections: Map<string, ...>` keyed directly on sender instead of forcing a numeric hash.

**3. 50-message startup lookback creates replay risk**

`NativeBackend.ts` lines 137-139: on every restart, the last 50 messages are re-processed and re-injected into sessions. Users whose messages were already answered will receive duplicate responses after any server restart or deploy. Fix: persist `lastRowId` to `.instar/imessage-poll-offset.json` between restarts. Fall back to `maxId - 50` only on first run.

---

## Recommendations

**R1. Session name collision space is narrow** -- `im-${sender.slice(-6)}` means two senders ending in the same 6 digits get the same session name. Add entropy.

**R2. `setOnStall` is never wired in wireIMessageRouting** -- stall detection runs but never escalates. Telegram wires this. Either wire it here or explicitly document it as Phase 2.

**R3. `cliPath` config field is declared but never read** -- `IMessageConfig` has `cliPath` but `NativeBackend` and the adapter never read it. The shell script uses `IMSG_PATH` env var. Wire the config field or remove it.

---

## What's Done Well

- **WAL mode handling is correct and well-documented.** Opening without `readonly: true` but with `query_only = ON` is the right and only way to see WAL-resident data.
- **Fail-closed authorization is solid.** Required at construction (throws if missing), empty set warns and rejects all.
- **Bootstrap message design is excellent.** Inline conversation history from chat.db means sessions resume with real context.
- **Pattern consistency is high.** The routing logic mirrors Telegram exactly.
- **Degradation reporting on init failure** -- graceful, doesn't crash the server.
- **`waitForClaudeReadyWithRetry` and auto-consent dialog detection** benefit the entire platform.
- **E2E test coverage** covers the full lifecycle.

---

## Technology Choices

| Choice | Verdict |
|--------|---------|
| SQLite (better-sqlite3) reads | Correct. Already a dep. Sync API appropriate. |
| `query_only` pragma vs `readonly: true` | Correct -- only way to see WAL data. |
| 2s polling vs FSEvents | Acceptable. FSEvents on another process's WAL is unreliable. |
| imsg CLI for sends | Correct given the LaunchAgent/Automation permission constraint. |
| In-memory dedup with bounded Set (1000 IDs) | Correct. LRU eviction from Set is fine. |

---

## Conditions for Approval

1. Fix port default in imessage-reply.sh (4040 -> 4042)
2. Fix session name collision (6-char suffix -> 8-char + entropy)
3. Wire `setOnStall` in wireIMessageRouting OR explicitly document as Phase 2
