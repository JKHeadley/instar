# Marketing Review — Presence Proxy
**Review ID**: 20260327-124457 | **Round**: 1 | **Reviewer**: Marketing Strategy & Brand Positioning

---

## Approval Status

**CONDITIONAL APPROVE** — The concept is market-ready and solves a real, felt pain point. The name needs work. The messaging has the right instincts but undersells the emotional core of the feature. Ship it, but rename it before any external positioning.

---

## Research Findings

### How AI agent platforms market their monitoring features

The 2025–2026 competitive landscape for AI agent observability is crowded at the infrastructure layer (Arize, LangSmith, Langfuse, Maxim, Helicone) but almost entirely focused on **developer telemetry** — traces, evals, token counts, latency metrics. None of these platforms address the *human experience* of waiting for an agent.

The messaging in this space is uniformly technical: "observability," "tracing," "evaluation pipelines," "semantic conventions." The market has optimized for developer dashboards, not for the person on the other end of a Telegram conversation wondering if their agent is dead.

Key finding: **there is no major player marketing around the emotional experience of agent downtime.** This is a gap. Presence Proxy lives in this gap.

### Naming conventions for "presence" in tech

"Presence" as a product term has strong, established precedent:
- **Slack**: Uses "presence" internally in its API (`presence_sub`, `presence_change`) but surfaces it to users as simply "active/away" with a green dot. The word "presence" is infrastructure vocabulary, not user-facing brand vocabulary.
- **Discord**: Rich Presence is a developer-facing integration protocol — again, infrastructure, not brand.
- **Genesys / Zendesk**: "Agent presence" in contact centers refers to agent availability routing — availability, not activity.
- **WebRTC / SIP protocols**: "Presence" is a well-defined protocol concept (RFC 3856), associated with availability signaling.

The term "presence" has strong technical credibility but weak consumer resonance. It evokes the question "present as in here, or present as in active?" — an ambiguity that costs cognitive cycles.

### Competitive framing for agent monitoring tools

The observability tools space frames itself around **reliability and trust for engineering teams**. Instar's Presence Proxy operates in a fundamentally different frame: **trust and transparency for individual users** who have a personal relationship with their agent.

This is not a DevOps story. It's a relationship story. No competitor is telling this story.

---

## Name Analysis

### Current Name: "Presence Proxy"

**Strengths:**
- "Presence" correctly signals the feature intent — representing the agent when it can't speak for itself
- "Proxy" is technically precise — it's standing in, not replacing
- Sounds professional and architectural

**Weaknesses:**
- "Proxy" reads as infrastructure jargon to a non-technical audience; creates associations with VPNs and network routing
- The combination is forgettable — it describes the mechanism, not the benefit
- "Presence" is overloaded in tech (presence detection, WebRTC presence, social media presence)
- Doesn't evoke the emotional core: *you're not alone, your agent is thinking*
- Hard to make conversational: "the presence proxy told me..." sounds awkward in natural speech

**Score: 5/10** — Accurate, forgettable.

### Alternative Names

1. **Standby** — Clean, immediately understood. "Standby mode," "echo is on standby," "standby update." Evokes readiness without implying failure. Works as a noun, verb, and adjective. Consumer-friendly.

2. **Pulse** — Living, heartbeat connotations. "Echo's pulse shows it's deep in a refactor." Implies the agent is alive and working. Short, memorable, easy to speak. Risk: overused in health-tech.

3. **Relay** — Echo is relaying status. Technically precise, cleaner than "proxy." "The relay sent an update." Better consumer vocabulary. Slight risk of SMS/network associations.

4. **Watch** — As in, keeping watch while you're busy. "Echo Watch: currently running your test suite." Simple, warm, implies care. Pairs well with the telescope emoji already in the spec.

5. **Deputy** — The agent's stand-in, actively representing. More personality than "proxy." "Deputy: Echo is heads-down on the stall detector." Implies agency and competence rather than just message forwarding. Distinctive enough to be memorable.

**Recommendation**: Use **"Standby"** for the internal module name and user-facing feature label. Reserve "Presence Proxy" for technical documentation. If more personality is desired, "Deputy" is the strongest brand choice.

---

## Critical Issues

### 1. The feature has no external name — it inherits internal jargon

The spec uses `🔭 [Presence]` as the message prefix. This is the first thing users will see, and it's already the internal module name bleeding into the UX. Users will call this feature whatever the prefix says. "Presence" as a consumer label is weak.

**Recommendation**: Decide on the consumer name before implementation locks in the prefix. Change `🔭 [Presence]` to whatever the final name is — this is a 2-minute change with long-term brand consequences.

### 2. The "proxy" framing positions this as a messenger, not a collaborator

The spec correctly identifies "Proxy Conversation Mode" as a key capability — the proxy isn't just a status reporter, it's a conversational stand-in. But the name "Proxy" understates this. A proxy is passive; a deputy, relay, or watch is active.

The conversational mode is the most emotionally resonant part of this feature. The name should point at that, not at the message-forwarding infrastructure.

### 3. No narrative for why this exists

The spec is technically thorough but has no founding story. The marketing narrative is implicit: "silence is indistinguishable from the session being dead." That one line — buried in the Problem section — is the entire emotional pitch. It deserves to be the headline.

---

## Recommendations

