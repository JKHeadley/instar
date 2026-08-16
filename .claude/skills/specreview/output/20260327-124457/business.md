# Business Model Review — Presence Proxy

**Review ID**: 20260327-124457
**Reviewer**: Business Strategy
**Score**: 8.5/10
**Approval Status**: CONDITIONAL (APPROVED WITH CONDITIONS)

---

## Problem-Solution Fit (Strong)

The 20s → 2min → 5min tier model maps precisely to how humans psychologically escalate concern about a non-responsive agent. The current 5-minute jump-to-triage has no informational middle ground. The spec fills this correctly.

## Target Market (Clear, Narrow by Design)

Developers running persistent Claude Code agents via Instar communicating over Telegram. Acute pain for this audience. Self-targeting — the proxy only activates on delays over 20 seconds, so casual users never see it.

## Competitive Landscape (Low Direct Competition)

No direct competitor implements tmux-session-awareness + stall detection + LLM-generated status + Telegram delivery in one integrated system. Telegram typing indicators (`sendChatAction`) are the closest analog — but they max at 5 seconds, require constant reposting, and are widely reported as broken in production. Hermes Agent and OpenClaw are broader Telegram-integrated agent frameworks but lack this level of session introspection.

## Revenue & Sustainability

Feature runs at near-zero marginal cost using the Claude CLI subscription (no separate API key). Risk: if CLI usage becomes metered, Tier 3 (Sonnet) cost exposure is real. No fallback behavior specified for that scenario.

## Sleeper Finding

The "proxy conversation mode" — where the proxy holds an intelligent meta-conversation about what the agent is doing — is the most differentiated part of this spec. It's currently buried in implementation step 5. It deserves elevated positioning.

---

## Critical Issues

1. **Cost model edge cases unspecified** — What if rate-limited mid-tier-sequence?
2. **Quiet preferences are session-scoped only** — No persistent user preference
3. **Server restart recovery** (edge case 4) described but not designed
4. **Multilingual users** get English-only proxy messages

---

## Recommendations

1. Define graceful degradation at each tier independently
2. Add persistent quiet preferences (survive across sessions)
3. Elevate conversation mode in product positioning — it's the differentiator
4. Add language detection to LLM prompts
5. Add a `tier3Enabled` config flag with cost warning for API key users

---

## Scalability Assessment

- **Phase 1 (MVP)**: Feature runs at near-zero cost, high value for single-user setup
- **Phase 2 (Growth)**: Multi-agent deployments multiply LLM call volume — need budgeting
- **Phase 3 (Scale)**: Conversation mode becomes a product in its own right
- **Viral spike**: Not applicable — per-agent feature, doesn't have network effects
