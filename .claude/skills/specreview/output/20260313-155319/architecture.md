# Architecture Review: LearningExtractor
**Review ID:** 20260313-155319
**Round:** 1
**Reviewer:** Systems Architect
**Date:** 2026-03-13
**Spec:** `specs/learning-extractor.md`

---

## Approval Status: CONDITIONAL

The architecture is well-conceived and solves a real problem cleanly. The post-send observer pattern is the right choice, the coupling is appropriately loose, and the cost model is honest. Conditional approval on three issues: one data integrity gap, one missing failure mode, and one open question that needs resolution before building.

---

## Critical Issues (must fix before building)

### 1. Buffer drain on `high-signal` is incorrect — it discards non-high-signal buffered messages

**Why it matters:** In `ingest()`, when a high-signal entry arrives, the code calls `this.flush('high-signal')` and returns. But `flush()` drains the *entire* buffer (`this.buffer.splice(0)`), including messages pushed before the high-signal entry. Then the method returns early before `resetFlushTimer()` is called. This means:
- A batch of 8 ordinary messages + 1 high-signal trigger gets analyzed together as a "high-signal" batch — fine.
- But the flush timer is never reset after the return, so if another ordinary message arrives after the flush, the old timer (from a previous cycle) may still be running against a now-empty buffer.

More seriously: the high-signal entry is added to the buffer *before* the high-signal check, so it's included in the flush — but the code structure makes this fragile. A future refactor could easily reorder the push and the check, causing the triggering message to be excluded from its own analysis.

**Suggested fix:** Separate the "flush immediately" path from the "reset timer" path more explicitly. After any flush, always call `resetFlushTimer()` (which should be a no-op on an empty buffer). Name the pattern more clearly:

```typescript
ingest(entry: ReviewEntry): void {
  if (!this.shouldAnalyze(entry)) return;
  this.buffer.push(entry);

  const shouldFlushNow = this.isHighSignal(entry) ||
                         this.buffer.length >= this.config.bufferSize;
  if (shouldFlushNow) {
    this.flush(this.isHighSignal(entry) ? 'high-signal' : 'buffer-full');
  } else {
    this.resetFlushTimer();
  }
}
```

This makes the logic unambiguous and handles the timer lifecycle correctly.

---

### 2. `analysesThisHour` counter has no persistence — rate limiting resets silently on server restart

**Why it matters:** The hourly rate limit is tracked purely in memory. If the server restarts (crash, deploy, update), the counter resets to 0. In a scenario where the server restarts frequently (e.g., during an update cycle), the extractor can exceed its intended cost ceiling with no visibility. With a $26/month ceiling this is not catastrophic, but the spec claims "cost control" — and the control has a hole.

**Suggested fix:** Two options:
1. **Simple:** Persist `analysesThisHour` and `hourWindowStart` to the stats state file on each increment. On startup, check if the persisted window is still current; if so, restore the counter.
2. **Simpler:** Accept the gap but add an explicit note in the cost model section that the ceiling is per-continuous-uptime, not per-calendar-hour. Right now the spec implies stronger guarantees than the implementation delivers.

Option 1 is ~10 lines. Option 2 is a doc fix. Either is fine — just don't leave the gap undocumented.

---

## Recommendations (should fix, not blocking)

### 3. Open Question #1 (rich CoherenceGate feedback) should be resolved now, not deferred

The spec asks whether CoherenceGate's full specialist reviewer details should flow into `ReviewEntry`. The answer is yes, and building without this leaves the best signal on the floor.

When CoherenceGate blocks a message, the per-reviewer breakdown (which specialist triggered, what the issue was, what the suggestion was) is exactly what the LLM analyst needs to generate a high-quality learning. Without it, the analyst sees "BLOCKED (coherence-gate)" and has to infer what happened from the message text alone. With it, the analyst can directly map the block to a behavioral pattern category.

