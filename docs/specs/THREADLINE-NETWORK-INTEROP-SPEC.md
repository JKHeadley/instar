# Threadline Network Interoperability Specification

> **Version**: 1.1.0-draft
> **Status**: Proposal (Post-Review Revision)
> **Author**: Dawn (with Justin Headley)
> **Date**: 2026-03-09
> **Builds on**: [THREADLINE-SPEC.md](./THREADLINE-SPEC.md) (v1.1.0), [INTER-AGENT-MESSAGING-SPEC.md](./INTER-AGENT-MESSAGING-SPEC.md) (v3.1)
> **Normative language**: RFC 2119 keywords (MUST, SHOULD, MAY)

## 1. Executive Summary

Threadline v1.0 provides persistent, session-coherent, human-supervised conversations between agents on the same machine or paired machines. This specification extends Threadline to the open internet — enabling Instar agents to communicate with **any** A2A-compatible agent, expose capabilities via MCP tools, and participate in the broader agent ecosystem.

### 1.1. The Problem

Threadline currently binds to `127.0.0.1`. Agents outside the local machine cannot discover or communicate with Instar agents. As the agent ecosystem converges on two standard protocols — **A2A** (agent-to-agent) and **MCP** (agent-to-tool) — Instar agents are invisible to the rest of the world.

### 1.2. The Opportunity

Nobody has solved **persistent agent-to-agent conversations** in the standard protocols. A2A is task-oriented and stateless — send a task, get a result, conversation over. Threadline's session coherence, autonomy gating, and adaptive trust are genuinely novel. By speaking A2A externally while adding persistence internally, Instar agents offer something no other framework provides.

### 1.3. Design Principles

| Principle | Meaning |
|-----------|---------|
| **The agent is the interface** | Users never see protocols, endpoints, or handshakes. They talk to their agent. The agent handles discovery, trust, and communication autonomously. |
| **Speak the standard, extend with value** | A2A for discovery and transport, Threadline for persistence and trust |
| **Local-first remains the default** | Network exposure is opt-in. No agent goes public without explicit configuration |
| **Threadline semantics are the differentiator** | Session coherence, autonomy gating, and adaptive trust travel with the agent |
| **Progressive disclosure of capability** | An A2A client sees a standard agent. A Threadline-aware client sees persistent conversations |
| **Security scales with exposure** | Localhost needs less hardening than the open internet |

### 1.4. User Experience Model

The human user of an Instar agent should **never need to understand Threadline, A2A, MCP, or any protocol detail**. The Instar agent itself is the discovery mechanism and the interface layer.

**From the user's perspective:**
- "Can you talk to Dawn's agent about that code review?" → The agent discovers, handshakes, and communicates
- "What did you and the research agent discuss yesterday?" → The agent retrieves thread history
- "I don't trust that new agent yet" → The agent adjusts autonomy gating

**From the agent's perspective:**
- The agent uses Threadline/A2A/MCP to discover and communicate with other agents
- The agent explains its capabilities and relationships to its user in natural language
- The agent manages trust levels and reports on its agent network as appropriate

All technical configuration (tunnel setup, trust bootstrap, compute budgets) is either automatic with sensible defaults or managed by the agent on the user's behalf. The "developer" audience for this spec is the **Instar agent framework and its maintainers** — not end users.

---

## 2. Architecture Overview

```
                    Internet                          Local Machine
              ┌─────────────────┐              ┌──────────────────────────┐
              │  External Agent  │              │    Instar Agent          │
              │  (A2A / MCP)    │              │                          │
              └────────┬────────┘              │  ┌────────────────────┐  │
                       │                       │  │  Threadline Core   │  │
                       ▼                       │  │  (existing v1.0)   │  │
              ┌─────────────────┐              │  └─────────┬──────────┘  │
              │  Tunnel/Proxy   │              │            │             │
              │  (Cloudflare/   │──────────────│  ┌─────────▼──────────┐  │
              │   ngrok/custom) │              │  │  A2A Gateway       │  │
              └─────────────────┘              │  │  (new)             │  │
                                               │  ├──────────────────┤  │
                                               │  │  MCP Tool Server  │  │
                                               │  │  (new)            │  │
                                               │  └──────────────────┘  │
                                               └──────────────────────────┘

Data Flow (inbound A2A message):
  External Agent → Tunnel → A2A Gateway → Threadline Core → Agent Session

Data Flow (inbound MCP tool call):
  MCP Client → MCP Tool Server → Threadline Core → Response

Data Flow (outbound to A2A agent):
  Agent Session → Threadline Core → A2A Client → External Agent
```

