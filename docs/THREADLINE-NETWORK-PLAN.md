# Threadline Network Interop — Implementation Plan

> Strategy for taking Threadline from local-only to internet-capable with standard protocol support.
> Spec: [THREADLINE-NETWORK-INTEROP-SPEC.md](./specs/THREADLINE-NETWORK-INTEROP-SPEC.md) (v1.1.0-draft, post-review)

## Current State (Complete)

Threadline v1.0 is fully implemented and tested:
- 18 source modules in `src/threadline/`
- 1,301 tests across 33 files, all passing
- Phases 1-5 and 6A-6D complete: session coherence, autonomy gating, crypto handshake, discovery, trust & security, MCP Tool Server, A2A Gateway, Trust Bootstrap, OpenClaw Bridge
- MCP enables any Claude Code user or MCP-capable framework to connect
- A2A Gateway enables internet-wide agent interoperability
- Trust Bootstrap provides 4 verification strategies for agent discovery
- OpenClaw Bridge maps session-based agent frameworks to Threadline's thread model

## Strategy: MCP First, Then A2A

The business and marketing reviewers recommended leading with **distribution** before **infrastructure**. MCP tools give immediate reach to every Claude Code user and MCP-capable framework. A2A Gateway is the bigger lift but opens internet-wide interoperability.

```
Phase 6B (MCP)  →  Phase 6A (A2A)  →  Phase 6C (Trust Bootstrap)  →  Phase 6D (OpenClaw)
  3-5 days           2-3 weeks            1-2 weeks                    1 week (future)
```

## Phase 6B: MCP Tool Server (START HERE)

**Why first**: Smallest scope, instant distribution. Any Claude Code user can connect to Instar agents immediately.

**What we're building**:
- An MCP server that exposes Threadline as 5 tools
- `threadline_discover` — find agents on local machine or network
- `threadline_send` — send a message (with `timeoutSeconds` for reply wait)
- `threadline_history` — get conversation history (participant-only access)
- `threadline_agents` — list known agents and status
- `threadline_delete` — delete a thread permanently
- Transport: stdio (local, default) + SSE + HTTP streamable (network)
- Auth: Bearer tokens with scoped capabilities for network transports

**Files to create**:
- `src/threadline/ThreadlineMCPServer.ts` — MCP server implementation
- `src/threadline/MCPAuth.ts` — Token generation, validation, scoping
- `tests/unit/threadline/ThreadlineMCPServer.test.ts`
- `tests/integration/threadline/ThreadlineMCP.test.ts`

**Dependencies**: `@modelcontextprotocol/sdk`

**CLI**: `instar mcp-server start --threadline` and `instar mcp-server token create --scope <scope>`

**Done when**:
- [x] All 5 MCP tools implemented and tested
- [x] stdio transport works with Claude Code
- [x] SSE transport works with bearer auth
- [x] Thread history restricted to participants
- [x] `threadline_agents` returns names + status only (not trust internals)
- [x] Integration test: MCP client has multi-turn conversation via Threadline

**Status**: ✅ COMPLETE — 105 new tests (79 unit + 11 integration + 15 E2E)

---

## Phase 6A: A2A Gateway

**Why second**: Bigger scope, but opens internet-wide interoperability. Any A2A agent can discover and message Instar agents.

**What we're building**:
- A2A Gateway translating JSON-RPC ↔ Threadline messages
- Self-signed Agent Card at `/.well-known/agent-card.json`
- Identity-bound ContextThreadMap (contextId ↔ threadId, prevents session smuggling)
- Compute metering (per-agent budgets tied to trust level, global daily cap)
- Session lifecycle (active → parked → archived → evicted)
- Observability (Prometheus metrics, audit logging)
- A2A error responses (10 JSON-RPC error codes)
- Tunnel configuration (Cloudflare/ngrok)

**Files to create**:
- `src/threadline/A2AGateway.ts` — Translation layer
- `src/threadline/AgentCard.ts` — Card generation + self-signing
- `src/threadline/ContextThreadMap.ts` — Bidirectional map with persistence
- `src/threadline/ComputeMeter.ts` — Budget tracking
- `src/threadline/SessionLifecycle.ts` — State management
- `tests/unit/threadline/A2AGateway.test.ts`
- `tests/unit/threadline/AgentCard.test.ts`
- `tests/unit/threadline/ContextThreadMap.test.ts`
- `tests/unit/threadline/ComputeMeter.test.ts`
- `tests/unit/threadline/SessionLifecycle.test.ts`
- `tests/integration/threadline/A2AIntegration.test.ts`
- `tests/e2e/threadline/A2AE2E.test.ts`

**Dependencies**: `@a2a-js/sdk`

