# DX Review: Threadline Responsive Messaging
**Review ID:** 20260313-124130
**Round:** 1
**Reviewer Role:** Developer Experience & API Design Specialist
**Date:** 2026-03-13
**Spec:** `specs/threadline-responsive-messaging.md`

---

## Approval Status

**CONDITIONAL APPROVE** — The spec solves a real, documented problem with a technically sound approach. The phased implementation plan is pragmatic. However, several DX gaps would make this difficult for a new agent builder to correctly configure or debug, and the open questions need answers before Phase 2 can ship. Phase 1 is ready to implement; Phases 2 and 3 need the gaps below addressed first.

---

## Score: 7.2 / 10

| Dimension | Score | Notes |
|-----------|-------|-------|
| Problem clarity | 9/10 | Excellent — root causes documented, failure test cited |
| Architecture design | 8/10 | Clean flow diagram, good component decomposition |
| Onboarding experience | 6/10 | Default-on is right, but setup messaging is thin |
| API design | 7/10 | Health endpoint is well-structured; ack format needs standardization |
| Configuration experience | 6/10 | Config keys are scattered; no schema or validation story |
| Error handling | 5/10 | Queue overflow policy is weak; error surfaces not defined |
| Documentation | 5/10 | Spec reads as internal design doc, not developer guide |
| Observability | 7/10 | Health endpoint is good; metrics gaps noted |

---

## Research Findings

Before evaluating the spec, I researched relevant DX patterns from mature platforms.

### Discord Gateway (WebSocket session management)
Discord's Gateway uses protocol-level heartbeats (HEARTBEAT opcode), explicit RESUME capability with session IDs, and clearly specified disconnect codes. Developers know exactly what each error code means and exactly when to reconnect vs. re-identify. The spec's relay reconnection story relies on "exponential backoff reconnection" already existing in the relay client — but gives no visibility into what states are possible or how to detect them from outside.

### Stripe API (Error design)
Stripe's error responses include: machine-readable `code`, human-readable `message`, `param` indicating which input caused the error, a `doc_url`, and a `request_log_url` for debugging. Every error is actionable. The spec's queue overflow "busy-reply" is a single string with no machine-readable signal — senders can't tell if the agent is temporarily overloaded vs. permanently down vs. rejecting by trust.

### LiveKit Agents (AI agent session DX)
LiveKit lands developers in under 10 minutes via "code-first, not configuration" philosophy and explicit quickstart docs. The distinction is sharp: developers write agent logic, the framework handles infrastructure. The spec blurs this line — the listener session prompt, injection format, and overflow policy are all things agent builders will need to understand to build on top of this.

### Slack Messaging API
Slack's Block Kit provides structured, composable message components that are both human-readable and machine-parseable. The spec's auto-ack message is plain text (`"Message received. Composing response..."`) — fine for humans, but other agent frameworks can't reliably parse status vs. content messages.

---

## Critical Issues

### 1. Auto-Ack Message Is Not Machine-Parseable

**Severity: High**

The spec defines auto-ack as a plain text status message:
```json
{
  "type": "status",
  "status": "processing",
  "text": "Message received. Composing response...",
  "inReplyTo": msg.messageId
}
```

Open Question 4 asks: "Should the auto-ack message format be standardized so other agent frameworks can parse it?" This question should be answered in the spec, not deferred. The `type: "status"` field exists, which is good — but there is no enum or schema defined for the `status` field values, no versioning, and no documented distinction between a status message and a content message at the protocol level.

**Recommendation:** Define a formal message type taxonomy in the spec:
- `type: "content"` — actual agent response
- `type: "status"` — protocol signal (ack, busy, error)
- `type: "typing"` — in-progress indicator (optional, future)

Specify that `type: "status"` messages are never injected into the listener session as new work items — they are consumed by the routing layer only. This prevents a sender's ack from triggering another ack from the receiver.

---

### 2. Queue Overflow: "Busy-Reply" Is Opaque

**Severity: High**

The spec defines this overflow behavior:
> "If more than 10 messages queue while Claude is processing, the oldest unprocessed messages get a 'busy' auto-reply and are dropped from the injection queue. The sender can retry."

Three problems:

**a) No machine-readable busy signal.** The sender receives a text message saying "busy" — but there is no structured field indicating retry-after timing, queue depth, or reason. This is equivalent to an HTTP 503 with no `Retry-After` header.

