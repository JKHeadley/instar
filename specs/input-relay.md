# Input Relay — Prompt Detection & Telegram Forwarding

## Problem

When a Claude Code session hits an interactive prompt (plan approval, permission request, clarifying question, selection menu), the session blocks indefinitely. The user has no way to know this is happening unless they check the dashboard or tmux directly. Sessions can sit blocked for hours waiting for input that never comes.

## Solution

Extend the Standby system with **Input Relay** — a "Tier 0" that fires immediately (no delay) when it detects the session is waiting for user input. It relays the prompt to Telegram with enough context for the user to make an informed decision, then sends their response back to the session.

## Existing Infrastructure

Instar already has a full prompt detection and classification system:

- **PromptGate** (`src/monitoring/PromptGate.ts`) — Detects prompts via `InputDetector`
- **InputClassifier** (`src/monitoring/InputClassifier.ts`) — Classifies prompts as auto-approve, relay, or block
- **AutoApprover** (`src/core/AutoApprover.ts`) — Injects responses for auto-approved prompts

The Input Relay builds on the **relay** classification — prompts that PromptGate determines need human judgment are forwarded to Telegram instead of being silently ignored.

## What Gets Relayed

Only prompts classified as `relay` by the existing PromptGate pipeline. These are prompts that genuinely require human judgment:

| Prompt Type | When Relayed |
|-------------|-------------|
| **Questions** | Always — inherently require human judgment |
| **Permissions (sensitive)** | File operations on blocked paths (.env, credentials, /etc/) |
| **Permissions (overwrite)** | Always — destructive |
| **Plans** | When `autoApprove.planApproval` is false (default) |
| **Selections** | Always — ambiguous, need human context |
| **Confirmations (destructive)** | rm, delete, force, reset patterns |

Prompts that are auto-approved by PromptGate never reach the relay — they're handled silently as they are today.

## Message Format

The relay message must provide enough context for an informed decision. Different prompt types need different context:

### Permission Prompts

```
🔔 Echo needs your approval:

The agent wants to create a new file:
📄 src/monitoring/InputRelay.ts

This is a new file in the project directory.

Reply:
1️⃣ Yes, create it
2️⃣ Yes, and allow future edits to this file
3️⃣ No
```

### Plan Approval

```
🔔 Echo has a plan and needs your approval:

Plan: Redesign the dashboard Systems tab
- Read the current routes.ts implementation
- Add CAPABILITY_METADATA map
- Restructure the API response
- Update CSS and JS rendering
- Remove old accordion layout

5 files will be modified. No destructive operations.

Reply:
1️⃣ Yes, proceed (bypass permissions)
2️⃣ Yes, but I'll approve each edit
3️⃣ No, let me give feedback first
```

### Clarifying Questions

```
🔔 Echo is asking you a question:

"What email address should I use for the sender filter?"

Context: Currently reading gmail-scan.py and setting up email filtering logic.

Reply with your answer directly.
```

### Selection Menus

```
🔔 Echo needs you to choose:

"Which environment should I deploy to?"

1️⃣ Development
2️⃣ Staging
3️⃣ Production

Reply with the number.
```

### Destructive Confirmations

```
🔔 Echo wants to perform a destructive operation:

⚠️ "Do you want to delete all test fixtures and regenerate from scratch?" (y/n)

This will delete existing files. The agent is working on test infrastructure cleanup.

Reply:
✅ Yes
❌ No
```

## Context Generation

The key insight: **raw prompt text alone isn't enough for informed decisions.** The relay must provide context about WHAT the agent is working on and WHY it's asking.

### Context Sources (in priority order)

1. **Prompt summary** — Extracted by PromptGate's `InputDetector` (file path, operation type, options)
2. **Recent tmux output** — Last 20 lines before the prompt (shows what led to the question)
3. **Session purpose** — From `topic-session-registry.json` (the topic name/purpose)
4. **LLM contextualization** — Haiku call to generate a 1-sentence context summary from the tmux output, explaining WHY the agent is asking

### LLM Context Prompt

```
You are summarizing context for a human who needs to approve an AI agent's action.

The agent "${agentName}" is waiting for input in a session called "${sessionName}".

Prompt type: ${promptType}
Prompt text: "${promptSummary}"

Recent terminal output before the prompt:
<tmux_output>
${last20Lines}
</tmux_output>

Write ONE sentence explaining what the agent was doing and why it needs this input.
Do NOT include URLs, commands, or technical jargon.
Do NOT recommend an answer — just explain the context neutrally.
```