### Naming
- Rename to **"Standby"** (clean, universal) or **"Deputy"** (personality-forward)
- Change the message prefix from `🔭 [Presence]` to `🔭 [Standby]` or `🔭 [Deputy]`
- Keep "PresenceProxy" as the TypeScript class name — internal names don't need to be marketable

### Messaging Pillars

Three core messages to build around:

1. **Silence is broken.** Before this feature, waiting meant not knowing. Now waiting means being informed. This is the paradigm shift.

2. **Your agent is never unreachable.** Even deep in a three-hour refactor, your agent has a voice — Standby speaks on its behalf.

3. **Designed to never interrupt real work.** The feature's #1 design principle (never misdiagnose a working session as stuck) is also a marketing differentiator. Competing tools trigger false alarms. This one is biased toward trust.

### Launch Positioning

Position Presence Proxy/Standby as an **agent trust primitive** — not a monitoring feature. The market frames monitoring as something engineers do to systems. Standby is something an agent does for its user. That's a fundamentally different relationship metaphor.

Suggested launch copy: *"When Echo is deep in work, Standby keeps you informed — so silence never means uncertainty."*

### Go-to-Market

- **Demo-first**: A screen recording showing the Tier 1 to Tier 2 to Tier 3 escalation in real time, with a real coding session running in the background, is more compelling than any written description. The telescope updates appearing in Telegram while tmux scrolls code in the background is immediately intuitive.
- **Contrast with the old experience**: Show a before/after. Before: 5-minute silence, then a triage interrupt. After: 20s gentle update, 2min progress report, 5min intelligent assessment.
- **The "quiet" command is underrated**: The ability to silence the proxy for 30 minutes signals respect for user attention. Highlight this — it shows the system knows when to shut up.

---

## Observations

- The telescope emoji (🔭) is an excellent choice. It's visually distinct, semantically appropriate (watching from a distance), and doesn't appear in standard notification UIs. It will immediately identify Standby messages in a Telegram thread.
- The spec's "Proxy Conversation Mode" is the feature's sleeper hit. The ability for the stand-in to hold an intelligent conversation — with personality distinct from the agent — is genuinely novel. No competitor does this. It deserves its own marketing moment.
- The tiered design (20s, 2min, 5min) is elegant and intuitive. Users will internalize the cadence quickly. This is good UX marketing — the product explains itself through use.
- The "never interrupt real work" principle (Section: Critical Design Principle) is a strong trust signal. It should be surfaced in any external description of the feature.
- Cost-zero framing (uses existing Claude CLI subscription, no API key required) is a meaningful differentiator for individual developers and solo operators who are already Instar's core audience.

---

## Competitive Framing

Instar's Presence Proxy does not compete with Arize, Langfuse, or Datadog. Those are **engineering observability** tools. Presence Proxy is **personal agent transparency** — a category that does not yet have a name.

The closest analogues are:
- **Slack's "Active/Away" indicator** — but that's binary, passive, and human-generated
- **Zendesk/Genesys "Agent Status"** — but that's for managing contact center routing, not for the relationship between one person and their personal AI

The competitive advantage to market: *this is the first feature that treats an AI agent's communication blackout as a relationship problem, not a systems problem.*

---

## Virality and Word-of-Mouth

The Tier 1 and Tier 2 messages have natural shareability — they're specific, intelligent, and occasionally striking. A user screenshot of:

> "🔭 [Standby] Echo is currently 47 tests into your test suite and making steady progress. Still working on your auth module request."

...appearing in a Telegram chat while a tmux pane scrolls autonomously is the kind of thing developers post. It shows the agent is real, doing real work, and thoughtful enough to keep you in the loop.

The `quiet` command is quietly important for virality: it signals the system is smart enough to know when *not* to talk. That's a maturity signal that earns trust and generates word-of-mouth among people who are tired of noisy AI systems.

---

## Scalability Assessment

**Brand scalability**: The name "Presence Proxy" doesn't scale beyond Instar's current Telegram-first interface. If Instar adds WhatsApp, Slack, email, or voice interfaces, "Presence Proxy" will need to be explained each time. "Standby" or "Deputy" works across all channels without reinterpretation.

**Feature scalability**: The tiered model (20s to 2min to 5min) is a framework, not a fixed feature. It scales to multi-agent scenarios, multi-channel deployments, and eventually to proactive status broadcasting (not just response to silence). The naming should anticipate this.

**Narrative scalability**: "Agent transparency" as a category framing is extensible. Today it's Telegram status updates. Tomorrow it's a unified agent health dashboard, multi-agent coordination visibility, and audit trails for regulated industries. The founding story should be written broad enough to contain those futures.

---

## Score: 7.5 / 10

| Dimension | Score | Notes |
|-----------|-------|-------|
| Product-Market Fit | 9/10 | Solves a real, felt pain point with no direct competitors |
| Naming | 5/10 | Accurate but forgettable; proxy jargon is a liability |
| Messaging Clarity | 7/10 | Strong instincts, undersells the emotional core |
| Differentiation | 9/10 | Genuine white space in the market |
| Launch Readiness | 7/10 | Needs name decision and a demo asset before external launch |
| Virality Potential | 8/10 | The output messages are naturally shareable |
| Brand Longevity | 6/10 | "Presence Proxy" will need renaming as Instar scales |

**Overall: 7.5/10** — A well-designed feature entering uncrowded market territory, held back only by naming that doesn't match the ambition of what it actually does.
