# Architecture Review: Coherence Gate — Round 2

**Review ID**: 20260309-131232
**Reviewer**: Architecture
**Round**: 2 (prior: 20260309-122235)
**Date**: 2026-03-09

## Approval Status: APPROVE

---

## Improvements Since Round 1

1. **Stop hook output contract clarified** (was P0) — NOW ADDRESSED. The spec now explicitly states: JSON stdout mechanism exclusively, always exits 0, blocking via `{"decision": "block", "reason": "..."}`. No more contradiction between exit code 2 and JSON stdout. Clean and unambiguous.

2. **Retry semantics clarified** (was P0) — NOW ADDRESSED. `stop_hook_active` means "revision attempt, increment retry counter" — NOT "skip review." Counter tracked server-side by sessionId. Reset on new non-continuation response. Counter at maxRetries = pass through + attention queue. Clear state machine.

3. **`Promise.allSettled`** (was unique finding) — NOW ADDRESSED. Explicitly specified. Failed reviewers = "no opinion" / abstain. Consistent with fail-open semantics.

4. **Hook ordering** (was unique finding) — NOW ADDRESSED. Migration plan specifies exactly which hooks are retired when (Week 4: claim-intercept, convergence-check; Week 5: external-communication-guard) and which remain independent (dangerous-command-guard, external-operation-gate, scope-coherence-checkpoint).

5. **Conversation context for reviewers** (was consensus finding) — NOW ADDRESSED. Server reads `transcriptPath`, extracts last 3-5 tool results (~500 tokens). Passed to Claim Provenance, Settling Detection, and Capability Accuracy. Data minimization: other reviewers don't receive it.

6. **Custom reviewer interface** (was P0 from DX) — NOW ADDRESSED. `ReviewerSpec` contract with LLM-powered and programmatic options. Auto-discovery from `.instar/reviewers/`. Per-reviewer model selection supported.

7. **Aggregation policy defined** (was P0 from DX) — NOW ADDRESSED. Clear rules: any block-mode fail = BLOCK, warn-only = PASS with feedback, configurable escalation threshold (default 3 warnings = block), timeout/malformed = abstain.

---

## Research Findings

- **LLM-as-judge pipeline patterns**: The gate-then-fan-out pattern is well-established in production systems. NeMo Guardrails uses up to 5 parallel rails with ~0.5s added latency. The Coherence Gate's architecture (1 gate + up to 7 parallel) is within the proven range.
- **Anthropic prompt caching**: Cache reads at $0.10/MTok and not counting toward ITPM limits is a significant architectural advantage. The workspace-level isolation (Feb 2026) means cache sharing across agents requires workspace co-location.
- **Claude Code stop hook system**: The JSON stdout contract (`{"decision": "block", "reason": "..."}`) is the documented mechanism. The spec correctly uses this exclusively, avoiding the ambiguous exit code 2 path.

---

## Critical Issues (must fix before building)

None. All Round 1 architectural P0 issues have been resolved.

---

## Recommendations (should fix, not blocking)

### 1. CoherenceGate.ts as a Clean State Machine (MEDIUM)
**Section**: Implementation Plan — Phase 1

The evaluate flow has multiple state transitions: gate decision, specialist fan-out, aggregation, retry tracking, fail behavior, queue-on-failure. This is a state machine with at least 6 states. The implementation plan describes it as a linear function.

**Suggestion**: Implement CoherenceGate.evaluate() as an explicit state machine (or at minimum, document the state diagram). States: GATE_EVALUATING → REVIEWING / SKIPPED → AGGREGATING → PASSED / BLOCKED / QUEUED / FAILED_OPEN. Transitions carry the review context. This makes debugging, testing, and extension much cleaner than a procedural flow with nested conditionals.

### 2. Reviewer Patch Accumulation (MEDIUM)
**Section**: Organic Evolution — Local Self-Patching

