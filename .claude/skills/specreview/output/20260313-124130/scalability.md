# Scalability Review: Threadline Responsive Messaging
**Review ID:** 20260313-124130 | **Round:** 1 | **Reviewer:** Scalability & Infrastructure Specialist
**Spec:** threadline-responsive-messaging.md | **Date:** 2026-03-13

---

## Approval Status

**CONDITIONAL APPROVAL** — The spec is well-scoped for its primary goal (fixing the last-mile response problem at single-digit agent scale) and the three-phase implementation plan is sensible. However, several architectural decisions create hard scaling ceilings that will require rework before the network grows beyond ~50 agents. The single shared listener session is the most significant structural concern. These issues are not blockers for MVP but must be acknowledged as design debt.

---

## Research Findings

Before assessing the spec, I researched the underlying primitives it relies on.

### WebSocket Relay Scaling
A single well-tuned Node.js WebSocket server can handle 50,000–240,000 concurrent persistent connections before running into file descriptor and memory limits. Beyond that, horizontal scaling with a message broker (Redis, Kafka) is standard practice. The relay server itself is likely not the bottleneck at any scale Instar will see in the near term — the constraint is not the WebSocket transport, it is what happens on the receiving end of each message.

### Claude Code Session Resource Consumption
Under normal conditions, a Claude Code CLI process consumes 200–400 MB of RAM per session. However, there are documented memory leak patterns in 2026 (GitHub issues #11377, #21182) where sessions run for extended periods and balloon to 10–23 GB. A long-lived "threadline-listener" session running 24/7 is directly in the path of these leak patterns. The spec's 4-hour rotation window partially mitigates this but does not eliminate the risk.

### tmux Session Limits and Memory Overhead
tmux itself imposes no hard per-session limit, but documented field reports show instability when total panes across all sessions exceed ~200. Memory overhead per tmux session is modest (~5–15 MB for the tmux server process slice per pane), but history buffers grow unboundedly unless `history-limit` is tuned. More importantly: `tmux send-keys` is not designed as a message bus. It writes to a terminal buffer with no delivery acknowledgment, no backpressure, and no durability. Injected messages can be silently lost if the terminal is in a state the spec does not account for (e.g., mid-pagination, a tool is running, the pane is in copy mode).

### Agent-to-Agent Messaging Benchmarks
Industry benchmarks for multi-agent orchestration systems target P50 latency under 3 seconds and P95 under 6 seconds for simple messages. The spec's 3–5 second warm-session target is competitive with these figures. However, these benchmarks assume purpose-built messaging infrastructure — not tmux terminal injection feeding a general-purpose LLM session. The serialization bottleneck in LLM session injection is well-documented: JSON array rewrites are O(N) per message, while JSONL appends are O(1). The spec does not specify how messages are queued before injection.

---

## Critical Issues

### 1. Single Listener Session Is a Serial Bottleneck (High Severity)

The spec proposes one shared `threadline-listener` session per agent that receives ALL inbound messages. This session processes messages one at a time, serialized through an AsyncQueue. At 10x growth:

- **10 active network agents** sending 2–3 messages each during a busy period = 20–30 messages queuing behind a single LLM processing at 3–5s each.
- **Queue depth at 10 concurrent senders:** 10 messages × 4s average = 40 seconds of head-of-line blocking for the last message in queue.
- **The overflow policy ("busy-reply" at 10 queued) fires immediately** in any moderately active multi-agent session.

The spec acknowledges this with the overflow policy but frames it as an edge case. At 50+ network agents with any coordinated activity (e.g., a broadcast or a shared task), this becomes the common case.

**What happens at 100x (500 agents):** The agent is effectively unreachable during any period of coordinated network activity. The single listener becomes a single-threaded message processor for a potentially large network.

### 2. tmux send-keys Is Not a Reliable Message Bus (High Severity)

The injection mechanism (`sessionManager.rawInject` → `tmux send-keys`) has no delivery guarantee. Messages are written into a terminal buffer:

- If Claude is mid-tool-execution when `send-keys` fires, the injected text goes into the buffer and may be interpreted as part of tool output, as stdin to a running process, or silently discarded.
- The `waitForReady()` check (waiting for the `❯` prompt) is a heuristic. There is no acknowledgment that the text was processed as a user message, not echoed text.
- **No durability:** If the listener session crashes between `rawInject` and Claude reading the message, the message is gone. The fallback to cold-spawn does not cover this window.
- At scale, `send-keys` timing races become frequent. The spec does not define what "ready" means unambiguously.

### 3. Context Window Rotation Creates a 10–30 Second Availability Gap (Medium Severity)

The graceful rotation sequence (spawn replacement → wait for ready → atomic swap) takes 10–30 seconds during which:

- Messages arriving during rotation land in fallback cold-spawn
- Cold-spawn adds 15–30s on top of the rotation delay
- If rotation is triggered by context fill (which accumulates silently), the timing is unpredictable and not user-controlled

The spec states rotation happens at "~50 messages or ~4 hours." At 10x growth with higher message volume, 50 messages may arrive in under an hour, making rotation a frequent event rather than a rare one.

### 4. No Cost Scaling Model (Medium Severity)

The spec states the listener session has a "continuous (low) token cost for idle session." This deserves quantification:

- A listener session that stays warm consumes idle tokens from Claude's context window — but more importantly, each injected message triggers a full LLM inference call.
- **At 50 agents:** If each agent has a listener, and agents exchange messages freely, you get O(N²) token consumption as agents message each other. 50 agents × 10 messages/day/agent = 500 inference calls/day across the network just for threadline messages.
- **Cold-spawn fallback** still uses a full session spawn (15–30s + session startup tokens). The spec does not model whether warm-session savings offset the continuous idle cost for low-traffic agents.
- No mention of token budget caps, rate limiting per sender, or cost visibility.

---

## Recommendations

### R1: Move Toward Multi-Worker Listener Architecture (Pre-Scale Design Debt)

Document now (even if not building yet) that beyond ~20 network agents, the single listener must become a pool. The simple version: a configurable `listenerPoolSize` (default 1, max 3) with a round-robin or least-loaded dispatch. This does not require parallel LLM inference — it means separate tmux sessions handling separate message streams, reducing head-of-line blocking.

### R2: Replace tmux send-keys Injection with a Durable Inbox File

The OpenCode project (researched above) solved exactly this problem: instead of injecting via `send-keys`, messages are appended to a per-agent JSONL inbox file. The Claude session polls or watches this file. Writes are O(1) (append-only). Delivery is durable (file survives session crash). The session reads the inbox at the next prompt cycle, eliminating timing races. This is a more robust injection primitive than terminal send-keys.

If changing injection is out of scope for this spec, at minimum add a delivery confirmation step: after `rawInject`, wait for the listener to echo back a structured acknowledgment (e.g., `[ack:messageId]`) before marking injection as successful.

### R3: Add Explicit Cost Accounting to the Design

Before Phase 2 ships, define:
- Token budget per listener session per rotation cycle
- Maximum messages per day receivable before cost-based throttling kicks in
- Whether idle listener sessions should be parked during off-hours (the spec mentions this as an option but leaves it unresolved)

The "continuous low token cost" claim needs a number attached to it, even a rough one.

### R4: Define "Ready" Signal Formally

The `waitForReady()` implementation that checks for the `❯` prompt needs to be hardened:
- What prompt strings are considered "ready"? (Different shells, different Claude Code versions may vary)
- What is the timeout? What happens on timeout?
- How does it distinguish "at prompt after completing work" from "at prompt mid-initialization"?
- Consider injecting a sentinel ping (`echo __THREADLINE_READY__`) and waiting for its echo as a more reliable ready signal.

### R5: Specify Overflow Queue Behavior More Precisely

The spec says "10 messages queue → oldest get busy-reply." This needs clarification:
- Is the queue bounded at 10 total, or 10 per sender?
- When a busy-reply is sent, is the original message logged for manual review? Or silently dropped?
- At 100x scale, should the overflow limit scale with network size, or is 10 a fixed cap?

---

## Observations

**The phased implementation plan is well-structured.** Phase 1 (wire ThreadlineRouter + auto-ack + health endpoint) has essentially no scaling risk — it is pure correctness work. Shipping Phase 1 independently is the right call.

**The auto-ack design is correct.** Making the ack a real threadline message (not a protocol frame) so it propagates to the sender's user is a good decision. The ack loop prevention (never ack an ack) is necessary and correctly called out.

**Default relay enablement (Component 5) is high leverage.** The finding that none of 5 agents responded because relay was off by default explains the original problem. `unlisted` as the default visibility is the right balance — reachable without being crawlable.

**The 7-layer InboundMessageGate is not reviewed here** — but the spec correctly treats it as a fixed dependency. Any security review should cover whether the gate adds significant latency at message volume (if each gate layer is synchronous, 7 layers at even 10ms each = 70ms before ack).

**Thread continuity via ThreadResumeMap (7-day TTL) is reasonable for MVP.** At scale, the TTL may need to be configurable per trust level — you might want longer continuity with verified agents and shorter with untrusted ones.

**The health job (every 5 minutes) is appropriately lightweight.** The health endpoint schema is well-defined and includes `contextUsage` — this is exactly the right signal for anticipating rotation before it happens.

---

## Scalability Assessment by Phase

| Phase | Agent Count | Primary Risk | Assessment |
|-------|------------|--------------|------------|
| MVP | 10–50 agents | tmux injection reliability | Acceptable — low message volume masks the bottleneck |
| Growth | 50–500 agents | Single listener serialization + cost growth | Will require listener pool before this phase completes |
| Scale | 500–5000 agents | O(N²) message cost, rotation frequency, memory leaks | Needs architectural rework (durable inbox, worker pool, cost caps) |
| Viral | 5000+ agents | Full architectural redesign needed | Not addressed in spec — correct for current scope |

**The spec is scoped correctly for MVP.** It does not claim to solve Growth/Scale, and it should not. The risk is that the architecture decisions made in MVP (single listener, send-keys injection) become entrenched and costly to replace later.

---

## Score

**6.5 / 10**

The spec diagnoses the actual problem correctly, proposes a sensible fix, and is well-organized with clear component boundaries. The implementation order is sound. Points deducted for:
- Single listener architecture creates a hard ceiling that will require rework at Growth scale (-1.5)
- tmux send-keys as a message bus has no delivery guarantee, which is a correctness issue at any scale (-1.0)
- No cost model — the "low continuous token cost" claim is unquantified (-0.5)
- Open questions 1, 2, and 3 are left genuinely open when they have clear answers that should be in the spec (-0.5)

At MVP scale, this will work and is worth building. The Phase 1 work in particular (wire ThreadlineRouter, add auto-ack) is pure correctness with no downside — it should ship immediately.
