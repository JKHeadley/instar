# Cross-Review: gemini

- **Model**: gemini-3.1-pro-preview
- **Date**: 2026-04-28
- **Document**: unanswered-message-reaper.md
- **Focus**: full document

## Raw Model Response

### 1. Overall Assessment
- **Score**: 9/10
- **Status**: CONDITIONAL (Requires resolution of open questions and one scalability math adjustment)
- **Summary**: Exceptionally well-thought-out and rigorous specification. Correctly identifies a gap in the existing event-driven architecture and proposes a robust, state-machine-aware polling mechanism. The author has proactively anticipated race conditions, multi-server split-brain scenarios, adversarial prompt injection, and filesystem hygiene. Nearly ready for implementation pending a definitive call on Open Questions and a polling-throughput adjustment.

### 2. Critical Issues (Must Fix)

**Issue 1: Polling Math breaks at Scale (O(N) latency)**
- maxTopicsPerSweep=50 every 60s → 500 topics = 10 min full cycle; 5,000 topics = 100 min. Defeats the 3-minute unansweredAfterMs SLA.
- Fix: decouple cheap fs.stat candidate evaluation from deep-inspection budget. Stat all topics every tick; cap deep-inspect/inject at 50. Or maintain in-memory lastMessageTime index updated by recordIncoming.

**Issue 2: Unresolved Open Questions**
- Cannot ship with open architectural decisions.
- Fix: adopt author's recommendations — Option A for performative-reply; Option B for escalation.

**Issue 3: Mode B Classification vs. Network I/O Wait**
- Mode B assumes JSONL-idle-30s + no-active-children = "waiting at prompt". But an agent waiting on a slow LLM/tool API (60-120s) has no active children yet is mid-thought. Reaper would inject and corrupt state.
- Fix: differentiate "waiting for user input" from "awaiting async network I/O" structurally; or raise modeBJsonlIdleMs to 90-120s.

### 3. Strengths
- Multi-Node Safety without Distributed Locks via isOwnedByThisServer
- TOPIC_HISTORY fences, ANSI/control/bracketed-paste stripping
- Race Handling: confirm-after-delay + fingerprint re-check
- Graceful Degradation: 2s recordIncoming timeout, hydration ceiling

### 4. Gaps and Missing Elements
- Async File Concurrency on Dedupe: atomic tmpfile-rename mentioned, but no mutex around debounced 5s flush.
- Clock Skew Across Machines: if recordIncoming stamps on Machine A but session is owned by Machine B, NTP drift causes false positives/negatives.
- Mode B Leak Test Completeness: prompt prevents verbatim re-send but doesn't instruct redaction of secrets/PII/internal tool output.

### 5. Industry Comparison
- Classic Watchdog/Supervisor pattern (Erlang/OTP), adapted for non-deterministic LLMs.
- Anti-patterns avoided: distributed-lock, poison-pill.

### 6. Scalability Assessment
- Phase 1 (10-50 users): works perfectly.
- Phase 2 (50-500): polling loop starts taking multiple minutes per cycle.
- Phase 3 (500-5000): BREAKS — 100 min full cycle vs. 3 min SLA.

### 7. Recommendations (Prioritized)
1. Fix Polling Scalability: separate cheap fs.stat from deep-inspect budget.
2. Close Open Questions.
3. Raise modeBJsonlIdleMs to 90s+ to cover legitimate API I/O waits.
4. Add async mutex around dedupe-file flush.
5. Refine Mode B prompt: explicit redaction instruction.

## Subagent Analysis

Gemini: 9/10 CONDITIONAL. Three critical issues: polling math doesn't scale (5k topics = 100 min cycle), Mode B vs network I/O wait (modeBJsonlIdleMs=30s too tight for slow LLM/tool calls), and unresolved open questions. New gaps: async mutex on dedupe flush, cross-machine clock skew when inbound bridge differs from owning server, Mode B prompt should instruct redaction.
