# Architecture Review — Presence Proxy

**Review ID**: 20260327-124457 | **Round**: 1 | **Date**: 2026-03-27
**Reviewer**: Systems Architect
**Score**: 8/10
**Approval Status**: APPROVED WITH CONDITIONS

---

## Research Findings

**Agent monitoring systems**: The tiered alert escalation model (status → progress → assessment) maps directly to SRE page escalation patterns (PagerDuty, Nagios). The validated learning from production systems: lower tiers must be explicitly non-actionable. The spec enforces this correctly — Tiers 1-2 are observation-only.

**tmux monitoring**: The existing `SessionManager.captureOutput()` is the right primitive. Capture-pane is synchronous on the tmux server, safe for rapid repeated calls. One gap: the spec doesn't specify which pane to capture in multi-pane sessions. Need to confirm `captureOutput()` targets the Claude Code process pane specifically.

**Node.js timer management**: The per-topic `Map<topicId, PresenceState>` with individual timers is the standard pattern. The watermark-based restart recovery approach is well-established and what the spec implies but doesn't fully specify.

---

## Critical Issues

### 1. Proxy messages will clear StallDetector's injection tracker (HIGH)

`POST /telegram/reply/:topicId` calls `ctx.sessionManager.clearInjectionTracker(topicId)` unconditionally (routes.ts line 3155). Proxy messages through this endpoint will reset StallDetector's timer — directly contradicting the spec's "proxy messages do NOT count as agent responses for StallDetector" requirement. This would cause StallDetector to silently skip intervention when the agent is genuinely stuck, because the proxy message restarted its cooldown.

**Fix**: Add `{ "isProxy": true }` to the reply body and skip `clearInjectionTracker()` when set. Or create a dedicated internal send path.

### 2. Rapid message reset doesn't invalidate tier completion state (MEDIUM)

When a new user message arrives mid-sequence, `userMessageAt` resets but `tier1FiredAt`/`tier2FiredAt`/`tier3FiredAt` are not cleared in the spec's state model. Tier 2's trigger logic ("Tier 1 already fired → 2 minutes since user message") would fire immediately if Tier 1 had already fired before the message reset. All tier-fired timestamps must reset together with `userMessageAt`.

---

## Technology Choices: Well Chosen

Haiku for Tiers 1-2 (correct — low latency needed for 20s trigger), Sonnet for Tier 3 (correct — deeper reasoning), `ClaudeCliIntelligenceProvider` (smart — no extra API keys, existing abstraction), `SessionManager.captureOutput()` (correct — reusing tested primitive), `message:logged` EventBus (correct — already typed and emitted).

One concern: the spec says the provider "falls back gracefully if CLI is unavailable" but this needs explicit `try/catch` with `DegradationReporter` usage, consistent with `StallTriageNurse` and `SessionActivitySentinel` patterns.

---

## System Design: Mostly Sound

The additive relationship is architecturally correct:
- User message → `message:logged` → PresenceProxy starts timers + StallDetector (unchanged)
- Agent reply → `message:logged` (fromUser: false, source != 'presence-proxy') → both cancel

The `MessagingEventBus` is the correct integration point. However, the spec references `onMessageInjected` which doesn't exist in the codebase — the actual pattern is subscribing to `message:logged` filtered by `fromUser: true`. This needs alignment.

---

## API Design: Good with One Extension Needed

The `/telegram/reply/:topicId` metadata extension is clean and backward-compatible. However, `MessageLoggedEvent` in `MessagingEventBus.ts` doesn't have a `metadata` field. The `source: 'presence-proxy'` needs to propagate through the event so StallDetector can filter on it.

The user command interface is well-designed. Natural language detection for "yeah go ahead and unstick it" is the right call — a lightweight Haiku intent classifier is better than regex matching.

---

## Data Architecture: Appropriate

`PresenceState` is well-structured. Ephemeral `conversationHistory` in-state (not persisted) is correct. Additions needed:
- Add `tier3Summary: string | null` alongside `tier3Assessment` — storing only the classification loses diagnostic context
- Add auto-GC after ~1 hour for states past Tier 3 with no restart command issued (prevents memory leaks)

---

## Integration Points: Well-specified

The four integration points (StallDetector, SessionManager, TelegramAdapter, StallTriageNurse) are correct. On StallTriageNurse: verify that `trigger: 'manual'` still writes a triage record (which activates the cooldown). The spec says to bypass cooldown for manual triggers — this is correct — but the cooldown write must still happen to prevent the auto-triage from triggering a second attempt.

---

## Operational Concerns

Process tree as authoritative signal is correct — `ps` is not subject to LLM hallucination. The long-running process whitelist should be in config, not hardcoded.

**Gap**: LLM latency vs cancellation. If the agent replies at 22s, the in-flight Haiku call is wasted. Investigate whether `ClaudeCliIntelligenceProvider` supports subprocess abort via `AbortController` or process kill.

**Gap**: Startup recovery path is underspecified. A `PresenceProxy.recoverFromRestart()` method called from server init is the right pattern.

---

## Complexity Budget: Within Budget

Core (Tiers 1-3 + cancellation + logging): ~300-400 lines, Medium complexity. Add conversation mode: Medium-High. Both are within scope, but conversation mode should be Phase 2 if timeline is tight.

---

## Evolution Path: Strong Foundation

- Multi-platform: pattern works for WhatsApp once it emits comparable events
- `source: 'presence-proxy'` metadata enables analytics on proxy effectiveness
- `quiet` command + `silencedUntil` lays groundwork for persistent per-user silence prefs
- Prefix config can evolve to full per-agent persona customization

---

## Recommendations

1. Fix `clearInjectionTracker()` bypass for proxy messages (Critical Issue 1)
2. Reset all tier-fired timestamps when `userMessageAt` resets (Critical Issue 2)
3. Use `DegradationReporter` for LLM failures — consistent with existing monitoring patterns
4. Add `tier3Summary: string | null` to `PresenceState` for diagnostics
5. Add state GC for terminal states (auto-clear after 1 hour post-Tier-3)
6. Specify `PresenceProxy.recoverFromRestart()` in the architecture section
7. Align `onMessageInjected` reference to actual `message:logged` EventBus pattern
8. Verify `captureOutput()` targets the Claude Code pane in multi-pane sessions

---

## Observations

- "Proxy speaks ABOUT the agent, not AS the agent" must be enforced at the prompt level explicitly
- Edge Case 9 (parsing "yeah go ahead and unstick it") should use a dedicated intent classifier call, not piggyback on the conversational LLM call
- The spec is unusually complete for a first-round document — most edge cases are pre-covered

---

## Scalability Assessment

Scales well within operating parameters. Each unanswered topic generates at most 3 LLM calls and 1-3 messages. In-memory state is appropriate for single-machine operation; externalization would only be needed for multi-machine Telegram sharing, which isn't the current architecture.

**Strong design with correct technology choices. Minus 1 for the `clearInjectionTracker` correctness bug. Minus 1 for underspecified startup recovery. Both fixable before implementation begins.**
