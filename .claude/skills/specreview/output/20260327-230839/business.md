# Business Model Review — Input Relay

**Review ID**: 20260327-230839 | **Round**: 1
**Reviewer**: Business Strategy
**Score**: 7.5/10
**Approval Status**: APPROVED WITH CONDITIONS

---

## Research Findings

- **Claude Dispatch** (launched March 2026) solves the same core problem natively — Anthropic's own solution for remote agent interaction. Window to ship this as a differentiator is narrow.
- Community-built Claude Code Telegram bridges already exist, confirming real user demand for mobile agent control.
- AI agents market growing at 46.3% CAGR — good timing for the category overall.
- HumanLayer, n8n, and Microsoft Agent Framework all support multi-channel relay patterns.

---

## Critical Issues

### 1. Market timing pressure
Anthropic's Claude Dispatch solves the same core problem natively. The window to ship this as a differentiator is narrow. Must ship fast or explicitly position against Anthropic native (frame as "Telegram-first" for users who live in Telegram).

### 2. No monetization model
The spec is silent on economic value framing — is this a retention play? Premium tier feature? Needs positioning.

### 3. Response latency risk — no safe fallback
"No auto-action ever" means hung sessions when users are unavailable (sleeping, offline). There's no safe fallback behavior for when the human can't respond.

---

## Recommendations

1. Ship fast or explicitly position against Anthropic native
2. Add configurable safe-defaults (auto-reject/auto-approve/suspend) for unavailable users
3. Quantify relay event frequency before building the full LLM context pipeline
4. Build the message formatter as channel-agnostic from day one (supports future WhatsApp, Slack, etc.)
5. Add notification batching to prevent spam when multiple prompts queue up

---

## Scalability Assessment

- **MVP**: Strong value for single-user agents on Telegram
- **Growth**: Multi-channel support needed (WhatsApp, Slack)
- **Scale**: Notification spam risk with multiple agents/sessions
- **Viral**: Category validation strong (46.3% CAGR), but Anthropic native competition is the main risk
