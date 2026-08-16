# Gemini 3.1 Pro Review: PROMISE-BEACON-SPEC.md

**Model**: gemini-3.1-pro-preview
**Date**: 2026-04-18
**Focus**: full document

---

## Raw Model Response

Here is a comprehensive, structured review of the **Promise Beacon** specification.

### 1. Overall Assessment
- **Score**: 9/10
- **Status**: CONDITIONAL (Approve upon addressing minor edge cases)
- **Summary**: This is an exceptionally mature, rigorous, and well-reasoned specification. The author has clearly learned from previous iterations (evidenced by the extensive "Round 2 clarifications") and has systematically closed loops around race conditions, security vectors, and state synchronization. The reuse of existing primitives (`CommitmentTracker`, `CommitmentSentinel`) rather than building duplicate infrastructure shows excellent architectural restraint. The conditions for approval revolve around handling volatile terminal output, graceful recovery from server restarts, and bounding LLM context windows.

---

### 2. Critical Issues (Must Fix)

**1. Hash Defeat via Volatile Output (Timestamps/Progress Bars)**
- **What**: The snapshot-hash gate (P1/P14) strips ANSI and spinners to maximize cache hits and save LLM calls. However, many CLI tools output dynamic text (e.g., `[14:02:01] Compiling...`, `ETA: 12s`, or byte counters).
- **Why it matters**: If a long-running process outputs timestamps, the SHA-256 hash will *always* change. The Tier-1 Haiku bypass will be defeated, maxing out the `maxDailyLlmSpendCents` budget very quickly and causing the beacon to fail-open to silence.
- **Suggested fix**: Implement a fast, non-LLM diffing heuristic before the hash check (e.g., Levenshtein distance or checking if the only changes are numbers/timestamps) OR enforce a strict rate-limit on *LLM-evaluated* heartbeats (e.g., "Even if hash changes, do not call LLM more than once per 30 minutes; use templated response for intermediate ticks").
- **Section reference**: `Snapshot-hash gate (P1 fix)` and `Snapshot hash normalization (P14)`.

**2. Unbounded Tmux Capture Size**
- **What**: The spec calls for capturing tmux tail via `captureSessionOutput` and passing it to the LLM for Tier 1-3 assessments.
- **Why it matters**: If a command dumps a massive amount of text (e.g., a verbose stack trace or minified file output), passing this to Haiku/Sonnet could exceed context windows, cause massive token spend, or trigger 413 Payload Too Large errors at the LLM API layer.
- **Suggested fix**: Explicitly define a byte/line truncation limit for `captureSessionOutput` (e.g., "capture last 200 lines, max 8KB") before hashing and LLM ingestion.
- **Section reference**: `Tier selection` (Step 9) and `Prompt-injection hardening` (Step 10).

**3. Brittle Session-Restart UX ("Violated" Cliff)**
- **What**: If the server restarts or a session identity changes (A6/A7), the commitment immediately transitions to `violated` and emits a warning to the user.
- **Why it matters**: Server deployments, transient crashes, or routine compactions shouldn't result in a scary "violated/dead" message to the user if the agent is capable of resuming work upon boot. This creates a brittle UX.
- **Suggested fix**: Introduce a `paused` or `interrupted` state, or implement a "grace period" (e.g., 15 minutes) on boot where the agent is prompted to re-adopt orphaned commitments before the beacon marks them as `violated`.
- **Section reference**: `Session-epoch check (A6 fix)` and `Session-alive check (A7 fix)`.

---

### 3. Strengths

- **Hot/Cold Storage Split (P4, I2, P15)**: Keeping immutable/cold data in git-synced JSON and volatile/hot data in machine-local files is a brilliant architectural decision. It prevents massive git merge conflicts and cross-machine state corruption.
- **Strict Metadata Skipping (A1, S13, A21)**: Relying on server-stamped metadata rather than text prefixes to prevent infinite heartbeat loops is highly secure and robust against user/agent spoofing.
- **Security Posture**: The spec treats the agent's output as fundamentally untrusted. The combination of regex sanitization, explicit LLM `<untrusted_>` delimiters, and post-generation PII redaction (S2, S3, S4, S18) is an industry-best-practice approach to prompt injection.
- **Single-Writer Queue Extraction (P3, I14)**: Recognizing that concurrent file writes will corrupt the JSON ledger and demanding a single-writer FIFO queue as a prerequisite PR shows deep understanding of Node.js concurrency limits.

---

### 4. Gaps & Missing Elements