## Response Handling

When the user replies to a relay message in Telegram:

### Numbered Options
- User sends "1", "2", or "3" → Map to the corresponding option key
- For permissions: "1" → send "1" keystroke to tmux
- For plans: "1" → send Enter (option 1 is pre-selected)
- For selections: "2" → send "2" keystroke

### Yes/No Confirmations
- User sends "yes", "y", "✅" → send "y" keystroke
- User sends "no", "n", "❌" → send "n" keystroke

### Free-text Answers (Questions)
- User's reply text is sent directly as input to the session
- Followed by Enter keystroke

### Natural Language Detection
- "go ahead" / "sure" / "do it" → interpret as "yes" / option 1
- "stop" / "don't" / "cancel" → interpret as "no" / reject
- Use Haiku-class LLM for ambiguous cases

## Architecture

### Integration with Standby

Input Relay is a **Tier 0** in the PresenceProxy system:

```
Tier 0 (immediate): Input detected → relay to Telegram → wait for response → inject
Tier 1 (20s):       No response → status update
Tier 2 (2min):      No response → progress comparison
Tier 3 (5min):      No response → stall assessment
```

Tier 0 fires IMMEDIATELY when PromptGate emits a `relay` event — no timer delay. This is critical because the session is actively blocked.

### Integration with PromptGate

PromptGate already emits events when prompts are detected. The current flow:
```
PromptGate detects prompt → InputClassifier classifies → AutoApprover handles auto-approve
                                                       → relay events are currently DROPPED
```

The Input Relay catches the `relay` events:
```
PromptGate detects prompt → InputClassifier classifies → AutoApprover handles auto-approve
                                                       → InputRelay handles relay → Telegram
```

### State

```typescript
interface PendingRelay {
  promptId: string;          // Fingerprint from PromptGate
  topicId: number;           // Telegram topic
  sessionName: string;
  promptType: 'permission' | 'plan' | 'confirmation' | 'selection' | 'question';
  promptText: string;        // Raw prompt text
  options: Array<{ key: string; label: string }>;
  context: string;           // LLM-generated context
  relayedAt: number;         // When relay message was sent
  telegramMessageId: number; // For tracking which relay the response is for
  responded: boolean;
}
```

### Timeout

If the user doesn't respond to a relay within 10 minutes:
- Send a reminder: "🔔 Echo is still waiting for your response to the above question."
- After 30 minutes with no response: "🔔 Echo has been waiting for 30 minutes. The session is blocked until you respond."
- No auto-action — the prompt requires human judgment by definition.

## Security

1. **Sender authentication** — Same as Standby: validate `from.id` against authorized user whitelist
2. **Response validation** — Verify the response maps to a valid option before injecting
3. **Audit logging** — Every relay and response logged to `prompt-gate-audit.jsonl` (existing)
4. **No auto-escalation** — Relay prompts are NEVER auto-approved by the Input Relay. If PromptGate said "relay", the human must decide.
5. **Replay prevention** — Each relay has a unique `promptId`. Responses to already-handled prompts are ignored.

## Edge Cases

1. **Prompt auto-resolved** — The session may unstick itself (timeout, crash). If the prompt disappears from tmux before the user responds, send: "🔔 Never mind — Echo's prompt was resolved automatically."
2. **Multiple pending relays** — Each gets its own message. User can respond to any in any order.
3. **User responds to old relay** — Check `responded` flag and `promptId`. Ignore if already handled.
4. **Rapid prompt flicker** — PromptGate's debounce (2 stable captures) prevents false positives.
5. **Prompt in file content** — PromptGate's tail-window gating (last 5 lines only) prevents this.
6. **Session dies while waiting** — Detect via `isSessionAlive()`, send "🔔 Echo's session ended while waiting for your response."

## Implementation Order

1. Add relay event handler to PresenceProxy (catch PromptGate `relay` events)
2. Build relay message formatter (different templates per prompt type)
3. Add LLM context generation (Haiku call for 1-sentence context)
4. Build response handler (parse user replies, map to keystrokes)
5. Wire response injection (`sendKey`/`sendInput` to tmux session)
6. Add timeout reminders (10min, 30min)
7. Add prompt-resolved detection (prompt disappears from tmux)
8. Tests
