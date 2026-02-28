# Upgrade Guide — vNEXT

## What Changed

### Working Memory Assembly — Right Context at the Right Moment

Your agent now assembles working memory at session start and after compaction. Instead of loading everything or nothing, the system queries your knowledge stores for what's most relevant to the current task and injects it automatically.

**What this means for you:**
- Session starts with contextually relevant knowledge surfaced from SemanticMemory
- Recent episode digests (what you worked on in the last 48 hours) appear automatically
- Person/relationship entities relevant to the current task are included
- Compaction recovery now also restores relevant working memory — not just identity

**How it works:**
1. The session-start hook calls `GET /context/working-memory?prompt=<session-goal>`
2. WorkingMemoryAssembler queries SemanticMemory, EpisodicMemory, and TopicMemory
3. Results are token-budgeted (800 tokens knowledge + 400 episodes + 300 relationships + 300 topic)
4. Top 3 entities get full detail, next 7 get compact, rest are name-only
5. Formatted context is injected before any work begins

**New API endpoint:** `GET /context/working-memory?prompt=<query>&topicId=<id>&sessionId=<id>&limit=<n>`

No configuration required — it works automatically if SemanticMemory or EpisodicMemory is enabled.

---

### Inter-Agent Messaging — Structured Communication Between Sessions

Previously, Instar sessions running on the same machine had no way to communicate with each other. If session A discovered something session B needed to know, or if a job wanted to notify a running session about an important event, the only option was writing to a shared file and hoping the other session noticed. There was no delivery tracking, no acknowledgment, no threading, and no way to know if the message was ever received.

Now Instar includes a full **Inter-Agent Messaging** subsystem — structured message passing between sessions with delivery tracking, safe tmux injection, and a complete API.

### How It Works

Messages flow through four layers:

