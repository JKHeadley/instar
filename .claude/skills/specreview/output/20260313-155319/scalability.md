# Scalability Review — LearningExtractor
**Review ID:** 20260313-155319
**Round:** 1
**Reviewer role:** Scalability & Infrastructure
**Spec:** LearningExtractor — Automatic Lesson Extraction from the Message Stream

---

### Approval Status: CONDITIONAL

The spec is well-reasoned and the cost model is sound at the single-agent scale it targets. Several issues need resolution before building, primarily around in-memory buffer safety, the hard hourly counter reset pattern, and the absence of backpressure between the buffer and the LLM call queue. These are not blocking in the "don't build it" sense, but they will cause real pain in failure scenarios if left unaddressed.

---

### Critical Issues (must fix before building)

**1. In-memory buffer has no size ceiling — crash risk under message bursts**

The `buffer: ReviewEntry[]` array grows unbounded until either the size threshold or timer fires. If SendGateway's `review()` is called faster than `flush()` returns (LLM latency is 200–2000ms), the buffer will silently accumulate entries. For a single agent sending a few messages per minute this is fine. For a session spawning many sub-agents, or an agent processing a large inbound batch, the buffer could hold hundreds of large ReviewEntry objects.

`ReviewEntry` includes the full message text (up to 500 chars pre-truncation, but stored untruncated in the buffer). At 100 buffered entries × ~5KB each = 500KB. At 1000 entries = 5MB. Not a crash today, but there is no ceiling to prevent runaway accumulation.

**Fix:** Add a `maxBufferSize` config option (suggest default 100). When the buffer hits this ceiling, drop oldest entries and increment a `droppedMessages` counter in stats. This is a learning system — dropping some entries is fine. Uncapped memory growth is not.

---

**2. `analysesThisHour` counter has no persistence — resets on server restart**

The hourly analysis counter is a plain in-memory integer. If the server restarts mid-hour (crash, update, process kill), the counter resets to zero. The `maxAnalysesPerHour` rate limit is the spec's primary cost control mechanism. A server restart could result in `maxAnalysesPerHour × 2` LLM calls in a single hour if the restart happens mid-hour during high-signal activity.

At `maxAnalysesPerHour = 12` this doubles to 24 calls — negligible cost. But if an operator increases the limit to 100, a restart cycle could blow the expected budget by 2x without warning.

**Fix:** Write the counter and the hour-window start timestamp to the stats state file (`.instar/state/evolution/learning-extractor.json`) on every increment. On startup, load the state file and check whether the current time is still within the same hour window. If yes, restore the counter. If the window has elapsed, start fresh. This costs one extra file write per LLM call — cheap.

---

**3. No concurrency gate on `flush()` — overlapping LLM calls possible**

`ingest()` can call `flush()` synchronously (for high-signal events) while a prior `flush()` is still awaiting the LLM response. The spec drains the buffer before each flush (`this.buffer.splice(0)`), so entries won't be double-analyzed. But two LLM calls can be in-flight simultaneously, both counting against `analysesThisHour` after the check passes.

Race condition: two high-signal messages arrive 10ms apart. Both pass the `analysesThisHour < max` check before either increments the counter. Both calls fire. The counter increments twice. This is a minor over-spend, not a correctness issue — but it means the rate limit is a soft ceiling, not a hard one.

**Fix:** Add a `private flushInProgress: boolean` guard. If a flush is already in progress when a second trigger fires, skip the new flush (the batch is already gone — the buffer was drained). Or use a Promise-based lock if concurrent analysis is actually desired.

---

### Recommendations (should fix, not blocking)

**R1. The cost model's token estimate is optimistic**

The spec estimates "~2000 input + 1000 output" tokens per analysis. The actual input token count depends heavily on message content. The batch summary includes up to 10 messages × 500 chars each = 5000 chars ≈ 1250 tokens of message text alone, plus the system prompt (~300 tokens), plus warnings/metadata. A realistic estimate for a full 10-message batch with several warnings is 2500–4000 input tokens, not 2000.

The output estimate of 1000 tokens for findings is reasonable if there are 2–3 findings. A verbose batch might push 1500 tokens.

Revised cost estimate at Haiku 3.5 pricing ($0.80/M input, $4/M output):
- Per analysis: ~3000 input ($0.0024) + 1000 output ($0.004) = **~$0.0064**
- At 12/hour: **~$0.077/hour**, not $0.036
- Monthly ceiling: **~$55**, not $26