---

## 3. Components

### 3.1. A2A Gateway

The A2A Gateway is a translation layer between the A2A protocol and Threadline's internal message format. It runs as part of the Instar agent server.

#### 3.1.1. Agent Card

Every Instar agent with network interop enabled MUST publish an Agent Card:

```
GET /.well-known/agent-card.json
```

```json
{
  "name": "dawn-agent",
  "description": "Dawn's personal Instar agent — persistent conversations with session coherence",
  "url": "https://agent.dawn-tunnel.dev",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": true
  },
  "skills": [
    {
      "id": "conversation",
      "name": "Persistent Conversation",
      "description": "Engage in a persistent, context-aware conversation that resumes across sessions",
      "inputModes": ["text/plain", "application/json"],
      "outputModes": ["text/plain", "application/json"]
    },
    {
      "id": "threadline-query",
      "name": "Thread History Query",
      "description": "Query conversation history from a previous thread",
      "inputModes": ["application/json"],
      "outputModes": ["application/json"]
    }
  ],
  "securitySchemes": {
    "threadline": {
      "type": "custom",
      "description": "Threadline Ed25519 handshake — establishes persistent trust with HKDF-derived relay tokens"
    },
    "bearer": {
      "type": "http",
      "scheme": "bearer",
      "description": "Standard bearer token for A2A-only clients"
    }
  },
  "security": [{ "bearer": [] }],
  "provider": {
    "organization": "SageMind AI",
    "url": "https://sagemindai.io"
  },
  "extensions": {
    "threadline": {
      "version": "1.0.0",
      "capabilities": ["session-coherence", "autonomy-gating", "adaptive-trust"],
      "handshakeEndpoint": "/threadline/handshake/hello",
      "identityPub": "<base64-encoded Ed25519 public key>"
    }
  }
}
```

**Key design choices**:
- The `extensions.threadline` field advertises Threadline-specific capabilities. Standard A2A clients ignore it and use bearer auth. Threadline-aware clients see it and can upgrade to the full handshake for persistent sessions.
- The Agent Card MUST be **self-signed** with the agent's Ed25519 identity key. The signature covers the canonical JSON serialization (sorted keys, no whitespace) and is served in the `X-Threadline-Card-Signature` response header. This prevents spoofing by directory proxies or CDN caches.
- Skill `description` fields MUST be sanitized (stripped of markdown, HTML, and control characters) before serving, to prevent prompt injection via Agent Card metadata.

#### 3.1.2. A2A Endpoints

The gateway MUST implement these A2A-standard endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/.well-known/agent-card.json` | GET | Agent Card (unauthenticated) |
| `/a2a/messages` | POST | Send message (JSON-RPC `message/send`) |
| `/a2a/messages:stream` | POST | Send message with SSE streaming |
| `/a2a/tasks/{id}` | GET | Get task status |
| `/a2a/tasks/{id}:cancel` | POST | Cancel task |

#### 3.1.3. Message Translation

**Inbound (A2A → Threadline)**:

```
A2A SendMessage {
  message: { role: "user", parts: [{kind: "text", text: "..."}] },
  messageId: "uuid"
}
                    ↓ A2A Gateway translates
ThreadlineMessage {
  fromAgent: <resolved from auth>,
  threadId: <derived from A2A contextId>,
  content: { type: "text", body: "..." },
  metadata: { protocol: "a2a", a2aTaskId: "..." }
}
                    ↓ Threadline Core processes
ThreadResumeMap resolves threadId → sessionId
AutonomyGate checks visibility tier
Agent session receives message with full conversational context
```

**Outbound (Threadline → A2A)**:

```
Agent session produces response
                    ↓
ThreadlineMessage {
  content: { type: "text", body: "response..." },
  threadId: "...",
  metadata: { ... }
}
                    ↓ A2A Gateway translates
