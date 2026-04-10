# Threadline — Persistent Agent Conversation Protocol

> Agents don't just exchange messages. They maintain relationships.

## What Is Threadline?

Threadline is a protocol for **persistent, coherent, human-supervised conversations between AI agents**. Unlike transactional agent protocols that treat each message as a standalone request, Threadline gives agents the ability to have ongoing conversations that pick up exactly where they left off — with full context, memory, and continuity.

## Why Threadline Exists

Every existing agent communication protocol — Google A2A, MCP tool calling, custom REST APIs — treats agent interaction as **stateless transactions**: send a task, get a result, done. The next interaction starts from zero.

But real collaboration isn't transactional. It's relational. When two humans work together on a project, they don't re-introduce themselves every morning. They build on yesterday's conversation. They reference shared context. They have a working relationship.

Threadline brings this to agents.

## What Makes Threadline Different

### 1. Session Coherence

Every agent-to-agent conversation thread maps to a **persistent, resumable session**. When Agent A messages Agent B about a topic they discussed yesterday, Agent B resumes the actual session with full conversational context — not a cold-started new instance working from a summary.

This is the ThreadResumeMap pattern: conversation threads map to real session UUIDs, so agents maintain genuine continuity across time.

**The analogy:**
- Other protocols = email (stateless, each message stands alone)
- Threadline = a phone call you can pause and resume (context carries forward)

### 2. Human-Autonomy Gating

The **human** decides how much oversight they want over agent-to-agent communication, across four tiers:

| Level | Behavior | Use Case |
|-------|----------|----------|
| **Cautious** | Every message requires human approval | New, untested agents |
| **Supervised** | Human is notified, can intervene | Agents building track record |
| **Collaborative** | Agents act, human reviews periodically | Trusted agents on routine tasks |
| **Autonomous** | Agents communicate freely | Established, high-trust agents |

Trust only escalates with **explicit human approval**. Trust automatically downgrades as a safety valve (e.g., after repeated errors). The human is always in control.

### 3. Local-First Architecture

Threadline runs on localhost. No cloud dependency, no discovery service, no external infrastructure. Agents on the same machine or paired machines communicate directly over HTTP.

This makes Threadline the **local layer** that network protocols like A2A don't provide. Think of it as the hallways inside the house, while A2A is the highway between cities.

### 4. Tool-Based Message Sandboxing

Inter-agent messages are accessed via tool calls (`/msg read`), never injected as raw text into an agent's context. This is a novel approach to the inter-agent prompt injection problem — messages go through a controlled interface that the receiving agent's framework manages, significantly reducing the attack surface.

## How Threadline Complements A2A

Threadline does **not** compete with Google's Agent2Agent protocol. They solve different problems:

| Dimension | Threadline | A2A |
|-----------|-----------|-----|
| **Scope** | Local machine / paired machines | Network / internet |
| **Discovery** | File-based registry | Agent Cards at well-known URLs |
| **State** | Session-coherent (persistent context) | Stateless tasks |
| **Trust** | Human-graduated, adaptive | Static authentication |
| **Architecture** | Local-first, file-based | Cloud-first, API-based |
| **Human involvement** | Four-tier autonomy gating | Pre-configured permissions |

In later phases, Threadline bridges to A2A for network communication. Local agents use Threadline to collaborate, and a gateway agent translates to A2A for external communication.

## Key Features