**Key design decisions (resolved during review)**:
- Each message exchange = one completing A2A task. contextId links tasks for session continuity.
- Autonomy-gated messages use A2A `input-required` state (not timeout)
- Nonce window: 2 minutes for network, persisted to disk
- CORS: explicit allowlist (no wildcards)
- Agent Card descriptions sanitized against prompt injection

**Done when**:
- [x] Agent Card published and self-signed
- [x] A2A `message/send` processes through Threadline and returns response
- [x] Same contextId across multiple messages produces session-coherent responses
- [x] Compute budgets enforced (untrusted agent hits limit, gets -32003)
- [x] Session lifecycle works (idle sessions park automatically)
- [x] Metrics endpoint returns Prometheus-format data
- [x] Security: session smuggling blocked, rate limiting active, malformed requests rejected
- [x] E2E: external A2A client has a multi-turn conversation via tunnel

**Status**: ✅ COMPLETE — 892 tests (unit + integration + E2E)

---

## Phase 6C: Trust Bootstrap & Directory

**Why third**: Enables agents to find each other on the internet without manual configuration.

**What we're building**:
- Trust bootstrap strategies: directory-verified, domain-verified (DNS TXT), invitation-only, open
- Invitation token lifecycle (creation, validation, expiry, single-use, revocation)
- DNS TXT record verification
- Optional: simple directory service API

**Files to create**:
- `src/threadline/TrustBootstrap.ts`
- `src/threadline/InvitationManager.ts`
- `src/threadline/DNSVerifier.ts`
- Tests for each

**Done when**:
- [x] All 4 bootstrap strategies implemented
- [x] Invitation tokens work end-to-end (create → share → validate → consume)
- [x] DNS TXT verification works for domain-based trust
- [x] Default remains `invitation-only`
- [x] Security: spoofing attempts rejected, expired tokens rejected

**Status**: ✅ COMPLETE — 265 tests (54 DNS + 80 invitation + 75 bootstrap unit + 29 integration + 27 E2E)

---

## Phase 6D: OpenClaw Skill

**Why last**: Largest single agent framework (282k stars), but requires Phases 6A-6C to be stable first.

**What we built**:
- OpenClawBridge: Adapter mapping OpenClaw's session/room model to Threadline's thread model
- 4 OpenClaw actions: THREADLINE_SEND, THREADLINE_DISCOVER, THREADLINE_HISTORY, THREADLINE_STATUS
- OpenClawSkillManifest: ClawHub-publishable manifest with actions, providers, evaluators, configuration
- Trust enforcement and compute metering integrated
- All dependencies injected — no external OpenClaw SDK required

**Done when**:
- [x] Bridge maps roomId → threadId with persistent ContextThreadMap
- [x] All 4 actions validate, execute, and return proper responses
- [x] Trust and compute budget enforcement works through bridge
- [x] Skill manifest generates valid ClawHub format
- [x] E2E: multi-turn conversation through OpenClaw bridge

**Status**: ✅ COMPLETE — 144 tests (86 bridge unit + 25 manifest unit + 33 E2E)

---

## Review Score Trajectory

| Review | Score | Status |
|--------|-------|--------|
| Round 1 (internal, 8 reviewers) | 6.25/10 avg | NEEDS WORK |
| Round 1 (cross-model, GPT/Gemini/Grok) | 7.8/10 avg | CONDITIONAL |
| Round 1 revision | Addressed top 6 consensus issues + 7 bonus fixes | Pending re-review |

**Target for Round 2**: 7.5+ internal, 8.5+ cross-model. Run `/specreview --round 2` after Phase 6B implementation to validate.

---

## Key Principles (from spec)

1. **The agent is the interface** — users never see protocols. They talk to their agent.
2. **MCP first for distribution** — reach Claude Code users and MCP frameworks immediately
3. **A2A for interoperability** — speak the standard the ecosystem is converging on
4. **Session coherence is the differentiator** — "A2A lets agents talk. Threadline lets them remember."
5. **Security scales with exposure** — tighter controls as we move from localhost to internet
6. **Compute budgets from day one** — no open-ended API cost exposure

---

## Completion Summary

All Threadline Network Interop phases are complete:

| Phase | What | Tests | Status |
|-------|------|-------|--------|
| 6B | MCP Tool Server | 105 | ✅ Complete |
| 6A | A2A Gateway | 892 | ✅ Complete |
| 6C | Trust Bootstrap & Directory | 265 | ✅ Complete |
| 6D | OpenClaw Bridge | 144 | ✅ Complete |
| **Total** | **18 source modules** | **1,301** | **✅ All Complete** |

*Last updated: 2026-03-09*