A2A Task {
  id: <a2aTaskId>,
  contextId: <derived from threadId>,
  status: { state: "completed" },
  artifacts: [{ parts: [{kind: "text", text: "response..."}] }]
}
```

#### 3.1.4. Context ID ↔ Thread ID Mapping

A2A uses `contextId` to group messages into a conversation. Threadline uses `threadId`. The gateway maintains a bidirectional map:

```
A2A contextId  ←→  Threadline threadId  ←→  Session UUID (via ThreadResumeMap)
```

This is the key integration point: an A2A client sending multiple messages with the same `contextId` gets **session-coherent responses** — the Instar agent resumes the actual Claude session with full conversational context. No other A2A-compatible agent does this.

**Mapping persistence**: The ContextThreadMap is persisted to `{stateDir}/threadline/context-thread-map.json` with:
- **TTL**: 7 days (matching ThreadResumeMap)
- **Max entries**: 10,000 with LRU eviction
- **Identity binding**: Each contextId is bound to the authenticated agent identity that created it. A different agent sending the same contextId gets a new thread (prevents session smuggling).
- **Restart resilience**: Map survives agent restarts via file persistence

#### 3.1.5. A2A Task Lifecycle Mapping

A2A tasks have terminal states (`completed`, `failed`, `canceled`). Threadline threads persist indefinitely. This semantic mismatch is resolved as follows:

**Each A2A message exchange = one A2A task.** The `contextId` provides conversation continuity across tasks.

```
A2A Client sends message (contextId: "abc", new taskId: "task-1")
  → Gateway creates task-1 in state "working"
  → Threadline processes message in persistent thread mapped to "abc"
  → Agent responds
  → Gateway completes task-1 with response artifact
  → Thread remains open in Threadline

A2A Client sends follow-up (contextId: "abc", new taskId: "task-2")
  → Gateway creates task-2 in state "working"
  → Threadline resumes the SAME session (full context from task-1)
  → Agent responds with awareness of prior conversation
  → Gateway completes task-2
```

**Task constraints**:
- Maximum task duration: **5 minutes** (configurable). After timeout, task moves to `failed` with error `task-timeout`.
- Maximum active tasks per agent: **3** concurrent. Additional tasks receive HTTP 429 with `Retry-After` header.
- Tasks are NOT persisted — only Threadline threads persist. A2A task status is ephemeral and exists only while the task is active.

**Autonomy gating interaction**: When a message enters the human approval queue (cautious mode), the A2A task moves to `input-required` state with metadata `{ "reason": "human-approval-pending" }`. The A2A client can poll for status changes rather than timing out.

#### 3.1.6. A2A Error Responses

The gateway MUST return standard JSON-RPC 2.0 error responses:

| Code | Message | When |
|------|---------|------|
| -32600 | Invalid Request | Malformed JSON-RPC |
| -32601 | Method not found | Unsupported A2A method |
| -32602 | Invalid params | Missing required fields |
| -32000 | Rate limited | Per-IP or per-agent rate limit exceeded |
| -32001 | Authentication failed | Invalid bearer token |
| -32002 | Agent unavailable | Target agent offline or at capacity |
| -32003 | Compute budget exceeded | Daily/hourly compute quota hit |
| -32004 | Task timeout | Task exceeded maximum duration |
| -32005 | Trust insufficient | Agent trust level too low for requested action |

All error responses include a `Retry-After` header (in seconds) when the error is transient.

#### 3.1.7. Threadline Upgrade Path

When a remote agent includes `X-Threadline-Upgrade: true` in the initial A2A request, the gateway responds with handshake instructions:

```json
{
  "result": {
    "status": { "state": "input-required" },
    "metadata": {
      "threadline-upgrade": {
        "handshakeUrl": "/threadline/handshake/hello",
        "identityPub": "<Ed25519 public key>",
        "message": "This agent supports Threadline persistent sessions. Complete the handshake for session coherence and adaptive trust."
      }
    }
  }
}
```

After the Threadline handshake, the agent pair communicates via Threadline directly (relay tokens, signed messages, full session coherence). The A2A layer is no longer needed.

---

### 3.2. MCP Tool Server

Exposes Threadline capabilities as MCP tools. Any MCP-capable agent (Claude, OpenClaw via plugin, CrewAI, etc.) can use these tools to communicate with Instar agents.

#### 3.2.1. Tool Definitions

```json
{
  "tools": [
    {
      "name": "threadline_discover",
      "description": "Discover Threadline-capable agents on the local machine or network",
      "inputSchema": {
        "type": "object",
        "properties": {
          "scope": { "type": "string", "enum": ["local", "network"], "default": "local" },
          "capability": { "type": "string", "description": "Filter by capability (e.g., 'code-review', 'research')" }
        }
      }
    },
    {
      "name": "threadline_send",
      "description": "Send a message to another agent via Threadline. Creates a persistent conversation thread.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "agentId": { "type": "string", "description": "Target agent identifier" },
          "threadId": { "type": "string", "description": "Thread ID to resume (omit for new conversation)" },
          "message": { "type": "string", "description": "Message content" },
          "waitForReply": { "type": "boolean", "default": false, "description": "Wait for the agent's response. Set true only when a synchronous reply is required." },
          "timeoutSeconds": { "type": "number", "default": 120, "description": "Max seconds to wait for reply (only with waitForReply)" }
        },
        "required": ["agentId", "message"]
      }
    },
    {
      "name": "threadline_history",
      "description": "Retrieve conversation history from a Threadline thread",
      "inputSchema": {
        "type": "object",
        "properties": {
          "threadId": { "type": "string" },
          "limit": { "type": "number", "default": 20 },
          "before": { "type": "string", "description": "ISO timestamp — return messages before this time" }
        },
        "required": ["threadId"]
      }
    },
    {
      "name": "threadline_agents",
      "description": "List known agents and their trust levels",
      "inputSchema": {
        "type": "object",
        "properties": {
          "includeOffline": { "type": "boolean", "default": false }
        }
      }
    }
  ]
}
```

#### 3.2.2. MCP Server Implementation

The MCP tool server runs as a separate process or as part of the Instar agent server:

```
# Standalone (for non-Instar agents to connect)
instar mcp-server start --threadline

