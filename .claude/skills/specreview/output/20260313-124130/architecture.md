# Architecture Review: Threadline Responsive Messaging
**Review ID:** 20260313-124130
**Round:** 1
**Reviewer:** Echo (Systems Architect role)
**Date:** 2026-03-13
**Spec:** `specs/threadline-responsive-messaging.md`

---

## Approval Status

**CONDITIONAL APPROVAL** — The spec is directionally sound and the implementation order is correct. The warm session injection model is the right architecture for this problem. Four issues need resolution before Phase 2 implementation begins; Phase 1 can proceed as-is.

---

## Score: 7.5 / 10

Strong problem diagnosis, clear phasing, good fallback thinking. Score held back by the tmux injection concurrency model (which has a known failure mode at the "waitForReady" step), incomplete context window cost accounting, and a missing durable queue between the relay and the listener session.

---

## Research Findings

### Warm Session Architectures for LLM Agents

The cold-start problem the spec addresses is well-studied in adjacent domains. AWS Lambda provisioned concurrency demonstrates that pre-initialized execution environments deliver "double-digit milliseconds" response times compared to 100ms-1s+ for cold starts. The key insight: initialization cost (loading identity, session hooks, model context) cannot be eliminated at request time — it must be paid upfront during provisioning. The spec correctly identifies this and proposes paying it at server startup instead of at message arrival.

The analogy holds well for the listener session design. The listener is effectively "provisioned concurrency for Claude Code" — one pre-initialized execution environment that absorbs steady-state message load, with cold-spawn as the fallback for overflow or failure.

### tmux send-keys at Scale

tmux `send-keys` is designed for interactive scripting, not high-throughput message injection. Its buffer management (50 automatic buffers by default) is not the binding constraint here — the constraint is the terminal I/O model itself: `send-keys` writes keystrokes into the pty, and the receiving process (Claude Code) reads them at human-equivalent rates. There is no acknowledgment mechanism, no error propagation, and no delivery guarantee. The "waitForReady" pattern the spec proposes (wait for `❯` prompt) is the standard approach but is fragile — it can false-positive on `❯` appearing in Claude's output, and it can deadlock if Claude never returns to prompt due to an error or tool call hang.

This is the highest-risk technical element in the spec. The injection serialization queue mitigates inter-message interference but does not address the prompt-detection fragility.

### Message Injection Patterns

The spec's injection format `[threadline:FINGERPRINT trust:LEVEL thread:THREAD_ID]` follows a well-established pattern for tagged message injection into text-based interfaces. The critical design constraint for this pattern: the injected text must be unambiguous to parse even when Claude's output contains similar-looking strings. The chosen format is reasonably distinctive but could be tightened (see Recommendations).

### Long-Running LLM Session Management

Context window rotation in long-running sessions is a genuinely hard problem. The spec's graceful rotation approach (spawn replacement, atomic swap, drain old) is the right pattern — it mirrors blue-green deployment semantics. The key gap: the spec does not address what happens to in-flight messages during the swap window. If a message arrives after the old session begins draining but before the new session confirms ready, it can be silently dropped or double-processed.

The GenStage back-pressure model is instructive here: the right design is demand-driven, where the listener signals capacity rather than the router assuming availability. The spec's overflow queue is a step in this direction but stops short of true back-pressure.

---

## Critical Issues

### 1. Prompt-Detection Fragility in waitForReady (High Risk)

The `ListenerSessionManager.inject()` method waits for the Claude session to return to prompt by detecting the `❯` character. This is the same pattern already used for Telegram injection, and it has known failure modes:

- Claude outputs `❯` in its response text (shell command examples, code blocks, prompt characters in markdown)
- Claude hangs in a tool call that doesn't return (MCP server timeout, filesystem hang)
- Claude's prompt character changes based on terminal configuration

The spec does not specify a timeout for `waitForReady`. Without a timeout, a hung Claude session will block the entire injection queue indefinitely, causing all subsequent messages to accumulate until the overflow limit and then trigger busy-replies — which is the worst possible outcome for a persistent listener.

**Required fix:** Specify a `waitForReady` timeout (suggest 30s) after which the inject attempt fails, the listener is marked unhealthy, and fallback to cold-spawn is triggered. The unhealthy listener should be respawned, not left in a stuck state.

### 2. Missing Durable Queue Between Relay and Listener

