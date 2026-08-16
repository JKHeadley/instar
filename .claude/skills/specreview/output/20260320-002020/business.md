# Business Strategy Review: Input Gate

**Review ID:** 20260320-002020
**Spec:** Input Gate (formerly Session Prompt Bridge)
**Reviewer Role:** Business Strategy & Product-Market Fit
**Round:** 2
**Date:** 2026-03-20
**Prior Round:** 20260319-150852

---

## Round 1 Issue Resolution Summary

Before the full review, a direct accounting of each Round 1 critical issue and recommendation:

| R1 Issue | Status | Notes |
|----------|--------|-------|
| Auto-approve opt-in vs. opt-out (critical) | **RESOLVED** | Opt-in confirmed. `autoApprove.enabled: false` by default. Dry-run mode added. |
| Callback data 64-byte limit (critical) | **RESOLVED** | Server-side CallbackRegistry with 8-char base62 tokens (20 bytes). One-time use, pruned on timeout and restart. |
| Single-topic blocking for concurrent prompts (critical) | **PARTIALLY RESOLVED** | Spec acknowledges the limitation and documents the supersede behavior. Still deferred to v2. Acceptable for v1 given the explicit documentation. |
| Pattern matching vs. hook-based detection (R1 top recommendation) | **NOT ADDRESSED** | Spec retains output-pattern-based detection. Claude Code Channels announcement (March 2026) makes this more pressing — see Research Findings below. |
| Stall fallback raised to 60s | **CONFIRMED IMPROVEMENT** | Up from 30s in R1. Better balance between notification fatigue and stall coverage. |
| Positioning sentence added | **CONFIRMED IMPROVEMENT** | "Input Gate lets Telegram users respond to interactive prompts from their running sessions — so a stalled Claude Code session unblocks in seconds, not hours." Clear, accurate, testable. |
| Per-session digest for auto-approve notifications | **NEWLY ADDED** | R1 noted per-action notifications as too noisy. Spec now documents post-session digest approach. Well-resolved. |

**Net: 3 of 4 critical issues fully resolved. 1 critical recommendation (hook-based detection) remains unaddressed but the landscape around it has shifted materially — see below.**

---

## Approval Status

**CONDITIONAL — ELEVATED**

Round 2 is substantially stronger than Round 1. The two hard blockers (auto-approve default, callback data) are cleanly resolved. The spec is now implementable without deferred trust-eroding decisions. However, a major external development since Round 1 — Anthropic shipping Claude Code Channels — materially changes the competitive calculus and makes the hook-based detection question more urgent, not less.

The conditional status is retained because the pattern-matching detection approach now carries higher strategic risk than it did in Round 1.

---

## Research Findings

### CCGram: Version 0.2.15 (February 2026)

CCGram reached v0.2.15 in February 2026 with improvements to UI robustness and ghost status fixes. Architecturally unchanged from R1: hook-based detection via 7 registered Claude Code hooks (SessionStart, Notification, Stop, SubagentStart, SubagentStop, TeammateIdle, TaskCompleted). No pattern catalog. No ANSI parsing. The hooks fire on semantic events, not terminal output.

The gap in detection robustness between CCGram's hook-based approach and Input Gate's pattern-matching approach has not closed. If anything, CCGram's active maintenance rate (multiple releases in 2026) signals a healthy project rather than a stagnating one.

A second fork — `jsayubi/ccgram` — is now visible in search results, indicating the project is being watched and cloned. This is the signal of a maturing open-source niche.

### Claude Code Channels (March 2026) — NEW, HIGH IMPACT

Anthropic shipped Claude Code Channels in research preview in March 2026. This is the most significant competitive development since R1.

**What it is:** A native MCP-based bridge that pushes external events (Telegram messages, Discord messages, webhooks) into a running Claude Code session. Two-way: Claude reads events and replies through the same channel. Requires Claude Code v2.1.80+ and Bun runtime. Available to Pro and Max subscribers.

**What it does NOT do (yet):** The Channels feature is described as event-pushing — it lets users send messages TO a running session. There is no evidence that it surfaces interactive prompts FROM the session back to Telegram with inline keyboard buttons. Remote Control (browser-based) has mobile controls, but no Telegram-native button relay has been documented.