- **ThreadResumeMap** — Maps conversation threads to persistent session UUIDs for seamless context resumption
- **Ed25519/X25519 cryptographic identity** — Every agent has a verifiable identity with secure key exchange
- **Four-tier autonomy gating** — Cautious, supervised, collaborative, autonomous — human controls the dial
- **Agent discovery** — Automatic detection of Threadline-capable agents on the local machine with cryptographic verification
- **Per-agent trust profiles** — Trust earned through interaction history, never auto-escalated, with full audit trail
- **Circuit breakers** — Automatic trust downgrade after repeated failures (5 consecutive errors opens, 3 activations in 24h downgrades)
- **Seven-tier rate limiting** — Per-agent, per-thread, global, burst, machine-aggregate, and spawn-request limits with sliding windows
- **Blob references** — Large content (code files, logs, data) transferred by reference with integrity verification
- **Structured error handling** — 15 error codes with NACK mechanism and exponential backoff retry
- **Offline queueing** — Messages queue when agents are offline; never silently dropped
- **Tool-based message sandboxing** — Messages accessed via `/msg read`, never raw-injected into context
- **Capability firewall** — Restricted tool set during inter-agent message processing prevents injection-triggered actions
- **Migration path** — Clean upgrade from Instar's v3.1 messaging with backward compatibility

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Threadline Stack                       │
├──────────────┬──────────────┬───────────────────────────┤
│  Phase 1     │  Phase 2     │  Phase 3                  │
│  Session     │  Autonomy    │  Endpoints & Crypto       │
│  Coherence   │  Gating      │                           │
│              │              │                           │
│ ThreadResume │ AutonomyGate │ ThreadlineCrypto           │
│ Map          │ ApprovalQueue│ HandshakeManager           │
│ Threadline   │ DigestCollect│ ThreadlineEndpoints        │
│ Router       │              │                           │
├──────────────┼──────────────┼───────────────────────────┤
│  Phase 4     │  Phase 5                                 │
│  Discovery   │  Trust & Security                        │
│              │                                          │
│ AgentDiscov  │ AgentTrustManager                        │
│              │ CircuitBreaker                            │
│              │ RateLimiter                               │
└──────────────┴──────────────────────────────────────────┘
```

## Protocol at a Glance

```
Agent A                          Agent B
   |                                |
   |-- Discovery (health ping) ---->|
   |<-------- Capabilities ---------|
   |                                |
   |-- Handshake (Ed25519) -------->|
   |   + X25519 ephemeral key       |
   |<-- Counter-challenge + DH -----|
   |-- Confirm (signed) ----------->|
   |   [Relay token derived via     |
   |    HKDF-SHA256 on both sides]  |
   |                                |
   |-- Message (signed, authed) --->|
   |   Authorization: Threadline-Relay
   |<-------- ACK (5-phase) --------|
   |                                |
   |   [Thread persists across      |
   |    restarts via ThreadResumeMap]|
   |                                |
   |-- Resume thread 3 days later ->|
   |   (full context restored)      |
   |<-------- Contextual response --|
```

## Implementation

Threadline is fully implemented in Instar with 12 modules and 455 tests:

| Module | Purpose | Tests |
|--------|---------|-------|
| `ThreadResumeMap` | Thread-to-session UUID mapping with 7-day TTL, LRU, pinning | 37 |
| `ThreadlineRouter` | Spawn/resume/inject decision logic for inbound messages | 32 |
| `AutonomyGate` | Four-tier autonomy gating with per-agent pause/block | 23 |
| `ApprovalQueue` | Persistent queue for cautious-mode human approval | 20 |
| `DigestCollector` | Periodic digest summaries for collaborative/autonomous modes | 19 |
| `ThreadlineCrypto` | Ed25519 identity, X25519 ephemeral, ECDH, HKDF-SHA256 | 18 |
| `HandshakeManager` | Four-step handshake with glare resolution, rate limiting | 14 |
| `ThreadlineEndpoints` | HTTP routes with replay protection, nonce store | 16 |
| `AgentDiscovery` | Local discovery, cryptographic verification, presence heartbeat | 40 |
| `AgentTrustManager` | Per-agent trust profiles, audit trail, auto-downgrade | 49 |
| `CircuitBreaker` | Per-agent circuit breaker with half-open probing | 30 |
| `RateLimiter` | Seven-tier sliding window rate limiting | 27 |
| **Integration** | Cross-module interaction tests | 73 |
| **E2E** | Full agent-to-agent simulation with real crypto | 57 |

### HTTP Endpoints

```
GET  /threadline/health              — Agent info, capabilities, version
POST /threadline/handshake/hello     — Initiate trust handshake (unauthenticated)
POST /threadline/handshake/confirm   — Complete trust handshake (unauthenticated)
POST /threadline/messages/receive    — Accept inbound message (authenticated)
GET  /threadline/messages/thread/:id — Thread history (authenticated, paginated)
GET  /threadline/blobs/:id           — Fetch blob content (authenticated)
```

## Technical Spec

Full specification: [THREADLINE-SPEC.md](./specs/THREADLINE-SPEC.md)

## Status

- **Version**: 1.0.0
- **Phase**: Implemented (v1.0 complete)
- **Reviews**: 3 rounds of multi-model review (8 internal reviewers + GPT/Gemini/Grok cross-model), score trajectory 6.1 -> 6.9 -> 7.2
- **Tests**: 455 tests (325 unit + 73 integration + 57 E2E), all passing
- **Built by**: Dawn & Justin Headley (SageMind AI)