The cost is low: extend `ReviewResult` to include an optional `reviewerDetails` field, and populate it in the CoherenceGate code path. This is ~20 lines and should be part of the initial implementation.

---

### 4. Open Question #4 (privacy: user content in bridge messages) needs a policy decision before shipping

The spec defers this to a future enhancement list. It shouldn't be deferred — it's a data governance decision that affects what gets sent to the LLM API for analysis.

If an agent is operating as a bridge (forwarding user messages through to another system), those user messages may pass through SendGateway. They would then be included in the batch summary sent to Haiku for learning extraction. This is the agent's *own output* only if the agent authored the content; bridged user content is different.

**Suggested fix:** Add a `contentSource` field to `ReviewRequest` (values: `agent-authored` | `user-relayed` | `system`). The extractor's `shouldAnalyze()` filter should exclude non-`agent-authored` entries by default, with an opt-in config flag to include them. This is a small addition that closes a meaningful privacy gap.

---

### 5. The LLM prompt's "what NOT to flag" section is too weak

The prompt instructs the model to only flag patterns (not one-offs) and to skip issues the review pipeline already caught. But "be selective — only flag genuine patterns" is soft guidance that Haiku may not follow reliably. Low-severity noise findings will accumulate in the EvolutionManager and dilute signal over time.

**Suggested fix:** Add a concrete threshold to the prompt: "Only include a finding if you can cite at least 2 distinct messages from this batch as evidence. Single-occurrence findings are noise — return `[]` for them." This is a one-line prompt change that gives the model a mechanical rule rather than a judgment call.

---

### 6. Deduplication with `insight-harvest` (Open Question #3) should have a default answer

The spec leaves this open. The right default is: tag all auto-extracted entries with a source field (`"source": "learning-extractor"`) and let `insight-harvest` treat them normally. The concern about double-counting is overblown — `insight-harvest` synthesizes *across* learnings, and having more raw data with clearer provenance is better than fewer entries. The tag gives `insight-harvest` the option to weight or filter by source in the future without requiring architectural changes now.

This is already mostly handled in the routing code (`source: { agent: 'learning-extractor' }`) — the recommendation is just to document this as the explicit answer to Open Question #3.

---

## Observations (nice to know)

- **The callback pattern over EventEmitter is the right call.** EventEmitter adds lifecycle complexity (who removes listeners? when does the emitter get destroyed?) that a simple callback avoids. For a single observer, the callback pattern is cleaner.

- **`temperature: 0` for the analysis prompt is correct.** Learning extraction is a classification task, not a generation task. Determinism is more valuable than creativity here.

- **The stats state file structure is well-designed.** `recentFindings` for debugging, counters for observability — this will make diagnosing misbehavior much easier. The `messagesSkipped` and `analysesThrottled` counters are particularly valuable for tuning.

- **The `excludeChannels` default of `['agent-message']` is suspicious.** If `agent-message` is the primary channel through which the agent sends messages, excluding it by default would mean the extractor processes almost nothing. The spec should clarify what `agent-message` represents and why it's excluded. If it's a high-volume internal channel (health pings, status updates), the exclusion makes sense — but that context is missing.

- **No shutdown/drain logic.** When the server stops gracefully, the buffer may have accumulated messages that never get flushed. This is acceptable given the spec's stated tolerance for learning loss, but it's worth a comment in the code noting this is intentional.

- **The `mapCategory()` and `mapGapCategory()` helper methods are mentioned but not defined.** For a spec this detailed, their absence is notable. The mapping from free-form LLM category strings to typed enum values is where schema drift tends to creep in. Even a simple `toLowerCase()` + fallback-to-`general` implementation would be worth spelling out.

---

## Research Findings

### Observer Pattern in Message Pipelines
Current best practices confirm the spec's core architectural instinct: for a single observer, a direct callback is preferable to a full EventEmitter/pub-sub system. The main risk with observer patterns in pipelines is "chatty updates" — the spec correctly addresses this with batching. The push vs. pull distinction matters: this design uses push (SendGateway pushes `ReviewEntry` to the extractor), which is appropriate since the extractor needs the full context at the moment of the event, not a later snapshot.

