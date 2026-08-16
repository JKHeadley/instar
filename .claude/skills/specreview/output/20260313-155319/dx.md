# DX Review: LearningExtractor
**Review ID:** 20260313-155319
**Round:** 1
**Reviewer:** Echo (DX & API Design)
**Spec:** `specs/learning-extractor.md`

---

### Approval Status: CONDITIONAL

Strong architectural instincts and excellent problem framing. The post-send observer pattern is the right call and the rationale table is convincing. A few issues need resolution before building — primarily around the callback pattern, the `LearningSource` type mismatch, and missing observability in the status endpoint.

---

## Critical Issues (must fix before building)

### 1. `LearningSource` type mismatch in `addLearning` call

The spec passes `source` as:
```typescript
source: {
  agent: 'learning-extractor',
  discoveredAt: new Date().toISOString(),
}
```

But the real `LearningSource` interface (verified in `src/core/types.ts`) has no `discoveredAt` field. The fields are `agent?`, `platform?`, and what appears to be a content reference field. The `discoveredAt` timestamp will either be silently dropped or cause a TypeScript error. **This will break the build.**

Fix: Align with the actual `LearningSource` interface. The timestamp is probably better placed in `evolutionRelevance` or as part of the `description`.

---

### 2. Callback fires BEFORE the result is returned to the caller

The spec shows the callback firing at "end of `review()` method, after returning result" — but in TypeScript you cannot do work after a `return` statement. The spec code shows:

```typescript
// At end of review() method, after returning result:
if (this.postReviewCallback) {
  this.postReviewCallback(...)
}
```

This is logically impossible as written. The callback must fire before the `return`, or be invoked via `Promise.resolve().then(...)` (fire-and-forget microtask after the current call stack). Given that `ingest()` is synchronous, the cleanest fix is to fire the callback synchronously just before each `return` statement. There are five return sites in `SendGateway.review()`. The spec needs to be explicit about which returns trigger the callback (all of them, or only final outcomes?) and where in the code flow it actually goes.

---

### 3. No flush-on-destroy / graceful shutdown path

`LearningExtractor` has no `destroy()` method. When the server shuts down mid-buffer, any accumulated entries in the buffer are silently lost. SendGateway itself has a `destroy()` method — the extractor should follow the same pattern.

Fix: Add `async destroy(): Promise<void>` that clears the flush timer, flushes any remaining buffer (best-effort), and persists the final stats to disk.

---

## Recommendations (should fix, not blocking)

### 4. The `flushIntervalMs` timer resets on every message

`resetFlushTimer()` is called on every `ingest()`. This means a busy agent that sends one message every 4 minutes and 59 seconds will never flush on the timer — messages accumulate indefinitely until the buffer fills. This isn't dangerous (the buffer cap saves it), but it defeats the purpose of the timer as a "max staleness" guarantee.

The standard pattern for this scenario is a **fixed-interval timer** (set once at construction, not reset on each message) rather than a debounce timer. If the intent is "don't analyze more often than every N minutes," that's rate limiting — already handled by `maxAnalysesPerHour`. The timer should be a fixed heartbeat.

---

### 5. `maxAnalysesPerHour` rate limiting has a silent-drop problem

When the rate limit is hit, `flush()` returns early and the buffer is *not drained*. But `ingest()` continues pushing to the buffer. Once the buffer hits `bufferSize`, a new flush attempt fires — and is also silently dropped. The buffer can then fill completely, stop accepting new entries (if capped), or grow unbounded (if not capped). The spec doesn't show a buffer size cap distinct from `bufferSize`-as-trigger.

Fix: When rate-limited, drain the buffer to avoid it growing stale, OR cap the buffer at `bufferSize` and discard new entries when full. Either way, `messagesSkipped` should count rate-limit discards distinctly from filter discards.

---

### 6. `recentFindings` in state file needs a size bound

The spec says "last 20 for debugging" but `updateStats()` is not shown. If every finding is appended without pruning, the state file grows unbounded. Make the 20-item cap explicit in the spec and in the implementation note.

---

### 7. CoherenceGate `blockedBy` value inconsistency

`SendGateway.ts` (actual code) sets `blockedBy: 'coherence-gate'` but the spec's `isHighSignal()` checks for `'coherence-gate'` (with hyphen). This matches — but the spec should note the exact string to prevent future drift. More importantly: `blockedBy: 'convergence'` is NOT set in the real SendGateway code. The convergence checker only generates warnings that go into `warnings[]`; it does not block messages. The `isHighSignal` check `entry.result.blockedBy === 'convergence'` will never be true.

Fix: Remove the `'convergence'` check from `isHighSignal()`, or change it to check for convergence warnings in `warnings[]` instead.

---

### 8. Open Question 4 (privacy) deserves a spec-level answer, not deferral

The question of whether bridge messages should be excluded is important for correctness — bridge messages forward user content that was NOT authored by the agent. Sending user content to a second LLM call without consent is a real concern. The spec currently allows bridge messages to flow through (since `includeBlocked: true` and no bridge exclusion). Given that `SendGateway.review()` already short-circuits for `origin === 'bridge'` (returning early with `pass: true`), the `ReviewEntry` for bridge messages won't have convergence or coherence data anyway — but the message content is still present. The spec should either:
- Explicitly exclude `messageOrigin === 'bridge'` in `shouldAnalyze()`, or
- Explicitly accept that bridge messages are in scope with a rationale.

---

