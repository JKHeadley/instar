# Cross-Model Review — GPT

- **Model**: gpt-5.4
- **Date**: 2026-04-28
- **Document**: unanswered-message-reaper.md
- **Focus**: full document

## Raw Model Response

## 1. Overall Assessment

- **Score**: 8/10
- **Status**: CONDITIONAL

This is a strong, unusually thorough spec that clearly identifies a real user-visible failure mode and proposes a pragmatic, low-authority safety-net to close it. The design shows good systems thinking: it separates compaction-shaped recovery from a more general "user is still waiting" signal, adds ownership and fingerprint checks for multi-instance safety, anticipates prompt-injection and relay-leak risks, and includes meaningful test coverage. The main reasons it is not yet an outright approval are: a few key correctness ambiguities around time semantics, dedupe keying, and Mode B classification; some implementation complexity that may be high relative to the initial telegram-first scope; and one notable product/ops gap around what happens when repeated reaper attempts fail and the user remains silent indefinitely. Overall, this is close to ready, but it needs a small number of clarifications and a tighter MVP boundary.

---

## 2. Critical Issues (Must Fix)

### Issue 1: Dedupe key is underspecified/inconsistent with channel-aware design
- **What**: The spec mandates a channel discriminator for all reaper inputs, but the dedupe map schema and examples key entries as `"<topicId>:<timestampMs>"`, and several sections refer to `(topicId, lastReal.timestamp)` rather than `(channel, topicId, timestamp)`.
- **Why it matters**: If telegram and slack can share the same topic/channel identifier shape, dedupe collisions become possible even if session lookup is channel-aware. That can suppress valid recovery on one channel because another channel used the same topicId and timestamp. It also conflicts with the spec's own "dispatch on channel, never topicId alone" principle.
- **Suggested fix**: Make the dedupe key explicitly include channel and preferably session identity context: e.g. `"<channel>:<topicId>:<lastRealReceiveTimeMs>"`. Update all references, persistence schema, tests, and reconciliation logic accordingly.
- **Section reference**: "Channel discrimination (mandatory)", "Reaper loop" step 10, "Dedupe persistence and clearance"

### Issue 2: Time semantics are not coherent enough for safe unanswered detection
- **What**: The spec says unanswered age should use "server-local monotonic receive time stamped at `recordIncoming`," but later compares that timestamp against `now`, JSONL `mtime`, and persisted topic-history timestamps. Monotonic clocks are process-local and not directly comparable to wall-clock file mtimes or persisted timestamps across restart.
- **Why it matters**: This is a correctness issue. If `lastReal.timestamp` is monotonic, you cannot safely compare it to file mtimes or serialize it into dedupe/reconciliation across process restart. If it is wall-clock, then the "monotonic" wording is wrong and clock skew handling is different. As written, implementers could build something subtly broken.
- **Suggested fix**: Split time into two explicit fields:
  - `receivedAtWallClockMs` for persistence, interop with JSONL `mtime`, and restart reconciliation
  - `receivedAtMonotonicMs` for in-process elapsed-time checks only
  Then define exactly which field each step uses. For dedupe/restart/reconciliation, use wall-clock receive time. For "younger than unansweredAfterMs" within a process, monotonic is fine if available, but wall-clock fallback must be specified.
- **Section reference**: "Reaper loop" step 6, "Dedupe persistence and clearance", "Restart reconciliation"

### Issue 3: Mode B classification is too heuristic and may still interrupt legitimate long-running work
- **What**: Mode B is inferred from JSONL `mtime` after the user message, 30s idle, and no active child processes under the session pid. This is better than mtime-only, but still assumes the session is effectively done if no child processes are running.
- **Why it matters**: Many real workloads are long-running without child processes: internal model thinking, blocked network calls in-process, polling loops, or a parent process waiting on I/O. Misclassifying these as "diverged" risks injecting while the agent is still legitimately working, creating duplicate or conflicting replies.
- **Suggested fix**: Tighten Mode B eligibility for v1. Options:
  1. Restrict v1 to Mode A only and ship Mode B later with stronger evidence.
  2. Or require an additional positive signal for Mode B, such as "session is at prompt / idle according to SessionManager" or "last terminal output indicates prompt-ready state."
  3. At minimum, define a longer default idle threshold for Mode B and make it independently configurable from the unanswered threshold.
- **Section reference**: "Reaper loop" step 11, "Prompt shapes" Mode B