**Strategic implication:** Anthropic has now entered the Telegram-bridge space natively. The commodity layer (send message → session, session → send reply) is now officially blessed infrastructure. Third-party tools that only do message relay are now competing with Anthropic itself. However, the prompt-detection-and-relay capability (detecting WHEN a session is waiting, formatting the prompt as a structured button message, routing the response back) remains a gap that Channels does not appear to fill.

**Bottom line:** Claude Code Channels raises the floor of what Telegram integration means. Input Gate's differentiation must be above this floor — specifically in the structured prompt detection and response UX. If Channels ships native prompt relay in the next few months, the window narrows sharply.

### Claude Code Remote Control (February 2026)

Remote Control is a synchronization layer between local Claude Code sessions and the Claude iOS/Android app. It enables mobile access to running sessions with "Mobile UI Controls." The documentation describes interactive session management and action approval via mobile app controls.

This is browser/app-based, not Telegram-native. It is a different UX from what Input Gate proposes. However, if Anthropic brings prompt relay into the Claude app with inline-style button UX, Input Gate's Telegram-specific capability becomes a niche preference rather than a capability gap.

**Updated threat timeline assessment:** R1 estimated 12-18 months before Remote Control could subsume this feature. Given that Channels shipped in March 2026, that timeline should be revised to 6-12 months for the full Telegram prompt-relay surface to be officially covered. The window is compressing.

### Human-in-the-Loop Market (2026)

The HITL AI market is projected at $16.4B by 2030, CAGR 24.9%. Gartner forecasts 40% of enterprise applications will embed task-specific AI agents by 2026, up from <5% in 2025. The prevailing enterprise design pattern is "dynamic AI execution with deterministic guardrails and human judgment at key decision points" — which is precisely what Input Gate implements.

The market is moving toward Input Gate's architectural philosophy. This is bullish for the feature's strategic positioning but also means more vendors are building exactly this capability.

### Telegram Bot Ecosystem (2026)

Telegram bot developer tooling has proliferated. The direct competitive set for Claude Code specifically now includes: CCGram (0.2.15), RichardAtCT/claude-code-telegram, jsayubi/ccgram fork, OpenClaw (enterprise-grade multi-agent routing with Telegram), and now Anthropic's own Channels plugin. The space is more crowded than R1 noted.

The ecosystem signal is clear: Telegram is the preferred out-of-band control channel for developers running autonomous AI agents. Instar's choice of Telegram as the primary relay channel is well-validated.

---

## Problem-Solution Fit

**Strong. Unchanged from R1.**

The problem (silent session stalls on interactive prompts, no Telegram visibility) remains real and specific. The two-tier response (auto-approve safe, relay risky) is still the correct architecture. The clarification that auto-approve is opt-in removes the trust risk that tempered R1's assessment.

The addition of the positioning sentence confirms the spec author has internalized the product framing. "Unblocks in seconds, not hours" is a testable claim and a good north star for success metrics.

One refinement: the problem statement now needs to explicitly address how Input Gate differentiates from Claude Code Channels. The spec was written before Channels shipped. A sentence in section 1 acknowledging that Channels enables message-sending but not prompt-routing would sharpen the problem definition.

---

## Competitive Landscape

**Updated from R1:**

| Competitor | Approach | Gap vs. Input Gate |
|-----------|----------|--------------------|
| CCGram v0.2.15 | Hook-based detection, Telegram buttons | No persistent agent infra; pattern detection is more robust than Input Gate's |
| Claude Code Channels (Anthropic) | MCP-based event push, two-way messaging | Does not detect/surface interactive prompts as structured button UX (yet) |
| Claude Code Remote Control | Browser/app sync layer | Not Telegram-native; different UX; may add prompt relay to app |
| RichardAtCT/claude-code-telegram | Lightweight bridge | Less maintained; less featured |
| OpenClaw | Multi-agent routing, enterprise-grade | Not Claude Code-specific; heavier infrastructure |

**The differentiation thesis from R1 holds but is narrowing:**

Instar's moat is integration depth (topic routing, memory, job registry, per-topic overrides, audit log, dashboard indicators) rather than the relay mechanism itself. This is now even more important to communicate clearly because Channels commoditizes the relay mechanism. Input Gate needs to be positioned as "supervised agent control infrastructure," not "Telegram button for prompts."

**The hook-based detection gap has become more strategically important, not less.** CCGram hooks into Claude Code's native event system. Channels is also hook/MCP-based. The industry direction is toward semantically-triggered events, not output parsing. Input Gate's pattern catalog is the only major component in the spec that swims against this tide.

