# Scalability Review — Presence Proxy (Intelligent Response Standby)

**Review ID**: 20260327-124457 | **Round**: 1 | **Date**: 2026-03-27
**Reviewer**: Scalability & Infrastructure
**Score**: 7.5/10
**Approval Status**: CONDITIONAL APPROVE

---

## Research Findings

**tmux capture-pane at scale**: tmux runs as a single-threaded server; all `capture-pane` calls serialize behind one Unix socket lock. At 50 concurrent agents each firing Tier 1 in a 20s window, that's ~250ms of serialized blocking — tolerable, but it worsens linearly.

**LLM cost (March 2026 pricing)**: Haiku 4.5 at $1/M input / $5/M output; Sonnet 4.6 at $3/M input / $15/M output. The spec uses `claude -p` (CLI mode), bypassing API billing entirely — cost is subscription budget, not dollar cost. Prompt caching (80-90% savings) is available on the API path but not the CLI path.

**Claude Code CLI rate limits — critical finding**: As of March 23, 2026, Claude Max plan 5-hour windows are being exhausted "abnormally fast" with CLI usage (GitHub issue #38335). Multiple concurrent CLI sessions can exhaust weekly limits. The spec's `ClaudeCliIntelligenceProvider` spawning `claude -p` per tier fire is directly exposed to this.

**Node.js timer memory**: Documented memory leaks when async local storage is involved with high timer counts. Each PresenceState holds 3-4 timers. At 500 topics, this is ~2000 concurrent timer objects accumulating references.

---

## Critical Issues

### 1. CLI Subprocess Model is a Hard Rate-Limit Ceiling (CRITICAL)
**Breaks at**: ~15-20 concurrent active topics with delayed agents

Each `claude -p` invocation draws from the Claude Max plan session budget. No concurrency cap or queue is specified — if 50 topics hit Tier 1 simultaneously, 50 subprocesses spawn concurrently. The spec's fallback ("proxy simply doesn't fire") handles "CLI not installed" but not "CLI rate-limited," which fails after a delay with an error, not immediately.

**Recommendation**: Concurrency cap of 3-5 concurrent CLI invocations with a queue. Drop Tier 1 calls under queue overflow (informational only); always drain queue for Tier 3. Handle rate-limit error codes explicitly.

### 2. No Persistence for Timer State (SIGNIFICANT)
**Breaks at**: Any server restart under load

Tier snapshots (tier1Snapshot, tier2Snapshot) are in-memory only. After restart, the recovery path re-initializes timers but has no snapshot data. Tier 2's delta comparison becomes impossible — the spec doesn't specify whether it skips the comparison or skips the tier entirely. At Scale, server restarts under load are probabilistic certainties.

**Recommendation**: Store tier snapshots as temp files (`/tmp/instar-presence-{topicId}-t1.txt`). Persist non-snapshot PresenceState fields to disk on every state change. Recovery becomes deterministic.

### 3. Thundering Herd on Shared Sessions (SIGNIFICANT)
**Breaks at**: Multiple topics mapped to the same session

If Topics A and B both map to the same session, both independently call `captureOutput()` and may both fire Tier 3 interventions. If Topic A triggers "unstick" (Ctrl+C) while Topic B's assessment is running, Topic B's snapshot now shows disrupted output and may misclassify the session state.

**Recommendation**: Session-level intervention lock. Before any Ctrl+C, restart, or triage action, acquire a per-session lock. If a lock is already held, queue or skip the intervention.

---

## Additional Recommendations

**R1 — Jitter on timer fires**: Add ±5-second randomized jitter to all tier timers. Prevents synchronized tmux capture waves when many agents receive messages simultaneously (e.g., a broadcast message to multiple topics).

**R2 — Subscription budget tracking**: The "zero cost" framing is accurate for API billing but obscures the real cost: session budget consumption. Add a lightweight counter for presence proxy LLM invocations per hour. Essential for tuning tier delays at Growth phase.

**R3 — In-flight LLM call cancellation on timer reset**: The rapid-message edge case specifies timer reset on new message, but doesn't address in-flight `claude -p` processes from the previous timer. An in-flight Tier 1 LLM call should be killed when the timer resets.

**R4 — `quiet` cancellation command**: `quiet` silences for 30 minutes but there's no way to check current silence status or cancel it early. At Scale with multiple users per topic, this creates confusion.

**R5 — `captureOutput()` transient error handling**: The spec covers "session is dead" but not "capture failed transiently" (permission error, tmux server overloaded). Define behavior for transient capture failures — probably retry once, then degrade gracefully.

---

## Observations (Positive)

- **Tier 1-2 observation-only** is the correct bias. Never suggesting intervention in the first two tiers is excellent defensive design.
- **Process tree as authoritative signal** overriding LLM assessment is correct — OS-level signals beat behavioral text classification.
- **Third-person proxy persona** avoids the proxy making commitments the agent hasn't made. Right call.
- **Event-driven cancellation** via `message:logged` is clean — no polling, no race window beyond one timer cycle.
- **Long-running process whitelist** is a practical safeguard. Suggest making it user-configurable in config.json.

---

## Scalability Assessment

| Phase | Agents | Status | First Failure |
|-------|--------|--------|---------------|
| **MVP** | 10-50 | Passes cleanly | No structural issues |
| **Growth** | 50-500 | Functional with friction | CLI rate limits visible ~100-150 agents; clustered tmux captures without jitter |
| **Scale** | 500-5000 | Requires architectural changes | CLI model needs replacement with API+caching; tmux serialization adds latency; missing persistence causes reliability gaps |
| **Viral** | 5000+ | Would not survive | Single-server model is the binding constraint before the proxy; needs stateless design with external state store |