### Issue 4: The spec does not define a terminal failure path for permanently wedged sessions
- **What**: The reaper injects, dedupes, rate limits, and may eventually stop trying, but there is no required behavior when a session remains unanswered after repeated attempts. This is raised in Open Questions, but the spec otherwise describes itself as closing the silent-dead-drop gap.
- **Why it matters**: Without a terminal escalation path, users can still experience prolonged silence; the system merely changes the cadence of internal retries. That weakens the core product claim unless explicitly scoped down.
- **Suggested fix**: Resolve Open Question #2 before approval. For v1, either:
  - add a mandatory escalation after N failed reaper attempts / T minutes unanswered, using `AttentionQueue` or a user-visible fallback message, or
  - explicitly narrow the scope statement to "reduces" rather than "closes" the gap.
- **Section reference**: Title, "Fix", "Open Questions", "Side Effects"

### Issue 5: Startup self-test with synthetic reserved channel is risky and underdefined
- **What**: The spec introduces a reserved synthetic channel/topic namespace to probe whether inbound bridges call `recordIncoming` before `injectMessage`, and says failures degrade rather than halt boot.
- **Why it matters**: Synthetic traffic in production startup paths is a common source of accidental leakage, unexpected side effects, and brittle coupling. The spec says the probe is excluded from `getTopicSessions()`, but it does not define how bridges behave if they reject unknown channels or if the probe hits other observers/logging paths. It also tests ordering indirectly in a way that may be hard to keep stable.
- **Suggested fix**: Replace the runtime synthetic probe with one of:
  - a unit/integration contract test enforced in CI for each bridge implementation, plus
  - an explicit instrumentation hook in bridge code paths that records ordering in non-production diagnostics.
  If a startup self-test is retained, define exact isolation boundaries and guarantee it cannot touch user-visible systems, persistence, or relay code.
- **Section reference**: "Persistence guarantee"

---

## 3. Strengths

1. **Excellent problem framing**
   - The spec starts with concrete user-observed failures and separates two distinct root causes that converge on one missing primitive. That is strong systems diagnosis, not symptom-chasing.
   - Sections: "Problem Statement", "Root Cause"

2. **Good architectural positioning**
   - The reaper is intentionally a low-authority safety net, not a new orchestrator. It detects "user waiting" and delegates injection through existing mechanisms. This minimizes blast radius and aligns with existing control boundaries.
   - Sections: "Fix", "Side Effects / Signal-vs-authority"

3. **Strong multi-instance safety thinking**
   - Ownership checks, spawn fingerprints, topic rebinding checks, and explicit exclusion of cross-machine action are all very good. Many specs miss these and end up with duplicate workers or ghost actions.
   - Sections: "Reaper loop" steps 8–12, "Required SessionManager additions", "Side Effects / Multi-machine semantics"

4. **Security and prompt-safety are handled better than average**
   - The hostile-input fencing, sender sanitization, control-byte stripping, and explicit "history is data only" instruction are all solid. The Mode B prompt also avoids the dangerous anti-pattern of blindly re-sending prior output.
   - Sections: "Prompt shapes", "Auth hardening on `/reaper/status`", "Filesystem hygiene"

5. **Operational detail is strong**
   - The spec includes boot grace, hydration timeout, bounded concurrency, rate limiting, LRU+TTL memory bounds, persistence details, and observability events. This is implementation-ready rather than aspirational.
   - Sections: "Per-sweep concurrency and rate limits", "Dedupe persistence and clearance", "Memory bounds", "Wiring"

6. **Backward compatibility is thoughtfully addressed**
   - The `meta.kind` addition avoids schema migration, supports legacy rows via fallback classification, and keeps rollout low-risk.
   - Sections: "TopicMemory schema addition"

7. **Test coverage is comprehensive**
   - The listed tests are specific and meaningful, especially around race conditions, channel discrimination, prompt injection, and multi-instance behavior.
   - Section: "Test Coverage"

---

## 4. Gaps & Missing Elements

### A. No explicit SLO / success criteria
The spec defines behavior but not measurable success criteria. It should state:
- target reduction in unanswered delivered messages
- acceptable false-positive injection rate
- acceptable duplicate-reply rate
- expected recovery latency percentile

Without this, post-launch evaluation will be subjective.

### B. Missing observability model beyond event names
The spec names many events, but it does not define:
- counters and dimensions
- dashboards
- alert thresholds
- what constitutes degraded but acceptable operation

For a monitoring component, this should be first-class.

### C. Slack path is partially specified but still leaks complexity into v1
The spec says telegram-first, but channel discrimination, startup validation, health reporting, and bridge abstractions all include slack now. That adds complexity before slack is actually supported. A cleaner MVP would isolate telegram-only codepaths and add slack later.