### 9. The status endpoint returns everything — needs a `?verbose` param

`GET /learning-extractor/status` returns stats + last 20 findings. For routine health checks (used by jobs, polling agents), the findings array is noise. Following the pattern established by other instar endpoints, add a `?verbose=true` query param: without it, return only stats; with it, include `recentFindings`.

---

## Observations (nice to know)

- The cost model table is excellent — the exact kind of thing developers need to decide whether to enable a feature. Keep it.

- The "What This Does NOT Do" section is genuinely useful DX. It preempts the most common confusion (is this duplicating CoherenceGate?). More specs should do this.

- Using `temperature: 0` for the analysis prompt is the right call — deterministic classification output is more useful than creative extraction here.

- The batch summary truncation at 500 chars is pragmatic, but the spec doesn't address what happens when the truncated portion contains the evidence for a finding. The LLM will reference "Message 3" but the evidence might be in the cutoff. Consider truncating from the middle rather than the tail, or including a summary of the full message alongside the preview.

- Open Question 3 (deduplication with insight-harvest) should be answered with tagging: add `'auto-extracted'` as a tag (already in the spec) and have insight-harvest filter or weight these differently. This is a two-line addition to insight-harvest's query — worth noting as a small but complete answer.

- The `mapCategory()` and `mapGapCategory()` helper functions are referenced in routing but never specified. These are non-trivial — they need to map freeform LLM-generated category strings to the `EvolutionType` and `GapCategory` enums. Include a mapping table or a fallback strategy in the spec.

---

## Research Findings

### DX Best Practices for AI Agent Extension Systems (from external research)

**Principle: Zero mandatory config for opt-in features.** The leading agent frameworks (OpenAI Agents SDK, Google ADK) make optional capabilities discoverable through defaults — you don't need to configure a feature to see it mentioned; you need to configure it to enable it. The LearningExtractor follows this correctly: `enabled: false` by default, single key to turn on.

**Principle: Fail modes must be documented before code, not after.** Systems that silently drop data (like the current rate-limit behavior described above) erode developer trust faster than systems that loudly fail. The 2025 LLM observability consensus is that all drops, throttles, and errors should be surfaced through stats counters — not silently absorbed.

**Principle: Observability is a first-class concern in learning pipelines.** The 2025 LLMOps baseline per Maxim, Braintrust, and OpenTelemetry includes: per-call tracing with input/output, latency tracking, error rates, and feedback loop closure metrics. The spec's stats schema is solid but missing per-analysis latency (`avgAnalysisDurationMs`) and LLM error rate (`analysisErrors`). These two fields are the difference between "is this working?" and "is this worth the cost?"

**Pattern: Callback vs EventEmitter for single-consumer hooks.** For a single observer (one LearningExtractor per SendGateway), a callback is the correct pattern — lower overhead, simpler types, easier to test. EventEmitter is justified when multiple observers are expected. The spec's choice is validated by the same pattern used in Node.js stream internals and by the OpenAPI generator's call-time middleware PR referenced in the TypeScript configuration research. The spec's rationale ("no EventEmitter overhead") is sound.

**Pattern: Configuration defaults as a contract.** The `options-defaults` TypeScript pattern (deep merge rather than shallow Object.assign) is the right approach for nested config objects like `LearningExtractorConfig`. When the config is partially specified in `.instar/config.json`, a shallow merge will leave nested arrays at their provided values rather than merging with defaults. The wiring code in the spec uses spread (`{ ...defaults, ...config.learningExtractor }`) which is shallow — fine for this flat config, but worth noting.

---

## Scalability Assessment

**At low message volume (current typical agent):** The system is barely exercised. The 5-minute timer fires, finds 2-3 messages in the buffer, runs a cheap haiku call, generates 0-1 findings. Cost approaches zero. This is the right behavior.

**At high message volume (busy agent, multiple channels):** With 12 analyses/hour cap and 10-message batches, the system handles up to 120 messages/hour before throttling. Above that, messages queue but findings are capped. The rate limiter is the right safety valve. The issue (noted above) is what happens to the buffer when rate-limited — this needs a defined overflow strategy.

**As instar adds more channels:** The `excludeChannels` default only lists `'agent-message'`. As new channels are added (future WebSocket channel, CLI channel, etc.), developers will need to update this default. The spec should note that `excludeChannels` is a safelist-of-exclusions, not a safelist-of-inclusions — meaning new channels are analyzed by default. This is probably the right behavior but should be explicit.

**As the evolution system grows:** The `recentFindings: Finding[]` on the state file is a debug aid, not an audit trail. As the system matures, there may be demand for a queryable history of extracted findings. The spec wisely defers this to "future enhancements" — the right call for v1.

**Multi-agent deployment:** Open Question 3 (cross-agent aggregation) is the right long-term scalability question. The current design is correctly agent-local. The `auto-extracted` tag is the right hook for future aggregation without coupling v1 to a network dependency.

---

## Score: 7/10

The spec is architecturally sound, well-motivated, and respects the existing codebase's patterns. The post-send observer with batching and rate limiting is exactly the right design for a background learning system. The deduction comes from: (1) the `LearningSource` type mismatch which is a confirmed build-breaker, (2) the post-return callback that needs clarification, (3) the convergence `blockedBy` check that will silently never fire, and (4) the graceful shutdown gap. These are all fixable in under an hour — this spec is close to a APPROVE.

Fix the four critical items and one more pass should clear it.