The injection queue is in-memory (`AsyncQueue` in `ListenerSessionManager`). If the instar server crashes or restarts while messages are queued, they are lost. The relay already delivered them (WebSocket push is fire-and-forget from the relay's perspective), so there is no replay mechanism.

The current cold-spawn path has the same problem — but it's less visible because cold-spawn is faster and the window of vulnerability is smaller. The warm listener, by design, processes messages more slowly per-message (due to serialization), so the vulnerability window is larger.

**Required fix for Phase 3:** Add a small durable queue (append-only file or SQLite table in `.instar/state/`) between `gate-passed` events and the injection queue. Messages should be written to durable storage before being enqueued in memory, and removed from durable storage only after injection confirms delivery. On startup, any messages in durable storage that weren't processed should be replayed. This is a Phase 3 concern given the existing cold-spawn fallback, but it should be in the spec.

### 3. Listener Session Token Cost Not Quantified

The spec acknowledges "continuous (low) token cost for idle session" in the tradeoffs table but does not quantify it. An idle Claude Code session with session-start hooks still consumes API tokens as the model processes the initial context load. If the listener rotates every 4 hours with a 50-message cap, and messages average N tokens, the baseline cost should be estimated. This matters for agents with tight token budgets — if the listener is burning quota on idle keep-alive, it competes with the user's primary interactive session.

The spec should either quantify the idle cost or specify that the listener uses a minimal model variant when idle.

**Required fix:** Add a cost estimate to the tradeoffs section. Even a rough order-of-magnitude figure ("approximately 2-5K tokens per rotation, regardless of message volume") would allow operators to make an informed decision about enabling the listener.

### 4. ThreadlineRouter Handles Only Messages With threadId

Reading the actual `ThreadlineRouter.handleInboundMessage()` implementation:

```typescript
if (!message.threadId) {
  return { handled: false };
}
```

The router silently ignores messages that lack a `threadId`. The current server.ts handler does not have this constraint — it handles any relay message. If the spec wires ThreadlineRouter as the "sole handler for relay messages" (Component 2), messages without threadIds will be dropped silently with no fallback.

This is a behavioral regression. The spec must either: (a) ensure all relay messages have threadIds (enforced at the relay or in the InboundMessageGate), (b) add a fallback handler in ThreadlineRouter for threadId-less messages, or (c) retain the current handler as a fallback for non-threaded messages.

**Required fix:** Specify how threadId-less messages are handled post-migration. Do not silently drop them.

---

## Recommendations

### R1: Harden the Prompt Detection with Content Scanning

Instead of solely pattern-matching for `❯`, add secondary signals: detect that Claude's last output ended with a newline + prompt, AND that no tool call is in progress (check tmux session activity state). A two-signal confirmation reduces false-positives significantly. The 30s timeout (Critical Issue #1) is the safety net; the dual-signal detection reduces the frequency of hitting that timeout.

### R2: Define a Message Envelope Standard

The injection format `[threadline:FINGERPRINT trust:LEVEL thread:THREAD_ID]` is documented in the spec but should be formalized as a typed constant in the codebase. The listener bootstrap prompt references this format, the injection builder produces it, and any future parsing code depends on it being stable. A single source of truth prevents format drift between the injector and the consumer.

Suggested: add a `ListenerMessageFormat` constant/class to `ThreadlineRouter.ts` or a new `ListenerProtocol.ts` with encode/decode functions.

### R3: Reconsider the Overflow "busy-reply" Policy for Queued Messages

The spec proposes dropping messages after 10 queue depth and sending a "busy" reply. This is reasonable for truly bursty traffic, but the threshold of 10 is arbitrary and the drop behavior is lossy. Consider an alternative: instead of dropping, fast-path to cold-spawn for overflow messages. This produces slightly worse latency (15-30s) instead of a busy error, which is strictly better UX. The session slot budget allows for this — 3 remaining slots can absorb burst.

The busy-reply approach should be reserved for the case where cold-spawn is also unavailable (all slots occupied).

### R4: Open Question #1 Needs an Answer Before Implementation

The spec leaves open whether "all message types" go through the listener session. This has a concrete implementation consequence: if code-review or complex-task messages go through the listener session and Claude decides to spawn sub-sessions from within it, you now have recursive session spawning from a session that is supposed to stay alive. This could consume multiple session slots and leave the listener occupied.

Recommended default: the listener handles conversational messages only. Complex task requests should be acknowledged by the listener ("Got it, spawning a dedicated session for this") and handed off to cold-spawn. The boundary heuristic: if the expected response requires tool use beyond `threadline_send`, cold-spawn.

### R5: Health Endpoint Should Include Injection Queue Depth

The proposed `/threadline/health` response is good but missing queue depth:

```json
{
  "listener": {
    "injectionQueueDepth": 0,
    "injectionQueueMax": 10
  }
}
```

Queue depth is the first signal that the listener is under load. Without it, the health check can show "active: true" while the queue is at 9/10 capacity and about to start dropping messages.

### R6: Default Visibility Change Deserves a Security Review Note

Changing `relayEnabled` from `false` to `true` by default is a significant security posture change. The spec notes "unlisted" as the default visibility, which is reasonable, but the security implication is: every new agent is now reachable from any other agent that knows its fingerprint, by default, without any explicit operator decision.

The spec should note that this change was reviewed against the InboundMessageGate's 7-layer security model, and confirm that the gate is sufficient protection at `relayEnabled: true` without additional operator action. Specifically: is the gate active for new agents before any trust relationships are established? What happens on first message from an unknown fingerprint? The current code shows `trustLevel: 'verified'` being assigned to relay-authenticated unknown senders (ThreadlineBootstrap.ts:212) — this seems overly permissive for agents that have never been explicitly trusted.

---

## Observations

**The three-phase implementation order is correct.** Phase 1 (wire the existing ThreadlineRouter) delivers the most value with the least risk. It is a pure refactor — replacing ad-hoc code with the existing, tested router. Phase 2 (listener session) is the performance optimization. Phase 3 (health monitoring, default enablement) is operational hardening. This sequence means each phase is independently shippable and testable.

**The auto-ack design is elegant.** Using a real threadline message (rather than a protocol-level frame) for acknowledgment means the sender's agent handles it naturally through its existing message pipeline. The `inReplyTo` field provides correlation without requiring a separate ack protocol. The loop prevention (never ack an ack) is correctly specified.

**The ThreadlineRouter wiring is well-understood.** The comparison table in Component 2 clearly articulates what the current handler lacks vs. what ThreadlineRouter provides. The migration path (remove 5 specific things from server.ts) is concrete and reviewable.

**The graceful rotation design is sound.** Spawn-replacement, atomic swap, drain-old is the correct pattern. It mirrors blue-green deployment semantics and ensures no message is lost to session termination (subject to the durable queue gap identified in Critical Issue #2).

**The session slot budget analysis is honest.** Acknowledging that the listener permanently consumes 1 of 5 slots, with a concrete breakdown of how the remaining slots are used, is exactly the right level of analysis for a spec. The parking suggestion (deactivate after 30min idle) is a good escape valve but correctly deferred as optional.

---

## Scalability Assessment

The design is appropriate for the expected load profile: a handful of agent-to-agent messages per hour, occasional bursts. The single-listener model with 10-message overflow queue handles this comfortably.

The design would break down at:
- **>10 concurrent messages:** The serial injection queue plus 10-item overflow limit means burst capacity is capped at ~10 messages before busy-replies start. For agent-to-agent traffic at scale, a pool of listener sessions (2-3) with round-robin injection would be needed. This is a Phase 4 concern, not Phase 1-3.
- **Messages >64KB:** The InboundMessageGate blocks these, which is correct, but the spec doesn't address whether large messages should be delivered via an alternative channel (e.g., shared filesystem reference) or rejected cleanly with an error reply to the sender.
- **High context window consumption:** The 50-message rotation trigger is based on message count, not token count. A single message with a large attachment or long context window history could consume the same tokens as 20 normal messages. Consider a token-budget-based rotation trigger in addition to message count.

For the current use case (instar agent network, low message volume), the architecture is appropriately sized. It does not over-engineer for scale that doesn't exist yet, which is the correct tradeoff.

---

## Summary

The spec correctly diagnoses the problem, identifies the right architectural pattern (warm session injection), and sequences the implementation sensibly. The four critical issues are all solvable without redesign — they are gaps in the spec, not flaws in the architecture.

Phase 1 should proceed without changes. Before Phase 2 implementation, the spec should be updated to address:
1. The `waitForReady` timeout and failure handling
2. Whether threadId-less messages are dropped or handled by fallback
3. A cost estimate for the idle listener
4. The open question on message-type routing (conversational vs. complex tasks)

The durable queue (Critical Issue #2) can be deferred to Phase 3 if the team accepts the message-loss risk during the Phase 2 rollout window.