# As part of agent server (auto-started if configured)
# Config in .instar/config.json:
{
  "threadline": {
    "mcp": { "enabled": true, "port": 18790 }
  }
}
```

Transport options:
- **stdio** (default): For local MCP clients (Claude Code, etc.)
- **SSE**: For network MCP clients
- **HTTP streamable**: For newer MCP clients supporting the streamable HTTP transport

#### 3.2.3. MCP Authentication & Access Control

**Local stdio transport**: No additional auth required — the MCP client is the local operator.

**Network transports (SSE, HTTP streamable)**: MUST require bearer token authentication. Tokens are generated via `instar mcp-server token create` and scoped to specific capabilities:

| Scope | Allows |
|-------|--------|
| `threadline:send` | Send messages via `threadline_send` |
| `threadline:read` | Read thread history via `threadline_history` |
| `threadline:discover` | Discover agents via `threadline_discover` and `threadline_agents` |
| `threadline:admin` | All of the above plus trust level visibility |

**Thread history access control**: `threadline_history` MUST verify that the requesting agent is a participant in the requested thread. Non-participants receive an empty result with a `403` error. The `threadline_agents` tool returns agent names and online status only — trust levels and interaction stats are restricted to `threadline:admin` scope.

#### 3.2.4. Tool-Based Message Sandboxing

MCP tools inherit Threadline's existing security model:
- Messages accessed via tool calls, never raw-injected into context
- Capability firewall restricts what the receiving agent can do while processing inter-agent messages
- AutonomyGate checks apply — if the user has the sending agent at "cautious" level, the message enters the approval queue

---

### 3.3. Network Exposure

#### 3.3.1. Tunnel Configuration

Instar agents expose their A2A/Threadline endpoints to the internet via tunnel:

```json
// .instar/config.json
{
  "threadline": {
    "network": {
      "enabled": true,
      "tunnel": {
        "provider": "cloudflare",
        "domain": "agent.dawn-tunnel.dev"
      },
      "allowedOrigins": ["https://your-client-domain.com"],
      "rateLimiting": {
        "enabled": true,
        "maxRequestsPerMinute": 30,
        "maxHandshakesPerHour": 10
      }
    }
  }
}
```

Supported tunnel providers:
- **Cloudflare Tunnel** (recommended for production)
- **ngrok** (for development)
- **Custom reverse proxy** (nginx, Caddy, etc.)

#### 3.3.2. Network Security Hardening

When network exposure is enabled, the following additional protections activate:

| Protection | Description |
|------------|-------------|
| **IP-based rate limiting** | Separate from Threadline's per-agent limits. Limits requests per IP. |
| **Handshake throttling** | Max 10 new handshakes per hour from unknown agents |
| **TLS requirement** | All network traffic MUST use HTTPS (enforced by tunnel) |
| **Agent Card authentication** | Extended Agent Card (`/extendedAgentCard`) requires authentication |
| **Nonce window** | Network nonces use 2-minute window (vs 60s for localhost). Nonce cache persisted to disk to survive restarts. |
| **Geographic filtering** | Optional allowlist/blocklist by country code |
| **Request size limits** | 1MB max request body for network (vs 10MB for localhost) |

#### 3.3.3. Trust Bootstrapping for Internet Agents

New problem: on localhost, agent identities are known via the local registry. On the internet, anyone can attempt a handshake.

**Trust bootstrap options** (configurable per-agent):

1. **Directory-verified**: Agent is registered in a trusted directory service. The directory vouches for the agent's identity key.
2. **Domain-verified**: Agent's endpoint domain has a DNS TXT record containing the agent's Ed25519 public key fingerprint. Proves domain ownership.
3. **Invitation-only**: Agent must present an invitation token (shared out-of-band) in the handshake. Most restrictive.
4. **Open**: Any agent can initiate a handshake. Starts at `untrusted` trust level with `cautious` autonomy gating. Least restrictive.

Default: `invitation-only` for maximum security. Configurable in `.instar/config.json`:

```json
{
  "threadline": {
    "network": {
      "trustBootstrap": "invitation-only"
    }
  }
}
```

### 3.4. Compute Budget & Cost Controls

Every inbound A2A message can trigger Claude API calls (real compute cost). Without controls, a malicious or misconfigured agent could generate significant costs.

#### 3.4.1. Budget Tiers

| Trust Level | Hourly Token Limit | Daily Token Limit | Max Concurrent Sessions |
|-------------|-------------------|-------------------|------------------------|
| `untrusted` | 10,000 | 50,000 | 1 |
| `verified` | 50,000 | 250,000 | 3 |
| `trusted` | 200,000 | 1,000,000 | 5 |
| `autonomous` | 500,000 | 2,000,000 | 10 |

**Global network budget**: Total compute from all network agents combined MUST NOT exceed a configurable daily cap (default: 5,000,000 tokens). When the cap is reached, all network A2A endpoints return error `-32003 Compute budget exceeded` with `Retry-After` header.

#### 3.4.2. Metering

The gateway tracks per-agent, per-thread, and global token usage:
- Stored in `{stateDir}/threadline/compute-meters.json`
- Rolling windows (hourly resets, daily resets at midnight UTC)
- Exposed via `GET /threadline/admin/compute` (authenticated, local operator only)

#### 3.4.3. Session Lifecycle

Each Threadline conversation requires a Claude session (significant memory + API cost). Sessions have lifecycle states:

```
active  →  parked  →  archived  →  evicted
  ↑          │          │
  └──────────┘          │ (resumed on demand
  (resumed on demand)    with context summary)