Each reviewer's prompt is composed of base + local patches + value context. Over time, local patches grow. This has three architectural implications:
- Input tokens increase, eroding cache benefits (patches differ from base, breaking cache hits)
- Prompt coherence degrades (patches may contradict base instructions)
- Testing becomes harder (the effective prompt diverges from the canonical version)

**Suggestion**: Cap local patches at ~200 tokens per reviewer. When patches exceed the cap, trigger a consolidation task: merge patches into a coherent addendum, deduplicate, remove obsolete patterns. Consider versioning patches so operators can see what changed when.

### 3. Queue-on-Failure Bounded Size (LOW)
**Section**: Config — Per-channel fail behavior

When `queueOnFailure: true` and the API is down, messages queue in memory. No queue size limit is specified. During an extended outage with high message volume, the queue could grow unbounded.

**Suggestion**: Add `maxQueueSize` per channel (default: 50). When exceeded, oldest queued messages are delivered with `[unreviewed]` flag. This bounds memory usage during outages.

### 4. Programmatic Reviewer Sandboxing (LOW)
**Section**: Custom Reviewer Interface

Custom reviewers with `script` field run a JS module locally. The module has full Node.js access. A malicious or buggy custom reviewer could:
- Read/write arbitrary files
- Make network requests
- Block the event loop
- Crash the server

**Suggestion**: Run programmatic reviewers with a timeout (e.g., 5 seconds) and consider using `vm2` or `isolated-vm` for sandboxing. At minimum, document the trust model: custom reviewers have the same access as instar itself.

---

## Observations

1. **The architecture is now clean.** Round 1 had 4 specification contradictions. All are resolved. The stop hook contract is unambiguous. Retry semantics are clear. Hook ordering is explicit. This is implementable without ambiguity.

2. **The reviewer responsibility matrix** is an excellent addition. Primary concern, required context, overlap resolution, and deduplication rules eliminate the redundant-flagging problem from Round 1.

3. **The data minimization matrix** (which reviewer gets what context) is architecturally elegant. URL Validity receiving only extracted URLs, not the full message, is a model for least-privilege data access in LLM pipelines.

4. **The thin-hook/thick-server pattern remains strong.** All intelligence server-side. Hook is ~20 lines. Reviewer updates don't require hook redistribution. Server can evolve the pipeline without touching agent installations.

5. **The session mutex** is necessary and correctly identified. Concurrent review requests from the same session (e.g., rapid fire messages) could create race conditions on retryCount without it.

6. **The relationship table** (existing hooks vs Coherence Gate) clearly delineates what's replaced, what remains, and why. This prevents the common migration mistake of retiring something that served an orthogonal purpose.

---

## Scalability Assessment

| Phase | Assessment | Key Architecture Concerns |
|-------|-----------|--------------------------|
| MVP | GREEN | Clean implementation path. 7 files in `src/core/reviewers/`, 1 orchestrator, 2 routes, 1 hook. Manageable complexity. |
| Growth (10x) | GREEN | Prompt caching handles load. `Promise.allSettled` handles individual reviewer failures gracefully. |
| Scale (100x) | GREEN-YELLOW | Conditional execution reduces average calls. Tiered execution for rate limit pressure. The architecture supports all three consolidation strategies without restructuring. |
| Viral spike | GREEN | Queue-on-failure absorbs bursts for external channels. Fail-open for internal. Stateless reviewers (no reviewer-side state) mean horizontal scaling is straightforward if needed. |

---

## Score: 8.5/10

**Justification**: Major improvement from Round 1 (was 7.5/10). Every architectural P0 from Round 1 is resolved. The spec is now unambiguous and implementable. The additions (reviewer responsibility matrix, data minimization matrix, custom reviewer interface, aggregation policy, migration plan) address all prior gaps. The state machine recommendation and patch accumulation concern are genuine but not blocking. This is a well-designed system architecture that supports both the immediate implementation and long-term evolution.