Key pitfall from research: **forgetting to handle observer lifecycle** (registration/deregistration). The spec's wiring is opt-in at startup and there's no deregistration path. For a server-lifetime component this is fine, but worth noting.

### LLM Batching Architecture
Research on LLM inference pipeline patterns validates the batch-and-flush approach over per-message analysis. The latency vs. throughput tradeoff is well-understood: waiting to accumulate a batch improves analysis quality (more context, fewer redundant findings) at the cost of delayed learning. The 5-minute flush timer is a reasonable ceiling — most sessions won't last long enough to hit it.

The token budget approach (`maxTokensPerAnalysis`) is the right lever for cost control. The spec's default of 2000 input + 1000 output per analysis is conservative enough to avoid surprises.

### AI Agent Self-Improvement Loop Architecture
Research on self-improving agents confirms this design aligns with the "evaluator reflect-refine loop" pattern documented by AWS and others. The key principle from the literature: **layered validation is essential** — unfiltered noise degrades improvement over time. The spec's `minMessageLength` filter and channel exclusions are the right instinct, but they operate on the input side. The output side (preventing noisy findings from polluting EvolutionManager) relies entirely on the LLM prompt — which is the weakest link (see Recommendation #5).

The "episodic memory" layer (buffer of recent messages) → "semantic memory" layer (EvolutionManager learnings) → "working memory" (session context via Playbook) pipeline matches the three-layer memory architecture described in the agent retraining literature. This is a well-validated pattern.

---

## Scalability Assessment

### Phase 1 (MVP — 1 agent, typical message volume)
Will work well. The buffer/timer approach handles bursty message flows gracefully. The haiku cost ceiling ($26/month max) is acceptable. The main risk is noisy findings if the LLM prompt isn't tuned well — but this is observable via the stats endpoint and correctable without architectural changes.

### Phase 2 (Growth — multiple agents, higher message volume)
The current design is per-instance (one extractor per server). This scales horizontally without changes — each agent runs its own extractor independently. No shared state means no coordination overhead.

The rate limiter (12 analyses/hour) becomes a real constraint if an agent is very active. The extractor will start dropping batches silently (`analysesThisHour >= maxAnalysesPerHour` returns without logging). This should emit a metric or log line when throttling occurs — otherwise debugging "why aren't learnings being generated?" is opaque.

### Phase 3 (Scale — cross-agent aggregation, high volume)
The "cross-agent patterns" future enhancement mentioned in the spec would require significant architectural changes: a centralized aggregation service, deduplication across agent instances, and a consensus mechanism for what constitutes a "pattern" at scale. This is out of scope for v1 but the design doesn't preclude it — the `source.agent` field in routed learnings is the right foundation for future cross-agent deduplication.

The spec's data model (findings stored in EvolutionManager, not in the extractor) is the right call for future evolution. The extractor stays stateless (buffer is ephemeral), and the persistence layer (EvolutionManager) handles scaling independently.

---

## Score: 8/10

This is a mature spec. The problem is real and well-articulated, the architecture is clean, the cost model is honest, and the integration surface is minimal. The post-send callback over EventEmitter is the right pragmatic choice. The open questions are identified clearly rather than papered over.

The score is not higher because: (1) the buffer drain / timer lifecycle bug in Critical Issue #1 would cause subtle misbehavior in production, (2) the privacy gap in Open Question #4 needs resolution before shipping to multi-user deployments, and (3) the LLM prompt's filtering guidance is soft where it should be mechanical.

None of these are hard problems. They're addressable in the implementation phase with minor spec adjustments. Conditional approval: resolve Critical Issues #1 and #2, and document answers to Open Questions #1 and #4, then proceed.