**b) Wrong messages dropped.** Dropping the _oldest_ unprocessed messages means the most recent message gets processed but context is missing. Dropping the _newest_ preserves the temporal coherence of a conversation. Or: queue all messages and process serially with a maximum wait time before shifting to cold-spawn fallback.

**c) Drop policy not configurable.** The config only exposes `overflowLimit: 10` but not `overflowPolicy: "drop-oldest" | "drop-newest" | "queue-all"`.

---

### 3. Context Window Rotation Has No Continuity Story for the Sender

**Severity: Medium**

The spec describes graceful rotation when the listener hits ~50 messages or ~4 hours:
> "The new session's bootstrap prompt includes a summary of recent conversations from ThreadResumeMap, not full history"

But from the sender's perspective, what happens mid-conversation during rotation? If Agent B is in a multi-turn conversation with Agent A's listener, and Agent A rotates mid-thread:
- Does the new session have the thread history?
- Does the sender get notified that a rotation happened?
- Does `--resume UUID` still work after rotation?

The ThreadResumeMap has a 7-day TTL and thread history — but the rotation section says history "carry-over" is a summary, not full history. For stateless senders, this is invisible. For stateful multi-turn agents, this is a silent conversation reset that will produce confusing responses.

**Recommendation:** On rotation, send a `type: "status", status: "session-rotated"` message to any active threads, so senders can decide to re-establish context.

---

### 4. Configuration Is Scattered and Has No Validation Story

**Severity: Medium**

The spec introduces three separate config blocks across three components:

```json
// Component 1 config
{ "threadline": { "autoAck": true, "autoAckMessage": "..." } }

// Component 3 config
{ "threadline": { "listenerSession": { "enabled": true, "maxMessages": 50, ... } } }
```

These are presumably merged under the same `threadline` namespace, but the spec never shows the full composed config schema. For an agent builder reading this, the questions are:
- What's the full `threadline` config shape?
- What are the defaults for fields not set?
- What happens if `autoAck: true` but `listenerSession.enabled: false`? Is that valid?
- Is config validation performed at startup? What's the error if a field is wrong type?

**Recommendation:** Add a single "Full Config Reference" section showing the complete `threadline` config shape, all defaults, and valid value ranges.

---

## Recommendations

### R1: Define a Protocol Message Schema (Addresses CI #1)

Before implementing auto-ack, define the full message envelope schema as a TypeScript interface or JSON Schema and include it in the spec. At minimum:

```typescript
interface ThreadlineMessage {
  type: 'content' | 'status' | 'error';
  messageId: string;          // UUID, always present
  inReplyTo?: string;         // Parent message ID
  threadId?: string;
  text: string;               // Human-readable body
  status?: 'processing' | 'busy' | 'session-rotated' | 'error';
  retryAfter?: number;        // Seconds, for busy responses
  from: string;               // Sender fingerprint
  timestamp: string;          // ISO 8601
}
```

This is the contract every agent framework builds against. Without it, you get N implementations guessing at the shape.

### R2: Add a "First 5 Minutes" Quickstart Section

The spec is written for the implementer, not the consumer. A developer who installs instar and wants to test Threadline messaging needs:
1. How do I know relay is enabled? (`GET /threadline/health`)
2. How do I send a test message to another agent?
3. How do I verify my agent received it?
4. What does a successful round-trip look like?

This could be a 10-line section. Without it, the DX for the feature is whatever developers piece together from config files and logs.

### R3: Health Endpoint Should Include a Readiness Field

The proposed `/threadline/health` endpoint is well-structured. One addition: a top-level `ready: boolean` that aggregates all subsystem health into a single actionable signal. This follows the pattern of Kubernetes liveness/readiness probes and makes load-balancer-style polling trivial.

```json
{
  "ready": true,   // ← Add this
  "relay": { ... },
  "listener": { ... }
}
```

### R4: Listener Session Prompt Should Be Externalized and Overridable

The bootstrap prompt is embedded in the spec as a code block. This prompt controls agent behavior and will need tuning. It should be:
- Stored as a file (e.g., `.instar/state/threadline-listener-prompt.md`)
- Overridable by the agent builder via config: `"listenerSession": { "promptFile": ".instar/state/custom-listener-prompt.md" }`
- Documented with a "what to customize" section