---

## Revenue & Sustainability

Unchanged from R1. This is an internal platform feature; framing is around retention, acquisition signaling, and switching costs.

**New consideration:** With Channels in the market, instar's Telegram capability can no longer be described as novel relay infrastructure. The value proposition must shift to what Channels cannot provide: persistent session memory across restarts, topic-aware routing, relationship tracking, multi-agent coordination, and per-topic override policies. Input Gate contributes to this broader story by adding supervised human-in-the-loop control to an already differentiated platform.

The maintenance burden of the pattern catalog is now the single largest sustainability risk. CCGram and Channels both avoid this problem entirely. If Claude Code changes its prompt format (which it will, as the product evolves), Input Gate breaks in a way that neither CCGram nor Channels does.

---

## Network Effects

Unchanged from R1. Limited direct network effects; indirect effects via shared pattern catalog maintenance.

**New consideration:** If the pattern catalog is published openly (as R1 recommended), the Claude Code Channels announcement may actually drive contributors — developers who want Input Gate-style structured prompt relay but within an instar context. The open pattern catalog becomes a community artifact at the intersection of Channels users and instar users.

---

## Go-to-Market

No external GTM required. Internal considerations updated:

1. **Differentiate explicitly from Channels.** Documentation should acknowledge Claude Code Channels and explain what Input Gate adds (structured detection, classifier, auto-approve, per-topic overrides, audit log) vs. what Channels provides (raw event push). This is the new necessary framing.
2. **"Supervised agent control" positioning.** Lean into the HITL market trend. Input Gate is not a notification tool — it's a governance layer for autonomous agent decisions.
3. **Pattern catalog as community signal.** Publish it. Given the new competitive context, a community-maintained catalog is a meaningful differentiator from Channels (which has no such thing).
4. **Audit log as enterprise feature.** The `input-gate-log.jsonl` with full decision trail is something neither CCGram nor Channels provides. This is a real differentiator for compliance-minded users.

---

## Risk Assessment

| Risk | Severity | Change from R1 | Notes |
|------|----------|----------------|-------|
| Claude Code updates prompt format, breaking pattern catalog | High | Unchanged | Still the primary technical risk |
| Anthropic ships Channels with native prompt relay (button UX) | Critical | Elevated from High | Channels already shipped event push; button relay is the next logical step |
| Pattern catalog maintenance compounds over time | High | Unchanged | Hook-based approach would eliminate this risk |
| CCGram perceived as good enough | Medium | Slightly elevated | CCGram is actively maintained and gaining forks |
| False positive auto-approval erodes user trust | Low | Reduced from Medium | Opt-in default substantially reduces this risk |
| Callback data 64-byte limit | Resolved | — | CallbackRegistry cleanly solves this |
| Single-topic concurrent prompt blocking | Low | Unchanged | Documented limitation; supersede behavior acceptable for v1 |

**The most significant risk update:** Claude Code Channels shipping makes the "Anthropic builds this natively" scenario no longer hypothetical. It is actively happening. The question is whether Anthropic adds the structured prompt-detection and button-relay UX to Channels in the next 6-12 months. If they do, Input Gate's Telegram-facing capability is subsumed. Instar's response should be to (a) ship Input Gate before this happens, and (b) lean harder into the platform-integration depth that Channels cannot replicate.

---

## Critical Issues

**From R1 — resolved:**
1. ~~Auto-approve opt-in framing~~ — RESOLVED
2. ~~Callback data 64-byte limit~~ — RESOLVED
3. ~~Single-topic concurrent prompt blocking~~ — PARTIALLY RESOLVED (documented, deferred, acceptable)

**Remaining from R1:**
4. **Pattern matching vs. hook-based detection (ELEVATED):** This was R1's top recommendation and remains unaddressed. The Claude Code Channels announcement confirms that Anthropic's own architecture is hook/MCP-based. CCGram v0.2.15 is hook-based. The entire industry direction is toward semantic event hooks rather than output parsing. Input Gate's PromptDetector is the architectural outlier. The practical consequence: every time Claude Code ships a UI change, instar ships a pattern catalog patch. This is a permanent maintenance tax on a feature that CCGram and Channels have engineered away entirely. The spec should re-evaluate whether Claude Code's Notification hook (which CCGram already uses) can cover the detection surface before committing to the pattern catalog approach.

