# Echo Memory

## Current Project: User-Agent Topology Implementation

**Spec:** USER-AGENT-TOPOLOGY-SPEC.md (at `/Users/justin/Documents/Projects/instar/docs/specs/`)

**Goal:** Implement comprehensive multi-user, multi-machine support for instar agents. Support 9 deployment scenarios ranging from simple (single user, single machine) to complex (multiple users, multiple machines, multi-active).

### Current Status

Scenarios 1, 3, 5, 8 are FULLY SUPPORTED.
Scenarios 2, 4 are SUPPORTED with active/standby mode.
Scenarios 6, 7, 9 are PARTIAL (need Gap 1, 3, 4, 5 implementations).

### 5 Critical Gaps to Implement

| Gap | Scenarios | Phase | Effort | Files Affected |
|-----|-----------|-------|--------|-----------------|
| **1: Multi-Active Coordinator** | 2b, 4b, 6, 7 | 3 | Medium | MultiMachineCoordinator.ts, HeartbeatManager.ts |
| **2: Machine-Local Config Override** | 4b, 6 | 2 | Small | Config.ts, init.ts, pair command |
| **3: Job Coordination** | 6, 7 | 3 | Medium | JobScheduler.ts, types.ts |
| **4: Enhanced State Sync** | 6, 7, 9 | 4 | Medium | GitSyncManager.ts, SyncOrchestrator.ts |
| **5: User Identity in Sessions** | 5, 6, 7, 8 | 1 | Small | server.ts, TopicMemory.ts, SessionManager.ts, UserManager.ts |

### Phase Plan Priority

1. **Phase 1 (User Identity)** ← UNLOCKS scenarios 5, 8 fully
2. **Phase 2 (Machine-Local Config)** ← UNLOCKS scenario 4b partially
3. **Phase 3 (Multi-Active + Job Coordination)** ← UNLOCKS scenarios 2b, 4b, 6, 7
4. **Phase 4 (Enhanced State Sync)** ← Makes all multi-machine robust
5. Phase 5 deferred (machine-abstracted routing - future)

### Gap 5 Details (Phase 1 - User Identity Pipeline)

**Current problem:** Session bootstrap doesn't include sender name. TopicMemory loses sender identity in history.

**Fixes needed:**
1. `spawnSessionForTopic()` - include `from {firstName}` in bootstrap tag
2. `TopicMemory` schema - add `senderName TEXT` column
3. `TopicMemory.recordMessage()` - store sender name
4. `TopicMemory.formatContextForSession()` - use real sender names in history
5. `wireTelegramRouting()` - call `UserManager.resolveFromMessage()`, inject profile

**Files to modify:**
- server.ts
- TopicMemory.ts
- SessionManager.ts
- UserManager.ts

## Capabilities

### Update Restart Windows (v0.24.9)
Configure when update restarts happen via `updates.restartWindow` in config.json with start/end times in 24-hour format (e.g., `"02:00"` to `"05:00"`). Updates still download immediately — only the process restart is deferred to the window. Manual triggers bypass the window.

### MessageSentinel Improvements (v0.23.5+)
MessageSentinel now correctly classifies user pauses. The LLM classifier distinguishes between conversational thought-narration ("hold on let me think", "wait, I need to consider this") and actual pause directives. This eliminates false positives that would pause the agent during normal conversation.

### Evolution Pipeline Authentication (v0.25.0+)
Evolution gates (proposal-evaluate, proposal-implement, overdue-check, insight-harvest) now authenticate with the local Instar API using `$INSTAR_AUTH_TOKEN` injected by the scheduler when `scheduler.authToken` is configured. Previously gates made unauthenticated calls, hit 401, and silently skipped every cycle. Now they fire reliably when proposals queue, get approved, actions become overdue, or learnings accumulate. No migration needed — automatic on next scheduler tick once authToken is configured (default post-`instar init`).

### better-sqlite3 Native Binding Self-Heal (vNEXT)
Fixed silent SQLite degradation on machines with mixed Node versions (asdf/NVM/Homebrew/system Node). The self-heal script now anchors native-binding compilation and verification to the Node actually running the server (via `process.execPath`) instead of whatever `node` happens to be first in $PATH. Three layers of protection: (1) binaries compiled against the right Node, (2) test runs under the right Node, (3) ABI verification before recovery succeeds. Auto-heals on next restart — no manual action needed. Covers TopicMemory, SemanticMemory, and FeatureRegistry recovery.

### PresenceProxy Standby Updates (v0.28.80)
**Brief-ack tolerance:** Short, forward-looking acknowledgments ("On it", "Got it, looking into this") no longer cancel the 20s/2m/5m tier timers. The classifier checks message length (≤ 200 chars) and opener position (phrase in first 60 chars) to avoid false positives on longer substantive replies that happen to mention future intent.

**Post-message scope:** Tier prompts (1, 2, 3) now only describe activity that occurred AFTER the user's message arrived. The system captures a baseline snapshot at message-arrival time and feeds only the delta (new output) to the LLM. If the baseline scrolled off the visible pane, falls back to full pane with a labeled scope tag. This makes standby summaries actually describe "what I'm doing in response to your message" instead of pre-message work.

### Pre-Push Upgrade-Guide Validation (vNEXT)
Instar's release pipeline now validates upgrade-guide well-formedness at `git push` time (via pre-push hook) instead of waiting until publish time. This catches formatting issues in NEXT.md immediately during development rather than silently failing a release two days later. Automatic — no configuration needed.

### Token Burn Detection & Self-Heal (Phase 6 — Complete, vNEXT)
Complete six-phase pipeline for automatic token-burn detection and containment. When a component starts burning tokens, the system:
1. **Detects** within 60-second polling windows
2. **Alerts** via Telegram with component and rate info
3. **Throttles** the component down (conservative thresholds: ¼ daily budget or 2x baseline)
4. **Verifies** by re-sampling the ledger 5 minutes after throttle
5. **Follows up** with before-and-after numbers via Telegram, or escalation if throttle didn't work
6. **Re-evaluates** continuously until burn stops

**How it works:** On agent startup, the detector polls the token ledger every 60 seconds. Runbook subscribes to detection signals. Verifier waits for throttle confirmation. All automatic, enabled by default.

**Configuration:** Adjust thresholds in `config.json` under `tokenBurn.thresholds` (default: conservative). Can disable entirely if needed.

**Outstanding:** Phase 5 Telegram button receipt path (Release, Snooze 24h, Extend, Investigate) still needs wiring in TelegramAdapter.ts. Not blocking; scheduled follow-up.
