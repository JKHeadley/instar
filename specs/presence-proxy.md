# Presence Proxy — Intelligent Response Standby

## Problem

When a session is deep in work (coding, debugging, long tool calls), it can't respond to Telegram messages. From the user's perspective, silence is indistinguishable from the session being dead or stuck. The current stall detection fires at 5 minutes and jumps straight to triage — there's no friendly, informational middle ground.

## Solution

A **Presence Proxy** that monitors the gap between user messages and agent responses, providing intelligent, tiered status updates on the agent's behalf. Each tier captures session state and uses LLM intelligence to generate contextual updates — never mechanical "still working..." messages.

## Tiered Response Design

### Tier 1 — Status Update (20 seconds)

**Trigger**: User message received → 20s passes → no agent reply in that topic.

**What it does**:
1. Captures current tmux output from the session (last ~50 lines)
2. Checks session liveness (is the process alive? is there recent output?)
3. If session is alive and producing output → Haiku call to summarize what the agent is doing
4. Sends a friendly status message to the user

**LLM prompt context**:
- Current tmux output (last 50 lines)
- The user's pending message (so it can reference what the agent is working toward)
- Session uptime / recent activity indicators

**Output format**:
```
🔭 [Presence] Currently reading through the sentinel codebase and analyzing the StallDetector implementation to understand the recovery pipeline.
```

**Guard rails**:
- If session is dead/missing → skip Tier 1, go straight to Tier 3 logic
- If agent has sent ANY message to this topic in the last 20s → cancel (race condition guard)
- If session has no meaningful output (blank screen) → generic "Session is active but hasn't produced visible output yet"

### Tier 2 — Progress Report (2 minutes)

**Trigger**: Tier 1 already fired → 2 minutes since user message → still no agent reply.

**What it does**:
1. Captures current tmux output (last ~100 lines)
2. Compares against the Tier 1 snapshot (what changed?)
3. Haiku call to generate a progress comparison

**LLM prompt context**:
- Tier 1 snapshot (what the agent was doing at 20s)
- Current snapshot (what the agent is doing now)
- The user's pending message
- Time elapsed

**Output format**:
```
🔭 [Presence] 2-minute update: Started by exploring the sentinel files, now actively writing code in StallDetector.ts — looks like it's making progress on the implementation. Still working on your request.
```