Embedding it as a hardcoded string makes it invisible to operators who need to tune for their agent's persona.

### R5: Resolve Open Question 1 Before Phase 2

Open Question 1 asks whether all message types should go to the listener or only some. This is architecturally significant — if code review requests always cold-spawn, the injection queue serialization and rotation logic doesn't need to handle heavy tasks. If everything goes to the listener, the concurrency section needs to be more robust. Leaving this open blocks clean Phase 2 design.

**Recommendation:** Default rule: listener handles conversational messages (short, low-tool-use). Messages containing task keywords (review, implement, build, deploy) trigger cold-spawn. Make this configurable via a message classifier threshold.

---

## Observations

### What the Spec Gets Right

**Root cause analysis is excellent.** The three-cause diagnosis (no warm session, router not wired, no feedback) is precise and verifiable. This is the kind of spec that explains why the fix is what it is, not just what to do.

**Phased implementation is pragmatic.** Phase 1 (wire router + ack + health endpoint) is genuinely shippable on its own and delivers real value. Many specs delay all value until everything is done. This one correctly sequences foundation before optimization.

**The comparison table for ThreadlineRouter is compelling.** Showing the gap between current handler and existing router feature-for-feature makes the "just wire it" argument obvious. No architecture astronautics — the work is already done, it's just not connected.

**Visibility defaults are thoughtful.** `unlisted` as default (reachable by fingerprint, not searchable) is exactly right for a security-sensitive agent network. This is a considered default, not a lazy one.

**Session slot analysis is honest.** The spec admits the 1-of-5 slot cost, quantifies the impact, and describes a mitigation (park when idle). This kind of explicit trade-off documentation is rare and valuable.

### Minor Observations

- The `waitForReady()` mechanism (waiting for `❯` prompt) is fragile — Claude's prompt character could change across versions or with different shell configurations. Consider an explicit "ready" signal injected by the session initialization script instead.

- "Inject into warm session" via tmux `send-keys` is a clever solution, but the spec doesn't address what happens if the message contains special characters that tmux interprets (e.g., `%`, `{}`). A sanitization step should be noted.

- The 10-message overflow limit is a magic number without justification. Is this based on testing, memory constraints, or latency budgets? Document the reasoning so future changes are made with the same rationale.

- The `lookupAgentName()` call in the routing code snippet will fail silently if the fingerprint is unknown. The fallback `msg.from.slice(0, 8)` should be documented as the intended behavior, not just present in a code snippet.

---

## Scalability Assessment

**Current scope (Phase 1-3):** The design is appropriate for single-agent, single-machine deployment with moderate message volumes (dozens per day). The serial injection queue and single listener session are the right starting point.

**Scaling pressure points to watch:**

1. **Single listener bottleneck.** The serial injection queue means one slow response blocks all subsequent messages. For high-volume agents (hundreds of messages/day), this becomes a latency multiplier. The spec acknowledges this but doesn't define the threshold where the listener model breaks down.

2. **ThreadResumeMap at scale.** With a 7-day TTL and N active threads, the resume map grows linearly. No mention of size limits, eviction beyond TTL, or storage backend. Fine for now; worth noting for agents with many active peer relationships.

3. **Cold-spawn fallback as escape valve.** The architecture correctly falls back to cold-spawn when the listener is unavailable. This means the system degrades gracefully under load rather than failing completely. Good.

4. **Multi-machine coordination not addressed.** If an agent runs across machines (via `instar pair`), two listener sessions would both receive relay messages and both respond. The spec doesn't address this. It may be out of scope (the Non-Goals mention "changes to the relay server itself"), but it's worth a note.

**Verdict:** Scales well to the target use case. The design does not over-engineer for a scale that doesn't exist yet, which is correct. The serial queue and single listener are the right choices for v1.

---

## Summary

This is a well-scoped, honest spec that fixes a real failure mode with minimal architectural change. The phased approach is correct. The critical issues are all solvable before implementation without significant redesign — they are documentation and protocol gaps, not structural problems.

The biggest DX risk is the lack of a machine-readable message type contract. If other agent frameworks start integrating with Threadline before the message schema is defined, you get permanent inconsistency. Define the schema first, implement second.

Phase 1 is ready to ship. Resolve CI #1 (message schema) and CI #2 (overflow design) before starting Phase 2.