**New issues from Round 2:**
5. **No acknowledgment of Claude Code Channels:** The spec was written before Channels shipped. Section 1 (Problem Statement) and Section 9 (Risks) should be updated to reflect that Channels exists and explain what gap Input Gate fills that Channels does not. Without this, the spec reads as solving a problem that Anthropic has now partially addressed, which will confuse readers evaluating whether to invest in implementation.

---

## Recommendations

1. **Re-evaluate hook-based detection before building the pattern catalog** (carried from R1, now more urgent). Check whether Claude Code's Notification hook (which CCGram uses) fires on interactive prompts. If it does, the entire InputDetector pattern catalog can be replaced with a hook handler. This eliminates the maintenance risk, reduces false positives, and aligns Input Gate's architecture with the industry direction Anthropic itself is moving toward.

2. **Update the spec to address Claude Code Channels.** Add a paragraph to Section 1 explaining what Channels does and does not do, and where Input Gate sits above it. This is now required for the spec to accurately represent the competitive context.

3. **Instrument false positive rates from day one** (carried from R1). Define a success threshold (target: fewer than 1% of auto-approve decisions result in unexpected session state) and use this as a Phase 2 to Phase 3 gate.

4. **Publish the pattern catalog as a community artifact** (carried from R1, now more strategically important). Given Channels' arrival, an open, community-maintained detection catalog is a meaningful differentiator.

5. **Audit log as a first-class feature, not an implementation detail.** The `input-gate-log.jsonl` is the only component that provides a persistent, reviewable record of agent decisions. Neither CCGram nor Channels offers this. Elevate it in documentation and consider an API endpoint to query it.

6. **Ship Phase 1 quickly** (new recommendation). The window between now and Anthropic adding button-relay to Channels is 6-12 months. Phase 1 (detection only, no relay) can ship in weeks and starts building pattern catalog data. Don't let the perfect (hook-based detection) block the good (working relay for users today).

---

## Observations

- The rename from "Session Prompt Bridge" to "Input Gate" is a clear improvement. "Input Gate" is concise, action-oriented, and positions the feature as infrastructure rather than a notification pipeline.
- The post-session digest resolution (per-action notifications to session summary) is the right call. It directly addresses notification fatigue without removing transparency.
- The dryRun mode is a thoughtful addition. It lets users build confidence in the classifier before enabling auto-approve, which is exactly the trust-building path the feature needs.
- The relay timeout and multi-prompt supersede behavior are well-specified. Edge cases in this category are easy to overlook and are covered thoroughly.
- The testing strategy in Section 7 is comprehensive. The false-positive tests for code blocks and progress messages are particularly important for production reliability.
- Claude Code Channels signals that Anthropic views the Telegram integration space as worth owning officially. This is both validation (the problem is real) and a warning (Anthropic will eventually cover this surface). Instar's counter is integration depth: the features Channels will never build because they are instar-specific (topic memory, relationship tracking, job registry, audit logging).

---

## Scalability Assessment

Unchanged structurally from R1. Updated note:

The pattern catalog is now the primary scalability bottleneck and also the primary architectural divergence from industry direction. Every other component in the spec scales cleanly: the classifier, the AutoApprover, the CallbackRegistry, the relay adapter, and the Stall Safety Net are all well-bounded. The InputDetector pattern catalog is the single component that requires ongoing human investment to maintain.

If hook-based detection is adopted (Recommendation 1), this bottleneck disappears entirely. The scalability profile of Input Gate becomes excellent across all dimensions.

---

## Score

**8 / 10**

**Change from R1: +1 (was 7/10)**

**Justification:** The two hard blockers from R1 are cleanly resolved. The auto-approve opt-in decision is correct and well-rationalized. The CallbackRegistry is an elegant solution to a hard technical constraint. The stall fallback at 60s is better calibrated. The per-session digest resolves the notification fatigue concern. The spec is now implementable without trust-eroding deferred decisions, and the phased implementation plan allows safe incremental delivery.

The score does not reach 9 because: (1) the pattern-matching detection approach remains architecturally misaligned with both competitors and Anthropic's own direction — this is now a more pressing concern than in R1; and (2) the spec does not yet acknowledge Claude Code Channels, which shipped between R1 and R2 and changes the competitive context materially. A score of 9 is achievable if the hook-based detection question is definitively resolved (either by adopting hooks or documenting why they are insufficient) and the spec is updated to position against Channels explicitly.