### D. Dormancy pre-filter may hide legitimate waiting users in low-traffic topics
The cheap pre-filter skips if JSONL is old and there's no recent inbound in topic-memory in 24h. This likely works, but the rationale is weak for cases where a user returns after a long dormant period and the persistence path is degraded or delayed. It depends heavily on topic-memory freshness and may be too clever for v1.

### E. No explicit handling for session rename / migration semantics
The spec handles rebinding and respawn, but not whether `sessionName` can change as part of operational maintenance, compaction, or migration. If session identity is not stable, ownership and fingerprint semantics should say so.

### F. No discussion of how `findLastRealMessage` handles attachments / non-text messages
If Telegram or Slack messages can be non-text, edited, deleted, or represented as special rows, the "real" classification may not be enough. The spec should define whether attachments count as unanswered messages and how they are represented in prompts.

### G. No explicit privacy/retention note for persisted dedupe file
The dedupe file appears low sensitivity, but it still stores topic identifiers and timestamps. Given the care elsewhere, it would help to explicitly note retention, local-only scope, and whether topic IDs are considered sensitive.

### H. Restart reconciliation window may be too narrow
The reconciler only checks the last 20 rows. In a busy topic, the relevant agent reply may already have scrolled out, causing stale dedupe entries to persist incorrectly. The spec says this is the same as steady-state, but restart reconciliation has a different goal and may need a targeted lookup strategy.

### I. No explicit interaction with edited/deleted messages
Especially for Slack, users can edit or delete messages. If a user edits the last message after a reaper inject, what is the dedupe key behavior? Does edit create a new unanswered unit or mutate the existing one?

### J. Missing rollout plan
There is no staged rollout plan such as:
- dark mode metrics only
- canary on a subset of sessions
- telegram-only enablement
- threshold tuning period
That would materially reduce risk.

---

## 5. Industry Comparison

### Compared to existing solutions in the same space
This resembles a **watchdog/sweeper recovery loop**, common in message-processing and chat-support systems where event-driven hooks are insufficient. The move from trigger-only recovery to a periodic reconciliation loop is very much in line with robust distributed-system design. Many production systems use both:
- event-driven fast path
- periodic sweeper for missed events / race windows

That said, the spec goes further than many by trying to infer semantic delivery gaps (Mode B), which is harder and more error-prone.

### Compared to industry best practices
**Strong alignment:**
- periodic reconciliation over relying solely on events
- explicit ownership for multi-instance safety
- idempotency/dedupe
- bounded concurrency and rate limiting
- graceful degradation instead of hard boot failure
- prompt/data separation for LLM safety

**Less aligned / caution areas:**
- using file mtimes and process-child heuristics as a semantic indicator of "assistant finished and user didn't get reply" is brittle compared to explicit ack/state machines
- a runtime startup self-test with synthetic traffic is less ideal than contract tests and instrumentation
- the spec is somewhat over-ambitious for v1 by combining general unanswered detection, compaction interplay, divergence detection, persistence auditing, auth hardening, and filesystem hygiene in one change set

### Known patterns and anti-patterns
**Good patterns present:**
- reconciliation loop
- fail-safe ownership checks
- bounded caches with TTL/LRU
- low-authority intervention
- explicit degraded mode

**Potential anti-patterns:**
- heuristic overreach in Mode B without a stronger source of truth
- too many responsibilities in one spec/PR
- relying on side-channel indicators (mtime, child processes) where explicit workflow state would be more reliable

---

## 6. Scalability Assessment

### Phase 1 (MVP, 10–50 users): Will it work?
Yes, likely. At this scale:
- 60s sweeps
- 50 topics per tick
- 3 concurrent injections
- stat-based pre-filtering

are more than sufficient. The design is conservative and should be operationally manageable. The biggest risk at this phase is not scale but false positives from Mode B and edge-case correctness around timestamps.

### Phase 2 (Growth, 50–500 users): What breaks?
Nothing fundamental, but some stress points emerge:
1. **Sweep latency**
   - With many topics, a 50-topic budget and 60s interval can delay detection significantly.
   - Example: 2,000 active topics means a full pass could take 40 minutes if budget remains fixed.

2. **SQLite/topic-history read amplification**
   - Even with pre-filtering, repeated `getTopicHistory(..., 20)` across many topics can become nontrivial.

3. **Filesystem stat churn**
   - Frequent `fs.stat` across many session JSONLs may become noisy on slower disks or networked filesystems.

