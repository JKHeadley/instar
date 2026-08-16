# Marketing Review: Input Gate
**Review ID:** 20260320-104716
**Round:** 2
**Spec:** session-prompt-bridge.md
**Reviewer:** Marketing Strategy & Brand Positioning
**Date:** 2026-03-20

---

## Approval Status

**CONDITIONAL APPROVE** — The name "Input Gate" is defensible within the instar ecosystem but carries avoidable cognitive friction. The core positioning is strong; the name itself is the primary concern. The spec's messaging examples are excellent. Recommend accepting the name with a minor messaging refinement, or upgrading to one of the stronger alternatives below.

---

## Score: 7 / 10

Strong feature, strong spec, messaging examples are some of the best in the spec suite. The name is functional but underperforms what the feature actually delivers. The concept of unblocking a stalled AI agent from your phone in seconds is genuinely remarkable — the name should carry that energy.

---

## Research Findings

**"Input Gate" as an existing term:**
The phrase "input gate" has established meaning in electronics and digital logic. In circuit design, an "input gate" refers to the input terminal of a logic gate — it is a passive, structural term. This creates subtle cognitive interference for a technical developer audience. When a developer hears "input gate," the first association is hardware, not software workflow control. The electronics meaning is passive (a receiving terminal); the instar feature is active (a decision and relay system). The metaphor is inverted from the electronics use.

**How competitors name permission/approval features:**
- LangGraph uses `interrupt()` — a functional, verb-first name focused on the mechanism
- OpenAI Agents SDK calls it "human-in-the-loop" — descriptive but verbose, typically abbreviated HITL
- LangChain uses "approval workflows" — enterprise-facing, generic
- Mastra uses "agent approval" — plain, forgettable
- Permit.io talks about "access gates" in the authorization context
- Android uses "Gatekeeper" — a strong noun form that implies an active guardian role

**"Gate" terminology patterns in developer tools:**
"Gate" is widely used in CI/CD (quality gates, deployment gates, security gates). In those contexts, a gate is something that blocks progress until conditions are met — closer to the instar feature's actual behavior. The association is positive for developers.