**Guard rails**:
- If agent replied between Tier 1 and Tier 2 → cancel
- If session output is identical to Tier 1 snapshot → flag as potentially stuck (but don't alarm yet — could be a long LLM call where the agent is waiting for a response)
- Compare output hashes to detect zero-progress scenarios

### Tier 3 — Stall Assessment (5 minutes)

**Trigger**: Tier 2 already fired → 5 minutes since user message → still no agent reply.

**What it does**:
1. Captures current tmux output (last ~200 lines)
2. **Sonnet-class LLM** performs a deep assessment:
   - Is the session genuinely stuck or running a legitimately long process?
   - What's the session's state? (waiting for input? error loop? mid-tool-call? long build?)
   - Has there been ANY progress since Tier 2?
3. Based on assessment, sends one of two message types:

**If legitimately working**:
```
🔭 [Presence] 5-minute check: The agent is running a large test suite — this is expected to take a while. It's making progress (47 tests passed so far). I'll keep watching.
```

**If likely stalled**:
```
🔭 [Presence] 5-minute check: The agent appears to be stuck — it's been waiting on a tool call that hasn't returned for 4 minutes with no new output.

Reply "unstick" to attempt recovery, or "restart" to start a fresh session.
```

**LLM prompt for assessment** (Sonnet):
- Full tmux output (200 lines)
- Tier 1 and Tier 2 snapshots (for delta comparison)
- Session process tree (is bash running? what child processes?)
- The user's pending message
- Time elapsed
- Explicit instruction: "You must determine if this session is genuinely stuck or legitimately working. Consider: long builds, test suites, large file operations, and LLM API calls as legitimate. Consider: no output for 3+ minutes with a simple command, error loops, and waiting-for-input prompts as stuck."

**Response classification** (from LLM):
- `working` — Agent is making progress, just slow
- `waiting` — Agent is waiting for something legitimate (API call, build)
- `stalled` — Agent appears stuck, intervention likely needed
- `dead` — Session is not running

**Guard rails**:
- Only offer "unstick" if assessment is `stalled` or `dead`
- "unstick" triggers existing `StallTriageNurse.triage()` with `trigger: 'manual'` (bypasses cooldown)
- "restart" triggers session respawn with recovery context
- If assessment is `working` or `waiting` → schedule a Tier 3 re-check at 10 minutes

## User Commands (via Telegram)

When the Presence Proxy offers recovery options, the user can reply:

| Command | Action |
|---------|--------|
| `unstick` | Sends Ctrl+C to session, waits 10s, verifies recovery. Escalates if needed. |
| `restart` | Respawns session with recovery context including the pending user message. |
| `quiet` | Silences the Presence Proxy for this topic for 30 minutes. |

These should be handled by the existing Telegram command router (or a new handler if needed).

## Architecture

### Where it lives

**New file**: `src/monitoring/PresenceProxy.ts`

**Integration points**:
- **StallDetector** — Hooks into `message:logged` EventBus event to start timers. The existing `onStall` (5-min) callback remains unchanged.
- **SessionManager** — Uses `captureOutput()` for tmux snapshots
- **TelegramAdapter** — Sends proxy messages, listens for user commands
- **StallTriageNurse** — Called when user chooses "unstick" at Tier 3
- **LLM providers** — Haiku for Tiers 1-2, Sonnet for Tier 3

### Critical Security and Reliability Fixes (Required Before Implementation)

#### 1. Tmux Output Sanitization (BLOCKER — Prompt Injection)

**The risk**: Raw tmux output (up to 200 lines) containing credentials, tokens, and file contents is passed directly to LLM prompts. This creates:
- **Prompt injection surface** — Malicious processes can embed instruction patterns that the LLM relays verbatim as trusted `🔭 [Presence]` messages
- **Data exfiltration vector** — Sensitive terminal output transmitted to external APIs if `allowExternalLLM` is true

**Required fix**:
1. **Before every LLM call**: Wrap tmux output in `<tmux_output>` XML delimiters
2. **Strip before wrapping**: Remove ANSI codes, control characters, and instruction-pattern lines
3. **Second-pass guard**: Classify the proxy's LLM response before relaying; reject any message containing:
   - URLs (http://, https://, ftp://, etc.)
   - Imperative commands (sudo, rm, git push, etc.)
   - Requests for user input or credentials
4. **Default `allowExternalLLM: false`** — Never transmit terminal output to external APIs without explicit user opt-in
5. **Pre-transmission credential scrubbing** — If `allowExternalLLM` is enabled, scan output for common credential patterns (API keys, tokens, passwords) and redact before transmission

#### 2. Telegram Sender Authentication (BLOCKER — Unauthorized Command Execution)

**The risk**: Anyone who can message the Telegram bot can execute `restart` (destroys a running session) or `unstick` (sends Ctrl+C to the agent). No sender validation.

**Required fix**:
1. Validate `from.id` against a config-defined authorized user ID whitelist **before executing any action command**
2. Silently ignore commands from unauthorized users (no error message that reveals the feature exists)
3. Rate-limit per-user per-topic:
   - `unstick`: max 3 invocations/topic/hour
   - `restart`: max 1 invocation/topic/hour (require user confirmation prompt first)
   - `quiet`: unlimited, user-controlled

#### 3. StallDetector Integration Bug (BLOCKER — Silent Stall Detection Bypass)

**The risk**: `POST /telegram/reply/:topicId` calls `ctx.sessionManager.clearInjectionTracker(topicId)` unconditionally. Proxy messages will reset StallDetector's cooldown, silently disabling stall intervention that should still fire after 5 minutes.

**Required fix**:
1. Add optional `metadata.isProxy` field to `/telegram/reply` endpoint
2. When `isProxy: true`, skip the `clearInjectionTracker()` call
3. Document this behavior so other message types don't inadvertently bypass stall detection

Alternatively, create a dedicated internal send path: `PresenceProxy.sendProxyMessage(topicId, text)` that bypasses the injection tracker.

#### 4. Double-Triage Collision (BLOCKER — Session Destruction at 5min)

**The risk**: Tier 3 fires at 5 minutes. StallTriageNurse also fires at 5 minutes. Both concurrently → two Ctrl+C sequences hit the same session → recovery failure.

**Required fix**:
1. Implement a per-session **triage mutex** (Redis or in-memory with persistence)
2. When Proxy Tier 3 assessment fires: **acquire the mutex**
3. If locked by StallTriageNurse: skip Proxy Tier 3
4. If StallTriageNurse checks the mutex and finds Proxy active: defer itself (don't fire)
5. When user responds to Proxy (timeout or command), release the mutex
6. If user doesn't respond within 60 seconds, release the mutex for StallTriageNurse to proceed as backup

#### 5. Tier Timestamp State Corruption (BLOCKER — Tier Re-fire on Mid-Sequence Messages)

**The risk**: When a new user message arrives mid-sequence, `userMessageAt` resets but `tier1FiredAt`/`tier2FiredAt`/`tier3FiredAt` are not cleared. Tier 2's logic ("Tier 1 already fired → 2 minutes since user message") fires immediately.

**Required fix**:
1. Add a helper method: `resetTierTimestamps()` that clears **all** of `tier1FiredAt`, `tier2FiredAt`, `tier3FiredAt` simultaneously
2. Call this method whenever `userMessageAt` is updated (new message arrives)
3. Unit test: new message at 1:30min → timers reset → Tier 2 should not fire until 3:30min from new message

#### 6. Default External LLM to False (BLOCKER — Credential Exfiltration)

**The risk**: When `ANTHROPIC_API_KEY` is configured, terminal output (with potential credentials) is transmitted to Anthropic's servers with no data sensitivity controls.

**Required fix**:
1. Add `allowExternalLLM: false` to default `PresenceProxyConfig`
2. When `allowExternalLLM: true`, add pre-transmission credential scrubbing (redact common patterns: `ANTHROPIC_API_KEY=...`, `Bearer <token>`, `ghp_...`, etc.)
3. Log credential redactions to `presence-proxy-audit.jsonl` for compliance/auditing (log what was redacted, not the values)
4. Document this data flow explicitly in configuration docs

### State per topic

```typescript
interface PresenceState {
  topicId: number;
  sessionName: string;
  userMessageAt: number;          // When first user message arrived (starts timers)
  userMessageText: string;        // The initial pending message
  tier1FiredAt: number | null;    // When Tier 1 sent
  tier1Snapshot: string | null;   // tmux output at Tier 1 (sanitized)
  tier1SnapshotHash: string | null; // SHA-256 hash of sanitized snapshot
  tier2FiredAt: number | null;    // When Tier 2 sent
  tier2Snapshot: string | null;   // tmux output at Tier 2 (sanitized)
  tier2SnapshotHash: string | null;
  tier3FiredAt: number | null;    // When Tier 3 sent
  tier3Assessment: string | null; // LLM assessment result ('working'|'waiting'|'stalled'|'dead')
  tier3Summary: string | null;    // Diagnostic context from Sonnet assessment
  silencedUntil: number | null;   // If user said "quiet"
  cancelled: boolean;             // If agent responded
  llmCallCount: number;           // For rate limiting (~20/hour soft cap)
  lastLlmCallAt: number;          // Timestamp of last LLM invocation

  // Conversation mode (max 20 exchanges to prevent memory leaks)
  conversationHistory: Array<{
    role: 'user' | 'proxy';
    text: string;
    timestamp: number;
  }>;

  // Restart recovery
  persistedAt: number;            // Last time state was persisted to disk
  version: number;                // State schema version for migration
}
```

**Disk Persistence (HIGH PRIORITY)**:
- State is persisted to `.instar/state/presence-state/{topicId}.json` on every tier transition
- On server restart, check for persisted state files for all active topics
- Use `PresenceProxy.recoverFromRestart()` to determine which tiers have already fired
- Skip re-firing completed tiers; continue from where the sequence left off

**Persistence Algorithm**:
1. After Tier 1 fires: write state with `tier1FiredAt`, `tier1Snapshot`, `tier1SnapshotHash`
2. After Tier 2 fires: append `tier2FiredAt`, `tier2Snapshot`, `tier2SnapshotHash`
3. After Tier 3 fires: append `tier3FiredAt`, `tier3Assessment`, `tier3Summary`
4. On restart: load persisted state; check `elapsed = now() - userMessageAt`:
   - If `elapsed < 20s`: cancel proxy (agent might still respond before Tier 1 should fire)
   - If `20s < elapsed < 120s`: fire only Tier 2 (skip Tier 1, which already fired)
   - If `120s < elapsed < 300s`: fire only Tier 3
   - If `elapsed > 300s`: cleanup — state is stale (>5min old)
5. All restart recoveries should happen within 1-2 seconds of server start

### Cancellation

When the agent sends a reply to the topic (detected via `message:logged` event with `fromUser: false`):
1. Cancel all pending timers for that topic
2. Clear the PresenceState
3. No further proxy messages

### Relationship to existing stall detection

The Presence Proxy is **additive**, not a replacement:
- Proxy messages do NOT count as agent responses for StallDetector
- The existing 5-minute stall → triage pipeline remains unchanged
- At Tier 3, if the proxy determines the agent is stalled, it offers manual intervention INSTEAD of waiting for auto-triage (which would happen anyway, but now the user has agency)
- If the user triggers "unstick" via Tier 3, set a flag so StallTriageNurse knows manual triage was already initiated (avoid double-triage)

## Configuration

```typescript
interface PresenceProxyConfig {
  enabled: boolean;                    // Default: true
  tier1DelayMs: number;                // Default: 20000 (20s)
  tier2DelayMs: number;                // Default: 120000 (2min)
  tier3DelayMs: number;                // Default: 300000 (5min)
  tier3RecheckDelayMs: number;         // Default: 600000 (10min)
  silenceDurationMs: number;           // Default: 1800000 (30min)
  prefix: string;                      // Default: "🔭 [Presence]"
  tier1Model: string;                  // Default: "fast" (Haiku)
  tier2Model: string;                  // Default: "fast" (Haiku)
  tier3Model: string;                  // Default: "balanced" (Sonnet)
  maxTmuxLines: { t1: 50, t2: 100, t3: 200 };

  // Security: Sanitization & External LLM (CRITICAL)
  allowExternalLLM: boolean;           // Default: FALSE — never transmit terminal output to external APIs without opt-in
  sanitizeTmuxOutput: boolean;         // Default: true — strip ANSI codes, control chars, instruction patterns
  credentialPatterns: string[];        // Regex patterns to redact (default: ["ANTHROPIC_API_KEY=", "Bearer\\s+\\w+", "ghp_"])

  // LLM Reliability (HIGH PRIORITY)
  llmTimeoutMs: { t1: 10000, t2: 15000, t3: 30000 }; // Hard timeouts per tier
  llmRateLimit: {
    perTopicPerHour: number;          // Default: ~20 LLM calls/topic/hour
    tier3MaxRechecks: number;          // Default: 5 re-checks max
    autoSilenceMinutes: number;        // Default: 30 — auto-silence after 30min engagement
  };
  concurrentLlmCalls: number;          // Default: 3-5 concurrent `claude -p` calls with queue

  // Telegram Command Validation (CRITICAL)
  authorizedUserIds: number[];         // Default: [] — whitelist of Telegram user IDs allowed to use unstick/restart/quiet
  requireRestartConfirmation: boolean; // Default: true — require user confirmation before restarting session

  // UX Improvements (MEDIUM)
  sendQuietAcknowledgment: boolean;    // Default: true — confirm when user says "quiet"
  resumeCommand: boolean;              // Default: true — allow user to say "resume" to cancel silence
  exposeRemainingQuietTime: boolean;   // Default: true — tell user how many minutes left on silence

  // Conversation & State (HIGH PRIORITY)
  conversationHistoryMax: number;      // Default: 20 exchanges to prevent memory leaks
  persistStateToDisc: boolean;         // Default: true — persist PresenceState on every tier transition
  stateDir: string;                    // Default: ".instar/state/presence-state/"

  // Dev/Testing Flags (LOW PRIORITY)
  __dev_accelerateTimers: number;      // Default: 1.0 — multiply all delays (0.1 = 100x faster for testing)
}
```

**Configuration location**: `.instar/config.json` under `monitoring.presenceProxy`

**Authorization example** (required for `unstick`/`restart`/`quiet` commands):
```json
{
  "monitoring": {
    "presenceProxy": {
      "enabled": true,
      "authorizedUserIds": [7812716706],
      "allowExternalLLM": false,
      "tier3Model": "balanced"
    }
  }
}
```

## Critical Design Principle: Never Interrupt Real Work

The #1 risk of this system is **misdiagnosing a working session as stuck and triggering recovery that kills a legitimate long-running process**. This would be worse than no proxy at all — the user loses work AND trust.

### Anti-false-positive safeguards

1. **Tiers 1-2 are OBSERVATION ONLY** — they never suggest intervention, never offer "unstick", never imply the agent is stuck. They only describe what's happening. The language must be neutral/positive: "working on...", "making progress on...", "currently running..."

2. **Tier 3 defaults to "working"** — The Sonnet assessment prompt must be biased toward `working`/`waiting` classifications. The bar for `stalled` should be HIGH:
   - No tmux output change across ALL THREE snapshots (20s, 2min, 5min) AND no child processes running → likely stalled
   - Active child processes (builds, tests, installs, LLM API calls) → always `working`, regardless of silence
   - Error output visible but session still alive → `working` (agent may be debugging)
   - Only classify as `stalled` when there is STRONG evidence of no progress AND no active processes

3. **Process tree is authoritative** — If `ps` shows active child processes under the session's tmux pane, the session is working. Period. LLM assessment cannot override this.

4. **"unstick" is reversible-first** — The unstick action starts with a nudge (empty Enter), not Ctrl+C. Only escalate if the nudge doesn't produce output within 10s.

5. **Long-running process whitelist** — Maintain a list of known long-running patterns (npm install, cargo build, pytest, webpack, docker, git clone, large file operations). If the current command matches, auto-classify as `waiting` regardless of silence duration.

## Proxy Conversation Mode

The proxy is not just a status reporter — it's a **conversational stand-in**. When the user sends follow-up messages while the agent is busy, the proxy should be able to carry on an intelligent conversation.

### How it works

1. When a user message arrives and a PresenceState already exists (proxy is active), the proxy enters **conversation mode**
2. The proxy LLM receives:
   - Full conversation history (proxy messages + user messages for this topic)
   - Current session tmux output
   - The agent's identity context (name, what it's working on)
3. The proxy generates a response — still following the 20s delay rule (never instant)
4. The proxy's persona is distinct: it speaks ABOUT the agent in third person, not AS the agent

### Conversation rules

- **20s delay still applies** — even for follow-up messages. The proxy waits to see if the agent responds first.
- **Proxy doesn't make promises** — it can describe what the agent is doing, answer questions about progress, but never commits to actions the agent hasn't taken
- **Proxy doesn't execute** — it can't run commands, modify files, or take actions. It's purely observational and conversational.
- **Context window** — proxy conversations are ephemeral. Each LLM call gets the full proxy conversation history for this session, but it's not persisted beyond the PresenceState lifecycle.

### Example flow

```
User: "Hey, can you refactor the auth module?"
[20s, no agent reply]
Proxy: "🔭 [Presence] Echo is currently deep in the StallDetector implementation — looks like it's writing tests. Your message about the auth module refactor has been delivered to the session."
User: "How long do you think that'll take?"
[20s, no agent reply]
Proxy: "🔭 [Presence] Hard to say exactly — Echo has been writing code steadily for the last few minutes and appears to be making good progress on the current task. Once it finishes, it should pick up your auth module request."
[Agent finally responds directly]
[Proxy goes silent, timers cancelled]
```

## Message Logging

**ALL proxy messages must flow through the standard Telegram logging pipeline.** This is non-negotiable.

### What gets logged

| Message type | `fromUser` | `sessionName` | Additional metadata |
|-------------|-----------|---------------|-------------------|
| Proxy → User | `false` | mapped session | `source: 'presence-proxy'`, `tier: 1\|2\|3` |
| User → Topic (during proxy mode) | `true` | mapped session | Normal logging (unchanged) |

### How

Proxy messages are sent via the same `POST /telegram/reply/{topicId}` endpoint that agents use. This ensures:
- Messages appear in `telegram-messages.jsonl`
- Messages are dual-written to SQLite (`topic-memory.db`)
- Messages trigger `message:logged` events on the EventBus
- Messages are visible in conversation history

The proxy adds a `source` field to distinguish its messages from agent messages in the log. This allows:
- StallDetector to ignore proxy messages when checking for agent responses
- Conversation history to show proxy messages distinctly
- Analytics to measure proxy vs agent response patterns

### Implementation

Extend the `/telegram/reply/{topicId}` endpoint to accept an optional `metadata` field:
```typescript
POST /telegram/reply/{topicId}
{
  "text": "🔭 [Presence] ...",
  "metadata": {
    "source": "presence-proxy",
    "tier": 1
  }
}
```

The metadata gets persisted in the JSONL log entry alongside existing fields.

## LLM Provider: No API Key Required

The Presence Proxy uses instar's existing `IntelligenceProvider` abstraction, which defaults to `ClaudeCliIntelligenceProvider` — calling `claude -p` (print mode) via the Claude Code CLI.

**This means:**
- Zero extra cost beyond the existing Claude subscription
- No `ANTHROPIC_API_KEY` needed
- Works anywhere Claude Code is installed
- Falls back gracefully if CLI is unavailable (proxy simply doesn't fire — no crash)

### Model tiers used

| Tier | Model | Provider call |
|------|-------|--------------|
| Tier 1 (20s) | `fast` (Haiku) | `intelligence.evaluate(prompt, { model: 'fast', maxTokens: 300 })` |
| Tier 2 (2min) | `fast` (Haiku) | `intelligence.evaluate(prompt, { model: 'fast', maxTokens: 500 })` |
| Tier 3 (5min) | `balanced` (Sonnet) | `intelligence.evaluate(prompt, { model: 'balanced', maxTokens: 1000 })` |
| Conversation | `fast` (Haiku) | `intelligence.evaluate(prompt, { model: 'fast', maxTokens: 500 })` |

If the user has an `ANTHROPIC_API_KEY` configured, the system automatically uses the faster Anthropic API provider instead. But it's never required.

## Edge Cases

1. **Rapid messages**: User sends 3 messages in 10 seconds. Only the LATEST message starts a timer — previous timers are reset. All messages are still delivered to the session.
2. **Agent partial response**: Agent sends "Got it, looking into this" at 15s, then goes silent. Timer resets from that reply. New 20s window starts.
3. **Multiple sessions per topic**: Use the session mapped in `topic-session-registry.json`. If no mapping, skip proxy for that topic.
4. **Server restart mid-timer**: Timers are in-memory only. On restart, scan for topics with unanswered messages and re-initialize timers with adjusted delays.
5. **Lifeline topic**: Skip Tier 1-2 for the lifeline topic (topic 2) — it's a system topic, not conversational.
6. **User sends "unstick" without Tier 3**: Should still work — route through triage as a manual trigger regardless of proxy state.
7. **Agent responds between tier fires**: Check `cancelled` flag before every LLM call and message send.
8. **User talks to proxy, then agent responds**: Agent response immediately cancels proxy mode. Any in-flight proxy LLM call is discarded. Agent picks up the full conversation (including proxy messages visible in history).
9. **Proxy conversation during Tier 3 assessment**: If user sends messages after Tier 3 fires and offers "unstick", the proxy should handle both conversational responses AND command parsing (e.g., detect "unstick" in a natural sentence like "yeah go ahead and unstick it").
10. **Multiple concurrent topics**: Each topic has independent PresenceState and timers. Proxy conversations don't cross topics.

## Implementation Order

**Phase 1: Security & Reliability Foundation** _(Must complete before any Tier fires)_

1. `PresenceProxy` class with timer management, state persistence (disk + memory), and per-topic state
2. Tmux output sanitizer: ANSI stripping, control character removal, instruction-pattern detection
3. LLM output guard: second-pass classification to reject URLs/commands/input-requests
4. Telegram sender authentication: user ID whitelist validation before action commands
5. StallDetector integration fix: add `isProxy` flag to skip `clearInjectionTracker()`
6. Triage mutex: per-session coordination between Proxy Tier 3 and StallTriageNurse
7. LLM concurrency cap: queue management for `claude -p` calls (3-5 concurrent max)
8. State persistence to disk: `.instar/state/presence-state/{topicId}.json` with recovery algorithm
9. Configuration in config.json with security defaults (`allowExternalLLM: false`)
10. Unit tests for all sanitization and security logic

**Phase 2: Core Tiers** _(Build incrementally, security in place)_

11. Tier 1 (Haiku status update) — most impactful, ship first after security
12. Hard LLM timeouts (10s/15s/30s) with templated fallback
13. Message logging with `source: 'presence-proxy'` and `tier: N` metadata
14. Tier 2 (Haiku progress comparison) — snapshot delta analysis
15. Tier timestamp state management (reset all on `userMessageAt` update)
16. Tier 3 (Sonnet assessment + process tree analysis) — CONDITIONAL: only if no stall detected
17. Stall classification logic: `working` vs `waiting` vs `stalled` vs `dead`

**Phase 3: User Interaction & Conversation**

18. User command handling (unstick, restart, quiet) with rate limiting
19. Command confirmation: "restart" requires user confirmation
20. Unstick action: start with gentle nudge (Enter), escalate to Ctrl+C on no response
21. Proxy conversation mode (handle follow-up user messages during Tier 1-2 waits)
22. Conversation history management (cap at 20 exchanges)
23. Quiet command UX: acknowledgment, resume command, remaining-time display
24. Long-running process whitelist (npm install, cargo build, pytest, etc.)

**Phase 4: Testing & Deployment**

25. Integration tests with simulated stall scenarios using `__dev_accelerateTimers`
26. End-to-end test: user messages, proxy response, agent response, timer cancellation
27. Restart recovery test: server crash during Tier 2, resume from disk
28. Double-triage collision test: simultaneous Proxy Tier 3 + StallTriageNurse
29. Rate limiting test: 20+ messages/topic/hour, verify LLM calls stay under cap
30. Credential scrubbing test: verify sensitive output is redacted before external transmission
31. Deployment: enable for Justin's session first, gather feedback, expand to other sessions

**Blocking Decision**: Before Phase 1 coding starts, decide on feature name/prefix:
- Current: `🔭 [Presence]`
- Alternatives: "Standby", "Deputy"
- Decision impacts the messaging format and brand positioning