This is still inexpensive, but the spec's numbers are 2x off. Update the cost model so operators set expectations correctly.

**R2. Timer-based flush has a subtle always-on cost**

The `flushIntervalMs` timer (default 5 minutes) runs continuously once any message enters the buffer. If an agent sends a low-volume session (5 messages over 30 minutes), the timer will fire 6 times, triggering analysis on partially-filled batches of 1–2 messages. These small batches have poor signal-to-noise ratio but consume a full LLM call each.

The spec has `minMessageLength` filtering but no minimum batch size for timer-triggered flushes. A batch of 1 message is almost always noise.

**Fix:** Add a `minBatchSizeForTimerFlush` config (default: 3). Only fire the timer-triggered analysis if the buffer has at least N entries. Buffer-full and high-signal triggers bypass this threshold.

**R3. Deduplication against existing learnings is absent**

The EvolutionManager will accumulate duplicate learnings over time. The same behavioral pattern (e.g., "agent over-explains when asked yes/no questions") could be extracted repeatedly across multiple analysis batches across multiple days. The spec notes this as an open question (#3) but treats it as deduplication with insight-harvest rather than as a LearningExtractor concern.

At low volume this is cosmetic noise. At scale it degrades the evolution system's signal quality — the learning registry fills with variants of the same observation, and insight-harvest wastes tokens re-synthesizing identical patterns.

**Fix:** At minimum, pass the last N learning titles to the LLM prompt as "already known patterns — do not re-flag." A smarter approach is to check the EvolutionManager's learning registry for semantic overlap before inserting, but that requires an embedding comparison that's out of scope for v1. The prompt-based approach costs ~100 extra tokens per analysis and substantially reduces noise.

**R4. Privacy gap for bridge/relay channels is unaddressed**

Open Question #4 in the spec flags this correctly but leaves it open. Message content from bridge channels (forwarding user input) flows through the LLM analyzer. If an agent is configured as a relay (forwarding Telegram messages, email, etc.), user-authored content gets analyzed by the LLM without the user's knowledge.

For instar's current single-agent use case this is low risk. But the `excludeChannels` config option suggests multi-channel support is contemplated. A future agent processing customer support messages would be sending customer content to Haiku without consent.

**Fix:** Document explicitly that LearningExtractor is appropriate only for agent-authored content. Add a comment in the config schema noting that `excludeChannels` should include any channel carrying user-originated content. This is a documentation fix, not a code fix, but it needs to exist before other teams adopt the pattern.

---

### Observations

- The post-send observer pattern is the right call. Pre-send analysis would add 200–2000ms latency to every message and couple the learning system to the critical path. The fail-open error handling is appropriate for a growth subsystem.

- Treating blocked messages as high-signal is architecturally sound. CoherenceGate blocks are the richest learning signal because they represent named anti-patterns (fabrication, sycophancy, settling) with structured taxonomy. The LLM prompt can leverage this taxonomy directly.

- The `buildBatchSummary` truncation at 500 chars is good token hygiene. Most of the signal is in message structure and warning labels, not full text.

- The spec's callback approach (`setPostReviewCallback`) rather than EventEmitter is pragmatic for v1. If SendGateway ever needs multiple observers, refactor to EventEmitter then. Not worth the overhead now.

- The stats state file design is clean. `recentFindings: Finding[]` at last 20 entries is a good debugging surface. Consider making this limit configurable (`recentFindingsLimit`).

- Open Question #2 (inbound message tapping for user correction signals) is worth pursuing in v2. "That's wrong" and "no, I meant..." are some of the strongest learning signals available. The integration point would be a `MessageReceived` event on the inbound path, not SendGateway.

---

### Research Findings

**Haiku 3.5 pricing (current):** $0.80/M input tokens, $4/M output tokens. Batch API offers 50% discount. Prompt caching saves 90% on cache hits (cache write = 25% premium, cache read = 10% of standard). For a system that reuses the same system prompt across all analyses, prompt caching would eliminate ~80% of the input token cost on cached portions — worth enabling if the spec advances to high-volume use.

**LLM batching pipeline bottlenecks:** The dominant bottleneck in observer-pattern LLM pipelines is not compute — it's the latency between batch accumulation and response delivery. Continuous batching (processing items as they arrive rather than waiting for full batches) reduces queue depth but increases per-call overhead. The spec's hybrid approach (buffer threshold OR timer OR high-signal) is a good balance: most batches wait for the buffer to fill (amortizing call overhead), while high-signal events bypass the wait.

**Backpressure in Node.js async queues:** The core risk in unbounded in-memory queues is not memory exhaustion per se — it's the illusion of control. The spec's `maxAnalysesPerHour` creates a pressure valve on the output side (LLM calls), but there is no pressure valve on the input side (buffer ingestion). If `ingest()` is called faster than `flush()` returns, entries accumulate silently. Node.js does not throw on array push — it just grows the heap. The correct pattern for bounded queues in async pipelines is to check buffer size on every `push()` and either drop or apply backpressure upstream. Since LearningExtractor is observational (not blocking), dropping is the correct response.

---

### Scalability Assessment

**Phase 1 (MVP — single agent, ~50 messages/day):**

Works as designed. Buffer fills slowly, timer-triggered flushes dominate, actual LLM calls are 3–5 per day at typical agent message volume. Monthly cost is ~$0.10–$0.50, well within the stated ceiling. The unbounded buffer and counter reset issues are theoretical at this scale. The critical issues are still worth fixing — they cost almost nothing to address and eliminate a class of failure scenarios before they're hit in production.

**Phase 2 (Growth — multi-session agents, ~500 messages/day):**

Buffer-full triggers will dominate over timer triggers. At 500 messages/day with a buffer size of 10, expect ~50 analyses/day. The `maxAnalysesPerHour` cap of 12 will occasionally throttle during session-heavy hours (e.g., a job that spawns 5 sub-sessions in an hour). `analysesThrottled` in stats will start showing non-zero values. The deduplication gap (R3) becomes visible — the learning registry will show 10–20 variants of the same 3 core observations within a week.

No architectural changes needed, but R1 (cost model accuracy), R2 (minimum batch size for timer flush), and R3 (deduplication) become genuinely important rather than nice-to-have.

**Phase 3 (Scale — fleet deployment, 1000+ agents):**

This is not a scenario the spec contemplates, and the architecture reflects that. For a fleet deployment, the current design has fundamental issues:

1. Each agent runs its own LearningExtractor with its own in-memory state. Cross-agent pattern detection (Future Enhancement #3) would require a shared aggregation layer that doesn't exist.

2. The EvolutionManager is per-agent. There is no cross-fleet learning store. Patterns that every agent exhibits independently never converge into a shared insight.

3. At 1000 agents × 50 analyses/day × $0.0064/analysis = $320/day, or ~$9,600/month. This is the cost cliff. It is not addressed in the spec because the spec targets single-agent deployment. If fleet deployment is ever contemplated, batch API pricing (50% discount) and prompt caching (80%+ savings on the system prompt) need to be implemented first.

For Phase 3, the architecture would need: a shared aggregation service, per-agent LLM call budgets, cross-agent deduplication, and batch API usage. These are out of scope for v1 and correctly so.

**Viral spike handling:**

The spec's rate limiter (`maxAnalysesPerHour`) is the primary spike defense. It works. If an agent suddenly processes 200 messages in an hour (e.g., processing a backlog), the buffer will fill and trigger 20 analyses before the hourly cap halts further processing. The 180 remaining messages will sit in the buffer until the next hour window opens.

The gap: the spec doesn't specify what happens to the buffer when the rate limit is hit. The `flush()` method checks `analysesThisHour >= max` and returns early, leaving the buffer intact. The buffer will keep growing until the hour window resets. If the spike is sustained across multiple hours, the buffer could accumulate 500+ entries before the rate limit opens again.

**Fix:** When the rate limit is hit, drain (and discard) the buffer rather than holding it. Learning data from a spike is lower quality than steady-state data anyway — if an agent is processing 200 messages/hour, the individual message patterns are less informative than the aggregate behavior. Discarding the overloaded buffer is the correct response, consistent with the spec's fail-open philosophy.

---

### Score: 7/10

The architecture is clean, the integration point is minimal and well-chosen, and the fail-open philosophy is correct for a growth subsystem. The cost model and rate limiting demonstrate that scalability was considered. The deductions are for: the unbounded buffer (a real crash risk under any sustained spike), the non-persistent rate counter (a budget safety gap), the missing concurrency guard (a soft correctness issue), and the cost model being 2x off on stated numbers. All of these are fixable in a day of work. The spec is ready to build with those issues addressed.