**Naming patterns that resonate for this problem space:**
The strongest naming in this domain combines a clear subject (what it's about) with an active verb or role metaphor. "Gatekeeper" scores higher than "gate" because it implies agency. Features named after what they prevent resonate: "StallDetector" (already in instar) is honest and specific. Features named after what they enable resonate equally: "unblock," "relay," "intercept."

**No trademark conflicts found** for "Input Gate" as a software product feature name.

---

## Name Analysis: "Input Gate"

**What works:**
- Consistent with instar's existing gate vocabulary (coherence gate, external-operation-gate)
- Technically accurate — it gates on input
- Short, memorable, config-friendly (`inputGate` in JSON)
- Feels like infrastructure, which suits the feature's role

**What does not work:**
- "Input" is the wrong emphasis. The feature's value is not about input — it is about not getting stuck. "Input" foregrounds the mechanism, not the benefit.
- Electronics connotation (logic gate input terminal) is a passive, structural concept. This feature is active: it detects, classifies, routes, and responds.
- "Input Gate" could describe the inverse of what it does. A gate on inputs sounds like something that restricts what enters. This feature enables responses to flow out.
- The name does not communicate mobile/Telegram context, which is the entire differentiator.
- Compared to "coherence gate" (is the agent working on the right thing?) and "external-operation-gate" (external ops are gated), "input gate" is fuzzier. Input from whom? Gating what?

**Fit within the gate family:**
The gate naming convention in instar is strong and worth preserving. The question is whether this feature is better framed as a gate (a blocking/allowing mechanism) or as a relay/bridge (a routing mechanism). The feature does both: it gates on whether to auto-approve or relay, and it relays the prompt to Telegram. The gate framing captures half the feature.

---

## Alternative Names

### 1. Prompt Gate
Keeps the gate family naming, replaces "input" with "prompt" — far more specific and accurate. A "prompt gate" is obviously something that intercepts prompts. Fits naturally: "the prompt gate caught a file creation request." Avoids the electronics passive-terminal connotation. This is the minimal-change option that fixes the main problem with "Input Gate" without breaking the naming convention. Config key: `promptGate`.

### 2. Prompt Relay
Honest, precise, and channel-forward. "Relay" immediately communicates the core action: intercepting a prompt and forwarding it to you. Eliminates the electronics connotation. Scales naturally across Telegram, Slack, email without feeling channel-specific. "Your agent relayed a prompt" is natural in conversation. Risk: "relay" does not imply the classification and auto-approve half of the feature. Config key: `promptRelay`.

### 3. Session Watchdog
Positions the feature as a guardian that watches for trouble (stalls, blocked prompts) and responds. "Watchdog" is a familiar developer metaphor — hardware watchdog timers, watchdog processes — with a clear meaning: something that monitors and responds when things go wrong. Captures both detection and response. Memorable and slightly playful, which suits the Telegram-first audience. Risk: "watchdog" implies monitoring more than interaction, does not convey bidirectional relay. Config key: `sessionWatchdog`.

### 4. InterruptRelay
Combines the mechanism (interrupt — borrowed from LangGraph's `interrupt()`, which is already industry vocabulary) with the channel (relay). Technical, precise, signals familiarity with the agentic AI space. "Interrupt" correctly frames what happens: Claude's session is interrupted pending human input. Strong resonance with developers who know OS/hardware interrupt handling. Risk: two-word compound may feel heavy; "the interrupt relay sent me a message" is slightly awkward. Config key: `interruptRelay`.

### 5. Unblock (or Agent Unblock)
Pure benefit framing. Does not describe the mechanism at all — describes the outcome. "Unblock your agent in seconds." This is the most user-facing name and would work well as the marketing display name for the feature even if the technical config key remains `inputGate`. Could be used in the dashboard, Telegram messages, and documentation while the internal name stays consistent. Risk: too vague for technical documentation; needs a paired technical name. Config key: `agentUnblock` (better suited as a display name than a technical one).

---

## Positioning & Messaging Assessment

**Current positioning statement (from spec):**
> "Input Gate lets Telegram users respond to interactive prompts from their running sessions — so a stalled Claude Code session unblocks in seconds, not hours."

This is excellent. "Stalled... unblocks in seconds, not hours" is a concrete, emotionally resonant contrast. It makes the problem vivid (hours of silent stalling) and the solution immediate (seconds). This one sentence could serve as the feature's tagline and should be the first line of any user-facing documentation.

**The Telegram message formats are the best marketing copy in the spec.** They are context-sensitive, human-readable, and action-oriented:
- "Your agent is waiting — approve or decline:" — friendly urgency
- "Your agent has a question:" — conversational, non-alarming
- "Agent plan ready — do you want to proceed?" — decision-ready framing

These are pitch-perfect for a mobile-first audience managing agents on the go. They should be treated as brand standards, not just implementation details.

**What is missing from the messaging framework:**
There is no onboarding narrative — no "here's what just happened and why" moment for users encountering Input Gate for the first time. The first time a user receives a prompt relay message, it may be surprising. A brief first-time message or in-dashboard tooltip would complete the story.

---

## Target Audience Alignment

The target audience is AI agent operators managing agents via Telegram — technically sophisticated people comfortable spawning Claude Code sessions remotely and trusting them to run autonomously. Their mental model: "I set the agent going, I check in periodically."

**What this audience cares about:**
- Not being surprised by silent failures
- Maintaining control without babysitting
- Fast response from their phone, not their laptop
- Trust: knowing the agent is not going rogue

**How the feature aligns:**
The feature maps directly to all four concerns. Silent stalls are the primary pain point for this audience. Telegram button responses (no context-switching required) are exactly right for mobile-first operators. The opt-in auto-approve posture respects the trust concern.

**Where naming/messaging could do more:**
"Input Gate" does not signal any of these audience-specific benefits. A Telegram-native user would respond more to "your agent will text you when it needs approval" than to "Input Gate is now enabled." The feature's identity in Telegram messages matters more than its internal name — and those messages are already well-written.

---

## Competitive Framing

No direct competitor has this feature in the Telegram-native format. LangGraph has `interrupt()`, OpenAI SDK has HITL flows — but both require developers to implement the approval UI themselves. Instar's Input Gate ships a complete, pre-wired Telegram approval experience: detection, classification, buttons, text reply fallback, timeout reminders, and audit log. This is a full product, not a primitive.

The competitive differentiator worth naming explicitly: **zero configuration for the user.** The feature works automatically when sessions are Telegram-bound. This "it just works" angle is undersold in the current spec positioning and should be featured in any external messaging.

---

## Narrative & Story

The feature has a natural story arc:

1. You are away from your desk. Your agent is working.
2. The agent hits a decision point. Normally: silence.
3. With Input Gate: your phone buzzes. Your agent needs you.
4. You tap a button. The agent continues.
5. Later: a summary of everything it handled automatically.

This arc is a complete narrative that works as a demo script, an announcement post, and a feature walkthrough. The spec's "Happy path: Relayed prompt" section already tells this story technically; it needs a non-technical retelling for external communication.

---

## Virality & Word-of-Mouth Potential

**Natural share moment:** The first time a user gets a Telegram prompt relay message. The UX is surprising and delightful — your phone buzzes with an actionable button from a running agent. This is inherently screenshot-worthy.

**What helps virality:**
- The Telegram message format is clean and distinct — recognizable in a screenshot
- The "unblock in seconds" story is concrete enough to repeat
- Button-based approval is visually compelling in screen recordings

**What hurts virality:**
- "Input Gate" is not repeatable in conversation. "I enabled Input Gate" does not make someone curious. "My agent texted me to approve a file creation" makes someone curious.
- The feature needs a shareable demo path — ideally a short screen recording of the Telegram interaction

---

## Critical Issues

**1. Name emphasis mismatch (non-blocking but significant):**
"Input Gate" frames the feature around the mechanism (gating input) rather than the outcome (getting notified and responding to your agent). For a mobile-first operator audience, outcome framing is more compelling. Not a blocker for shipping, but worth addressing before any external announcement.

**2. No first-use onboarding narrative:**
The spec handles the technical flow well but does not specify what happens the first time a user encounters a relay message. A first-use tooltip or introductory message would reduce confusion and increase trust.

**3. "Auto-approve" label carries risk perception:**
In marketing copy, "auto-approve" sounds like the agent is bypassing the user. Consider "safe actions" or "automatic approvals" as alternative labels in user-facing surfaces. The technical config key can stay `autoApprove`; the display language should be warmer.

---

## Recommendations

1. **Rename to "Prompt Gate"** if staying within the gate convention — or adopt "Prompt Relay" if willing to break from it. Either is stronger than "Input Gate." This is the highest-leverage change available without disrupting architecture.

2. **Adopt the positioning statement as a tagline.** "Stalled sessions unblock in seconds, not hours" should appear in the dashboard, changelog entries, and any announcement.

3. **Protect the Telegram message format as a design standard.** The message templates in section 3.4 are the user-facing brand for this feature. They are excellent and should not be changed casually.

4. **Add a first-use message.** When a user receives their first relay prompt, prepend a brief context line: "Input Gate just caught a prompt from your session. Tap to respond — your agent is waiting." This prevents the first experience from feeling alarming.

5. **Rename "auto-approve" in UI copy to "safe actions."** Keep the config key as-is; change the display label. "Safe actions" is less alarming and more accurate.

6. **Create a demo narrative for launch.** The natural demo: send a message, agent starts working, hits a prompt, phone buzzes, tap button, agent continues. Record this. The visual of Telegram buttons from a running session is the feature's best marketing.

---

## Scalability Assessment

The "gate" naming convention scales well if instar's gate vocabulary is consistently defined:
- Coherence Gate: Is this agent working on the right context?
- External Operation Gate: Is this external action safe to perform?
- Prompt Gate (recommended) / Input Gate: Does this session prompt need human input?

The pattern is clear and composable. Future gates (e.g., an "Output Gate" for reviewing agent responses before sending) would fit naturally. The naming architecture is sound.

The positioning — Telegram-native, mobile-first, zero-configuration — scales as instar adds other messaging channels. The spec correctly anticipates this (the `relayPrompt()` abstraction is channel-agnostic). When Slack or WhatsApp adapters arrive, the feature name and positioning will need minor updates, but the core narrative survives intact.

---

*Review complete. Research conducted 2026-03-20 via live web search.*