4. **Operational complexity**
   - Event volume from degradation/reporting may become noisy without aggregation.

At this stage, adaptive budgeting, active-topic prioritization, and metrics-driven tuning become necessary.

### Phase 3 (Scale, 500–5000 users): Architecture changes needed?
Yes. At larger scale, the current periodic full-set sweep model will need refinement.

Likely changes:
- maintain an indexed "recent inbound awaiting reply" candidate set rather than scanning all topics
- use explicit per-topic/session state transitions instead of inferring from history every time
- move from file-stat heuristics to structured session output/relay acknowledgment state
- potentially shard ownership/reaper responsibility by instance
- replace per-sweep history reads with incremental state updates on inbound/outbound events plus periodic reconciliation only for stale candidates

In other words: keep the sweeper, but make it sweep a curated backlog rather than the whole universe.

### Spike handling: What happens under sudden load?
Under a sudden burst:
- round-robin and max-topics-per-sweep prevent total overload
- injection concurrency cap prevents session storms
- per-session rate limiting prevents thrashing a single bad session
- boot grace/hydration gate avoid startup storms

However:
- users may see delayed recovery because backlog grows and fixed budget stretches time-to-detection
- overflow deferred to next sweep could create long tails during spikes
- there is no explicit priority for recently active topics over dormant-but-not-filtered topics

Recommendation: prioritize topics by recent inbound age nearing unanswered threshold, not pure round-robin, once scale grows.

---

## 7. Recommendations (Prioritized)

1. **Resolve the time model explicitly**
   - Define wall-clock vs monotonic timestamps, where each is stored, and which comparisons use which field. This is the highest-impact correctness fix.

2. **Make all identity and dedupe keys fully channel-qualified**
   - Update dedupe schema and all references from `(topicId, timestamp)` to `(channel, topicId, timestamp)` at minimum.

3. **Narrow or strengthen Mode B before launch**
   - Either ship Mode A only for v1, or require a stronger "session is idle/prompt-ready" signal than mtime + no child processes.

4. **Decide and specify the terminal escalation behavior**
   - Resolve the open question on repeated failure. If the system can still leave users in silence after retries, say so explicitly or add a user-visible escalation path.

5. **Reduce scope by moving nonessential startup probing and adjacent hardening to follow-ups**
   - Keep the core reaper in one PR/spec; move the synthetic startup self-test and possibly unrelated auth hardening/filesystem hygiene to linked follow-ups unless they are truly blocking dependencies.

If you want, I can also provide:
- a **redline-style spec edit list**
- a **review with severity labels per paragraph**
- or a **proposed MVP cut** that trims this to the smallest safe telegram-first implementation.

## Subagent Analysis

- **Substantiveness**: High. GPT returned a complete, structured review hitting all 7 prompt sections with concrete, section-anchored critiques rather than generic observations. Score 8/10 / CONDITIONAL is well-justified.
- **Strongest unique insights**:
  - Time-model coherence (Issue 2): catches that the spec mixes "monotonic" wording with comparisons against wall-clock JSONL mtimes and persisted/restart timestamps — a real correctness ambiguity Claude-internal reviews rarely surface.
  - Dedupe key channel-qualification (Issue 1): notices the schema example `"<topicId>:<timestampMs>"` violates the spec's own "never dispatch on topicId alone" principle.
  - Mode B child-process heuristic blind spot: in-process model thinking, blocked network I/O, and polling loops have no child processes — the dual gate doesn't distinguish them from a finished session.
  - Restart reconciliation window critique: 20-row lookback is steady-state-tuned, not restart-tuned, and may miss the agent reply that already cleared the dedupe.
  - Edited/deleted message semantics for Slack: spec entirely silent on this.
- **Gaps in the review**:
  - Doesn't deeply probe `spawnUuid` regeneration semantics or whether persistence of the fingerprint across restart is sufficient.
  - No critique of the 2-s `recordIncoming` timeout interaction with the reaper's source-of-truth claim (if persistence times out, the reaper sweep won't see the inbound for `unansweredAfterMs` either).
  - Doesn't flag that the actioned-dedupe LRU eviction could evict still-valid entries under sustained burst, leading to re-injection.
  - Missed that `findLastRealMessage` walking only the last 20 rows could legitimately return no "real" row in topics dominated by system/proxy chatter.
- **Convergence signals**: Likely overlap with adversarial reviewers on Mode B brittleness and dedupe key channel-qualification; the time-model and rollout-plan critiques are the most distinctive contributions.