1. **MessageRouter** — The primary entry point. Handles sending, receiving, acknowledging, and relaying messages. Enforces echo prevention (can't message yourself), loop detection on relay chains, and deduplication.

2. **MessageStore** — File-based persistence. Each message is stored as a single JSON file in `.instar/messages/store/`. Supports inbox/outbox queries, filtering by type/priority, dead-letter queue for expired messages, and cleanup of old data.

3. **MessageDelivery** — Safe tmux injection. Before injecting a message into a session's terminal, it checks:
   - Is the foreground process on the whitelist? (bash, zsh, fish, sh, dash, claude)
   - Is a human actively typing? (won't interrupt human input)
   - Is there enough terminal context budget? (won't flood a small terminal)

4. **MessageFormatter** — Formats messages for terminal display (inline mode for short messages, pointer mode for long ones) with delimiter sanitization to prevent injection attacks.

### Message Types

Nine message types, each with default TTL and retention:

| Type | Purpose | Default TTL |
|------|---------|-------------|
| `info` | Informational — no response expected | 60 min |
| `sync` | State synchronization | 30 min |
| `alert` | Urgent notification | 120 min |
| `request` | Action request — please do something | 120 min |
| `query` | Question — please respond with information | 60 min |
| `response` | Answer to a query | 60 min |
| `handoff` | Session/machine handoff context | 240 min |
| `wellness` | Health check ping | 15 min |
| `system` | Infrastructure message from the Instar server | 30 min |

### 4-Phase Delivery Tracking

Every message transitions through delivery phases with full audit trail:

```
created → sent → received → delivered → read
                         ↘ queued ↗
```

Each transition is recorded with timestamp and reason. Transitions are **monotonic** — a message can never go backward (with one exception: `delivered → queued` for post-injection crash recovery by the watchdog).

Messages that aren't delivered in time follow the expiration path: `expired → dead-lettered`.

### Threading

Query and request messages automatically create threads. Responses link back via `inReplyTo`. Threads track participants and have depth limits (50) and staleness timeouts (30 min).

### Relay Support

Messages can be relayed between agents on the same machine (`/messages/relay-agent`) or across machines (`/messages/relay-machine`). The relay chain tracks which machines have seen the message to prevent loops. Duplicate messages are detected and acknowledged without re-storing.

## API Endpoints (For Your Use)

These endpoints are available on the Instar server:

| Endpoint | Method | What It Does |
|----------|--------|-------------|
| `/messages/send` | POST | Send a message to another agent/session |
| `/messages/ack` | POST | Acknowledge receipt of a message |
| `/messages/relay-agent` | POST | Receive a relayed message from another agent on the same machine |
| `/messages/relay-machine` | POST | Receive a relayed message from a different machine |
| `/messages/stats` | GET | Messaging statistics (volume, delivery rates, threads) |

All endpoints require your standard Bearer token authentication. When messaging isn't wired in, all endpoints return 503.

### Sending a Message

```
POST /messages/send
{
  "from": { "agent": "my-agent", "session": "session-1", "machine": "my-machine" },
  "to": { "agent": "other-agent", "session": "their-session", "machine": "local" },
  "type": "query",
  "priority": "medium",
  "subject": "What's your current task?",
  "body": "I'm about to work on the auth module — want to check we're not overlapping."
}
```

Response: `201 Created` with `{ messageId, threadId, phase: "sent" }`.

### Acknowledging a Message

```
POST /messages/ack
{
  "messageId": "uuid-of-the-message",
  "sessionId": "my-session-id"
}
```

Response: `200 OK` with `{ ok: true }`.

## Wiring Into Your Server

If you're using `AgentServer` programmatically, pass the messaging dependencies:

```typescript
import { MessageStore, MessageFormatter, MessageDelivery, MessageRouter, AgentServer } from 'instar';

const messageStore = new MessageStore(path.join(stateDir, 'messages'));
await messageStore.initialize();

const formatter = new MessageFormatter();
const delivery = new MessageDelivery(formatter, tmuxOps);
const messageRouter = new MessageRouter(messageStore, delivery, {
  localAgent: 'my-agent',
  localMachine: 'my-machine',
  serverUrl: 'http://localhost:3000',
});

const server = new AgentServer({
  config,
  sessionManager,
  state,
  messageRouter, // ← enables all /messages/* endpoints
});
```

Without `messageRouter`, all messaging endpoints gracefully return 503 — the server still works, messaging just isn't available.

## Type Export Note

The new messaging types `MessageType` and `AgentMessage` are exported as `InterAgentMessageType` and `InterAgentMessage` from the top-level `instar` package to avoid naming conflicts with the existing `AgentBus` exports. If you prefer the unaliased names, import directly:

```typescript
import type { MessageType, AgentMessage } from 'instar/messaging/types';
```

## What to Tell Your User

- **Sessions can talk to each other**: "My sessions can now send structured messages to each other — queries, status updates, handoff context. If I'm running multiple tasks, they coordinate instead of working blind."
- **Delivery tracking**: "Every message has delivery tracking. I know whether a message was sent, received, delivered to the terminal, and read. Nothing gets silently lost."
- **Safe injection**: "Messages are injected into terminals safely — they won't interrupt you if you're typing, and they only inject when the session is in a safe state."
- **Foundation for coordination**: "This is the communication layer that enables future multi-agent coordination — task delegation, conflict avoidance, and handoff between sessions."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Send messages between sessions | `POST /messages/send` with from, to, type, priority, subject, body |
| Acknowledge message receipt | `POST /messages/ack` with messageId and sessionId |
| Relay messages between agents | `POST /messages/relay-agent` with full message envelope |
| Cross-machine relay | `POST /messages/relay-machine` with full message envelope |
| View messaging stats | `GET /messages/stats` — volume, delivery rates, thread counts |
| 9 message types | info, sync, alert, request, query, response, handoff, wellness, system |
| Automatic threading | Query and request messages auto-create threads |
| Delivery tracking | 4-phase: sent → received → delivered → read |
| Dead-letter queue | Expired/failed messages preserved for debugging |
| Safe tmux injection | Process whitelist, human-input detection, context budget |
| File-based persistence | Per-message JSON in `.instar/messages/store/` |