- **User Cancellation Path**: The spec defines how an agent delivers (`/deliver`) and how timeouts work (`hardDeadlineAt`), but does not define how a *user* explicitly cancels an open commitment (e.g., the user types "Actually, never mind, stop working on this"). How does the beacon intercept this and transition the state to `withdrawn`?
- **Timer Exception Handling**: Node.js `setTimeout` handlers that throw unhandled exceptions can crash the process or silently strand the commitment. The spec needs an explicit `try/catch` wrapper contract around the timer-fire handler that logs the error and safely re-arms the timer.
- **Agent Self-Awareness**: The spec notes that proxy messages are stripped from the agent's context (A25). However, if an agent has a `hardDeadlineAt`, how does it know its own deadline? There is no mention of injecting active commitment metadata into the agent's system prompt or making it queryable via a tool.

---

### 5. Industry Comparison

- **Long-Running Operations (LROs)**: In standard distributed systems, LROs rely on webhooks or explicit polling. Because LLM agents are non-deterministic, this spec effectively implements an **"Observer Pattern via LLM Oracle."** This is highly innovative and aligns well with the cutting edge of agentic UX.
- **Actor Model Parallels**: The design essentially treats each commitment as an Actor (with its own state, timer, and mailbox). Implementing this via Node timers and JSON files is acceptable for MVP, but standard industry practice for this pattern relies on robust message brokers (e.g., Temporal, RabbitMQ).
- **Grace Degradation**: The `LlmQueue` priority lanes (I17) and the fail-open to templated messages are excellent implementations of the "Circuit Breaker" and "Bulkhead" patterns, standard in high-resiliency microservices.

---

### 6. Scalability Assessment

- **Phase 1 (MVP, 10-50 users)**: **Works perfectly.** Node.js can easily handle hundreds of concurrent `setTimeout` calls, and the JSON file single-writer queue will keep up with the low throughput.
- **Phase 2 (Growth, 50-500 users)**: **Bottlenecks emerge.** The `CommitmentTracker.mutate()` queue depth of 256 will overflow during "boot storms" (when the server restarts and jittered timers all fire at once). The file I/O for updating hot-state JSON files every 10 minutes per commitment will cause noticeable disk thrashing.
- **Phase 3 (Scale, 500-5000 users)**: **Architecture breaks.** In-memory `ProxyCoordinator` mutexes and Node timers are incompatible with horizontal scaling. The system will require:
    1. Migration from JSON files to a relational database (PostgreSQL/SQLite).
    2. Migration from `setTimeout` to a distributed job queue (e.g., Redis/BullMQ or Temporal).
    3. Distributed locking (Redis Redlock) to replace `ProxyCoordinator`.
- **Spike handling**: The `LlmQueue` (I17) handles LLM API spikes perfectly. However, HTTP spike handling relies on returning `503` from the `mutate()` queue. The client/agent must have retry logic implemented.

---

### 7. Recommendations (Prioritized)

1. **Implement Output Truncation for Tmux Captures**: Explicitly limit `captureSessionOutput` to the last ~8KB of data before passing it to the hashing function or LLM to prevent context bloat and token exhaustion.
2. **Add a Volatile Text Filter to the Hash Gate**: Strip standard timestamp formats (e.g., `[HH:MM:SS]`, `YYYY-MM-DD`) and percentage counters (`\d+%`) prior to hashing the tmux output to prevent continuous cache misses on benign output.
3. **Define the User Cancellation UX**: Add a mechanism (either a UI button on the dashboard or an intent-parser in the message router) allowing users to manually transition a `pending` commitment to `withdrawn`.
4. **Implement a Boot-Time Grace Period**: Instead of instantly violating commitments on session epoch mismatch (A6), place them in an `orphaned` state for 15 minutes to allow agent re-attachment/recovery scripts to run post-deployment.
5. **Resolve Open Question #3 (Sentinel Auto-enable)**: Require manual user opt-in for auto-enabling the beacon. Automatically spending LLM budget to send unsolicited heartbeat messages based on an LLM's interpretation of Telegram messages is highly risky. Keep the 7-day shadow mode, but make the final flip manual.

---

## Subagent Analysis

Gemini returned CONDITIONAL / 9.0. Three critical issues are genuinely novel vs. the 35+ Round 2 findings already in the spec:

1. Hash-defeat via volatile output (timestamps, progress percentages, byte counters) — the normalization pass in P14 only strips ANSI + spinners; it does not address dynamic text content. This directly undercuts the 70% templated-heartbeat cost assumption.
2. Unbounded tmux capture size — no explicit byte/line cap defined before hashing or LLM ingestion.
3. Session-restart UX "violated cliff" — instant `violated` transition on epoch mismatch is harsh for routine server redeploys; a `paused`/grace-period state could soften this.

Gaps worth tracking: user-initiated cancellation path, timer exception/unhandled-rejection contract, and agent self-awareness of its own active commitments / deadlines (A25 strips proxy messages from context, but agent has no tool to query its open promises).

Scalability analysis is standard (JSON+setTimeout fine at MVP, breaks at 500+ agents needing DB + distributed queue) — not urgent for Phase 1.

Recommendation 5 (manual-only Sentinel auto-enable) aligns with residual open question #3 and points toward resolving it manual-only.
