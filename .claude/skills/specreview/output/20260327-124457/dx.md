# DX Review — Presence Proxy (Intelligent Response Standby)

**Review ID**: 20260327-124457 | **Round**: 1 | **Date**: 2026-03-27
**Reviewer**: Developer Experience & API Design
**Score**: 7.5/10
**Approval Status**: APPROVED WITH CONDITIONS

---

## Research Findings

**Agent monitoring status patterns**: The AI UX Design Guide and Smashing Magazine (Feb 2026) describe a validated four-layer status model for agentic systems — ambient, progress, attention, and summary. The Presence Proxy maps cleanly onto this. Tier 1-2 are ambient/progress, Tier 3 crosses into attention. This is established, validated thinking.

**Typing indicator & presence UX**: Chat UX research confirms named-presence indicators ("Echo is currently...") outperform generic ones ("Working...") in user comprehension and trust. The spec's LLM-generated contextual messages align with this. The 20-second delay is conservative vs. the typical 5-10s debounce in chat systems — appropriate given the higher cost of a false status message.

**Tiered escalation & false positive management**: IBM research notes 95% of traditional monitoring alerts are false alarms. The spec's three-snapshot delta comparison before offering `unstick` is a textbook implementation of consecutive-failure confirmation — the primary industry defense against alert fatigue. The process-tree-as-authoritative-source override is particularly strong.

---

## Critical Issues

### C1 — No concrete restart recovery algorithm
Edge Case 4 says "re-initialize timers with adjusted delays" but doesn't define what that means. If Tier 1 already fired before restart, the `tier1Snapshot` is gone and Tier 2 needs it for delta comparison. The query shape for finding unanswered messages in `telegram-messages.jsonl` isn't specified. This needs a real algorithm, not intent.

### C2 — `quiet` command has no feedback loop
The proxy goes silent for 30 minutes with no acknowledgment to the user and no way to cancel early or check remaining silence time. A silenced proxy is indistinguishable from a broken one. Missing: confirmation message, a `resume` command, and remaining-silence visibility.

### C3 — Proxy conversation mode has an identity ambiguity problem
The proxy is allowed to answer speculative questions like "How long do you think that'll take?" If the proxy's estimate is wrong, the user loses trust in the agent — not in the proxy. The spec needs an explicit rule: the proxy reports observed facts only; it does not speculate about time estimates or task difficulty.

### C4 — No documented error states for LLM failures
What happens if the Haiku call for Tier 1 takes 25 seconds? Tier 1 now fires at T+45s. What happens if Tier 3's assessment returns text that doesn't match any of the four classifications? The spec needs hard LLM timeouts per tier and fallback behavior for malformed responses.

---

## Recommendations

**R1** — When `quiet` fires, reply immediately: "Got it — I'll stay quiet for 30 minutes. Send `resume` to re-enable early." Add `resume` as a registered command.

**R2** — Define hard LLM timeouts: Tier 1 = 10s, Tier 2 = 15s, Tier 3 = 30s. On timeout, degrade to a templated message rather than silently failing.

**R3** — Add to conversation mode rules: "The proxy does not estimate time, difficulty, or outcomes. For speculative questions, it reports only what it observes in tmux output and elapsed time."

**R4** — Replace vague restart recovery with a concrete algorithm: compute `elapsed = now - messageTimestamp`. If `elapsed < T1`: schedule Tier 1 for `T1 - elapsed`. If `T1 <= elapsed < T2`: skip Tier 1 (no snapshot), send modified Tier 2 noting server restart. If `elapsed >= T3`: go directly to Tier 3. If `elapsed > 15 minutes`: skip entirely.

**R5** — Add a `status` command: the proxy reports its own state (how long it's been monitoring, which tiers have fired, last observed output change).

**R6** — Add `__dev_accelerateTimers?: boolean` to `PresenceProxyConfig` that multiplies all delays by 0.1 for local testing. Without this, integration testing Tier 3 requires a real 5-minute wait per test run.

---

## Observations

- The three-snapshot delta approach (T+20s, T+2m, T+5m) is more sophisticated than anything described in current AI monitoring literature. This is genuine novelty.
- LLM model selection is exactly right: Haiku for observation, Sonnet for consequential decisions.
- Routing proxy messages through the standard `POST /telegram/reply/{topicId}` with `source` metadata is clean architecture.
- "Process tree is authoritative — LLM assessment cannot override this" is a production-grade hard invariant. Excellent.
- `conversationHistory` in `PresenceState` is unbounded. A max-history cap (last 20 exchanges) should be specified.
- Implementation order (Tier 1 first, then logging, then Tier 2, then conversation mode, then Tier 3) is correct. Ship Tier 1 before resolving the critical issues — the issues only affect Tiers 2-3 and conversation mode.

---

## Scalability Assessment

Strong for single-agent use. Each `PresenceState` is isolated per topic, no cross-topic contention, LLM calls are independent. Primary concerns: (1) unbounded `conversationHistory` — cap it; (2) restart recovery scan over `telegram-messages.jsonl` could be slow for large logs — use a 15-minute recency window; (3) LLM call volume in high-frequency conversation mode — the 20-second minimum delay provides natural rate limiting.

**The spec is well-designed and solves a real problem. Tier 1 is ready to build now.**
