# Marketing Review — Input Relay

**Review ID**: 20260327-230839 | **Round**: 1
**Reviewer**: Marketing & Positioning
**Score**: 7.5/10
**Approval Status**: APPROVED WITH REVISIONS

---

## Research Findings

- "Human-in-the-Loop" (HITL) is the dominant industry term. Products like HumanLayer, Relay.app, HITL Relay have productized this pattern.
- Microsoft, LangGraph, and OpenAI all use "interrupt" as the technical verb for pausing execution awaiting human input.
- Key market gap: most HITL tools require code instrumentation. Instar's Input Relay is reactive and automatic — fires on live session state with zero instrumentation, delivered via mobile Telegram. This differentiator is absent from the current name.

---

## Name Analysis

### Current: "Input Relay"
- "Input" is low-status technical word evoking stdin, not intelligence or control
- "Relay" is passive — a pipe, not a guardian
- Reads like an internal module name, not user-facing

### Alternative Names

1. **Agent Tap** — "Tap in" when your agent needs you. Phone-native, lightweight.
2. **Live Gate** — Real-time gate when agent hits a decision it can't make alone. Echoes PromptGate.
3. **Session Interrupt** — Maps to LangGraph's `interrupt()` vocabulary. Dev-friendly.
4. **Presence Ping** — Builds on PresenceProxy. Active and urgent. Risk: "ping" may read casual for security-sensitive approvals.
5. **AgentWatch** — Positions user as supervisor. Risk: too broad.

**Recommendation**: Keep "Input Relay" internally. Use **"Live Gate"** or **"Presence Ping"** in user-facing surfaces.

---

## Critical Issues

1. **Name-value mismatch** — Feature solves agents silently blocking for hours. Name conveys none of that urgency or "control from your phone" capability.
2. **"Tier 0" is internal framing** — Never expose to users. Lead with the user story.
3. **No explicit competitive differentiation** — Automatic detection, zero instrumentation, Telegram delivery. Most HITL tools require agent code changes. Instar doesn't. Front-and-center.
4. **Timeout UX is undermarketed** — 10-min reminder and 30-min escalation are trust-building features. Surface in marketing.

---

## Recommendations

1. Lead with the pain: "Your agents never get stuck waiting for you — they reach you wherever you are."
2. Differentiation hook: "Unlike HITL tools that require code instrumentation, Instar detects blocked sessions automatically."
3. Mobile-first angle: No enterprise HITL competitor leads with mobile-native delivery.
4. Trust/safety angle: "Every approval is logged. Nothing runs without your explicit decision."

---

## Observations

- Message format examples read like finished product copy — launch-ready
- LLM context generation ("explains WHY it's asking, not just WHAT") is a genuine differentiator
- The "never mind" auto-resolution message signals a live, aware system — demo-worthy
- This is a retention/lock-in feature, not acquisition. Users who experience it won't go back.

---

## Scalability Assessment

- Telegram-only limits reach. Acknowledge Slack/email as future channels.
- Natural Pro-tier feature if Instar moves to tiered pricing.
- Low organic virality — growth via word-of-mouth from devs who've had sessions block silently.