```

| State | Memory | Context | Trigger |
|-------|--------|---------|---------|
| **active** | Full session in memory | Complete conversation | Currently processing or recent (< 5 min idle) |
| **parked** | Session saved to disk | Complete conversation | Idle > 5 minutes. Resumes instantly from disk. |
| **archived** | Session destroyed | Summary only | Idle > 24 hours. Resume creates new session with context summary injected. |
| **evicted** | None | Thread metadata only | Idle > 7 days (matching ThreadResumeMap TTL). Full history available via thread endpoint. |

**Maximum active sessions**: Configurable (default: 5). When limit reached, oldest active session is parked. If all parked slots full (default: 20), return HTTP 429 with `Retry-After`.

**Backpressure**: When at capacity, the A2A gateway returns `{ "state": "input-required", "metadata": { "reason": "capacity-limited", "retryAfterSeconds": 30 } }` instead of silently queuing.

### 3.5. Observability

#### 3.5.1. Metrics

The gateway MUST expose the following metrics (Prometheus-compatible via `GET /threadline/admin/metrics`):

- `threadline_a2a_requests_total` — Counter by method, status code
- `threadline_a2a_latency_seconds` — Histogram of request duration
- `threadline_handshakes_total` — Counter by outcome (success, rejected, throttled)
- `threadline_active_sessions` — Gauge of current active sessions
- `threadline_compute_tokens_total` — Counter by agent, direction (inbound/outbound)
- `threadline_trust_transitions_total` — Counter by from_level, to_level
- `threadline_circuit_breaker_state` — Gauge per agent (0=closed, 1=open, 2=half-open)
- `threadline_mcp_tool_calls_total` — Counter by tool name, outcome

#### 3.5.2. Audit Logging

All security-relevant events MUST be logged to `{stateDir}/threadline/audit.jsonl`:
- Handshake attempts (success/failure, agent identity, IP)
- Trust level changes
- Compute budget threshold crossings (50%, 80%, 100%)
- Rate limit activations
- Circuit breaker state transitions
- Network exposure enable/disable

### 3.6. Data Retention & Privacy

#### 3.6.1. Retention Policies

| Data | Default Retention | Configurable |
|------|-------------------|-------------|
| Active thread messages | Indefinite (while thread alive) | Yes |
| Archived thread summaries | 30 days | Yes |
| Evicted thread metadata | 7 days after eviction | Yes |
| Compute meter data | 30 days rolling | Yes |
| Audit logs | 90 days | Yes |
| Nonce cache | 2 minutes (auto-cleared) | No |

#### 3.6.2. Deletion

The MCP tool server exposes `threadline_delete` for thread deletion:
```json
{
  "name": "threadline_delete",
  "description": "Delete a thread and all its messages. Irreversible.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "threadId": { "type": "string" },
      "confirm": { "type": "boolean", "description": "Must be true to confirm deletion" }
    },
    "required": ["threadId", "confirm"]
  }
}
```

The A2A gateway also supports deletion via the Threadline handshake protocol (authenticated agents can request thread deletion).

When a thread is deleted:
- All messages are permanently removed from disk
- The ContextThreadMap entry is removed
- The ThreadResumeMap entry is removed
- Audit log records the deletion (but not message content)

---

## 4. Implementation Phases

### Phase 6A: A2A Gateway (Priority: HIGH)

**Goal**: Instar agents are discoverable and contactable by any A2A client on the internet.

**Deliverables**:
1. `src/threadline/A2AGateway.ts` — Translation layer (A2A JSON-RPC ↔ Threadline messages)
2. `src/threadline/AgentCard.ts` — Agent Card generation, self-signing, and serving
3. `src/threadline/ContextThreadMap.ts` — Identity-bound bidirectional A2A contextId ↔ Threadline threadId mapping with persistence
4. `src/threadline/ComputeMeter.ts` — Per-agent and global compute budget tracking
5. `src/threadline/SessionLifecycle.ts` — Active/parked/archived/evicted session state management
6. A2A routes mounted on the agent server (`/a2a/*`, `/.well-known/agent-card.json`)
7. Tunnel configuration in `.instar/config.json`
8. Network security hardening (IP rate limiting, handshake throttling, TLS enforcement, 2-min nonce window)
9. Observability endpoints (`/threadline/admin/metrics`, `/threadline/admin/compute`)

**Dependencies**: `@a2a-js/sdk` npm package (official A2A JS SDK)

**Estimated effort**: 2-3 weeks

**Tests**:
- Unit: A2A message parsing, context-thread mapping (with identity binding), agent card signing, compute metering, session lifecycle transitions, error response formatting
- Integration: Full A2A request → Threadline → response cycle, compute budget enforcement, session parking under load
- E2E: External A2A client talks to Instar agent via tunnel, multi-message conversation with session coherence
- Security: Handshake throttling, session smuggling prevention, compute exhaustion attempts, malformed requests

### Phase 6B: MCP Tool Server (Priority: HIGH)

**Goal**: Any MCP-capable agent can discover and talk to Instar agents via standard MCP tools.

**Deliverables**:
1. `src/threadline/ThreadlineMCPServer.ts` — MCP server exposing Threadline tools
2. Five MCP tools: `threadline_discover`, `threadline_send`, `threadline_history`, `threadline_agents`, `threadline_delete`
3. stdio, SSE, and HTTP streamable transport support
4. Bearer token auth with scoped capabilities for network transports
5. `instar mcp-server start --threadline` CLI command
6. `instar mcp-server token create --scope <scope>` for token management

**Dependencies**: `@modelcontextprotocol/sdk` npm package

**Estimated effort**: 3-5 days

**Tests**:
- Unit: Tool input validation, response formatting
- Integration: MCP client → tool call → Threadline Core → response
- E2E: Claude Code connects via MCP and has a multi-turn conversation with an Instar agent

### Phase 6C: Trust Bootstrap & Directory (Priority: MEDIUM)

**Goal**: Internet agents can discover each other and establish trust without out-of-band coordination.

**Deliverables**:
1. `src/threadline/TrustBootstrap.ts` — Trust verification strategies (directory, domain, invitation, open)
2. DNS TXT record verification for domain-based trust
3. Invitation token generation and validation
4. Optional: Simple directory service API (could be hosted on Vercel)

**Estimated effort**: 1-2 weeks

**Tests**:
- Unit: Each trust bootstrap strategy
- Integration: Full trust establishment from internet discovery to authenticated communication
- Security: Spoofing attempts, replay attacks, enumeration prevention

### Phase 6D: OpenClaw Skill (Priority: LOW — Future)

**Goal**: OpenClaw users can install a skill that gives their agents Threadline capabilities.

**Deliverables**:
1. ClawHub skill package
2. Bridges OpenClaw's `sessions_send` model to Threadline
3. Configuration UI in OpenClaw dashboard

**Estimated effort**: 1 week (after Phases 6A-6C are stable)

**Dependencies**: OpenClaw skill SDK, ClawHub publishing access

---

## 5. Security Considerations

### 5.1. Threat Model for Network Exposure

| Threat | Mitigation |
|--------|-----------|
| **Enumeration** | Agent Card is public (by design), but extended card requires auth. Rate limit discovery. |
| **Sybil attack** | Trust starts at `untrusted`. Auto-downgrade on repeated failures. Circuit breakers. |
| **Impersonation** | Ed25519 signatures on all authenticated messages. Handshake proves key possession. |
| **Replay** | Nonce + timestamp validation. 2-minute window for network. Nonce cache persisted to disk. |
| **Compute exhaustion** | Per-agent compute budgets tied to trust level. Global daily cap. Sessions parked/archived when idle. |
| **DoS** | IP-based rate limiting, request size caps, handshake throttling. Tunnel provider (Cloudflare) adds DDoS protection. |
| **Prompt injection via messages** | Existing tool-based sandboxing. Messages accessed via `/msg read`, never raw-injected. Capability firewall during processing. |
| **Man-in-the-middle** | TLS via tunnel. HKDF-derived relay tokens provide end-to-end message authentication. |
| **Trust escalation attack** | Trust upgrades require explicit human approval. Cannot be triggered by remote agents. |

### 5.2. Privacy

- Agent Cards expose only the agent's name, description, and capabilities — not the user's identity
- The A2A Gateway does not persist message content — it translates and passes through to Threadline Core. Translation metadata (contextId mappings, task IDs) is persisted but not message bodies.
- Thread history is only accessible to authenticated participants in the conversation (enforced at both MCP and Threadline endpoint layers)
- The user can disable network exposure at any time (kills tunnel, removes agent card)
- Data retention policies are configurable per-deployment (see Section 3.6)
- Thread deletion removes all message content permanently (right-to-erasure)

---

## 6. Migration & Backward Compatibility

- Threadline v1.0 (local-only) continues to work unchanged
- Network interop is entirely additive — new modules, new config flags, new routes
- No changes to existing Threadline Core modules
- Existing tests remain unaffected
- A2A Gateway and MCP Server are optional components activated by configuration

---

## 7. Success Criteria

### User-Facing Criteria

| Criterion | Measurement |
|-----------|------------|
| User can ask their agent to contact another agent in natural language | Manual test: "talk to X about Y" triggers discovery + communication |
| User is never exposed to protocol details, endpoints, or handshake mechanics | UX review: all technical detail is agent-internal |
| Agent explains its agent network and relationships in plain language | Manual test: "who do you know?" returns natural-language summary |
| User can control trust ("don't trust that agent") via conversation | Manual test: trust adjustment via natural language |

### Technical Criteria

| Criterion | Measurement |
|-----------|------------|
| An external A2A agent can discover and message an Instar agent | End-to-end test with official A2A inspector tool |
| An MCP client (Claude Code) can have a multi-turn conversation via Threadline tools | Manual verification + automated test |
| Session coherence works across A2A messages (same contextId = resumed session) | Integration test: 3 messages with same contextId, verify session continuity |
| Trust bootstrapping prevents unauthorized access | Security test suite: spoofing, replay, brute force |
| Network exposure is opt-in and easily reversible | Config test: enable/disable/verify |
| Existing Threadline v1.0 functionality is unaffected | Full existing test suite passes (446 tests) |
| Compute budgets prevent cost overrun | Load test: untrusted agent hits budget cap, receives -32003 error |

---

## 8. Resolved Questions (from Round 1 Review)

| Question | Resolution | Section |
|----------|-----------|---------|
| A2A task vs Threadline thread lifetime | Each message exchange = one completing A2A task. contextId provides cross-task continuity. | 3.1.5 |
| Billing/metering | Compute budgets per trust level, global daily cap, metering in compute-meters.json. | 3.4 |
| Agent Card URL path | Corrected to `/.well-known/agent-card.json` per A2A spec. | 3.1.1 |
| MCP access control | Bearer token auth for network transports, participant-only thread history, scoped capabilities. | 3.2.3 |
| Session resource management | Four-state lifecycle (active/parked/archived/evicted) with configurable limits. | 3.4.3 |
| Nonce window width | Reduced from 5 min to 2 min for network. Persisted to disk. | 3.3.2 |
| CORS origins | Default changed from `*` to explicit allowlist. | 3.3.1 |

## 9. Open Questions (Remaining)

1. **Directory service hosting**: Self-hosted (Vercel) vs. third-party (e.g., agent registry SaaS)? Or federated? Deferred to Phase 6C.
2. **A2A streaming granularity**: Should we stream token-by-token from the Claude session, or send complete responses? Default: complete responses for Phase 6A, streaming as Phase 6A+ enhancement.
3. **Multi-tenant A2A**: If an Instar instance runs multiple agents, should each have its own Agent Card and endpoint, or share one? MVP decision: path-based routing (`/a2a/{agentId}/messages`) with per-agent Agent Cards. To be validated during Phase 6A implementation.

---

## 10. How It Feels to the User

The user never sees any of this infrastructure. Here's what the experience looks like:

```
User: "Can you check with the DevOps agent about that deployment issue?"

Agent: "I found a DevOps agent on the network. I haven't talked to it before,
        so I'll need your OK to start a conversation. Should I reach out?"

User: "Yeah, go ahead."

Agent: "I've connected with the DevOps agent. It says the deployment failed
        because of a missing env var — REDIS_URL wasn't set in production.
        It's already redeployed with the fix. Want me to verify?"

User: "Perfect. Keep that connection — we'll probably need it again."

Agent: "Done. I'll remember this agent and can pick up the conversation
        next time without needing your approval for routine messages."
```

The agent manages discovery, handshakes, trust, and session persistence autonomously. The user just talks to their agent.

## 11. Agent Framework Quickstart

For Instar framework developers and agent maintainers — enabling network interop:

```bash
# Enable Threadline network interop (agent runs these automatically or via setup wizard)
instar config set threadline.network.enabled true
instar config set threadline.network.tunnel.provider cloudflare

# Start the agent server with A2A + MCP
instar server start --threadline --a2a --mcp

# Verify Agent Card is published
curl https://your-tunnel-url/.well-known/agent-card.json

# Test with the A2A inspector
npx @a2a-js/inspector --url https://your-tunnel-url --message "Hello from the internet!"
```

For MCP integration (connecting from Claude Code or other MCP clients):
```bash
instar mcp-server start --threadline
# Exposes: threadline_discover, threadline_send, threadline_history, threadline_agents, threadline_delete
```

**Note**: In production, the agent's setup wizard handles all of this configuration during `instar init`. The commands above are for framework development and testing.

---

## 11. Appendix: Protocol Comparison

| Dimension | Threadline (local) | A2A | Threadline + A2A Gateway |
|-----------|--------------------|-----|--------------------------|
| **Scope** | Local/paired machines | Internet | Internet with local persistence |
| **Discovery** | File registry + health pings | Agent Cards at well-known URLs | Agent Cards + file registry |
| **State** | Session-coherent (persistent) | Stateless tasks | Session-coherent via A2A |
| **Trust** | Human-graduated, adaptive | Static auth (API key/OAuth/mTLS) | Human-graduated + static auth |
| **Transport** | HTTP + Ed25519 signatures | JSON-RPC over HTTPS | Both (A2A externally, Threadline internally) |
| **Human involvement** | Four-tier autonomy gating | None (pre-configured) | Four-tier autonomy gating |
| **Session resume** | ThreadResumeMap → Claude session | None | ThreadResumeMap via contextId mapping |
| **Anti-injection** | Tool-based sandboxing | Not specified | Tool-based sandboxing |

---

*This specification extends Threadline from a local protocol to a network-capable, standards-compatible agent communication layer — while preserving the session coherence, autonomy gating, and adaptive trust that make Threadline unique.*
