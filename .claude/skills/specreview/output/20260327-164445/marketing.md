# Marketing Review — Instar SlackAdapter Spec

**Review ID**: 20260327-164445 | **Round**: 1 | **Reviewer**: Marketing & Positioning | **Date**: 2026-03-27

## Approval Status: CONDITIONAL APPROVE

### Score: 6.5/10

The DIY architecture is a strong differentiator. But naming, positioning, and go-to-market narrative are absent. Excellent internal engineering document — not yet the foundation of a launch story.

---

## Research Findings

- **Slack's AI play has consumed the narrative.** Salesforce positions Slack as the "agentic operating system" for enterprise, with vetted marketplace agents (Claude, Perplexity, Cohere, Moveworks).
- **OpenClaw is the direct competitor.** Open-source, self-hosted AI agent framework with 250K+ GitHub stars. Core message: "Whether you own the infrastructure or rent it." Nearly identical philosophy to instar — with a massive mindshare lead.
- **The "no shared infrastructure" lane is now crowded.** OpenClaw, Moltworker (Cloudflare), LangGraph, Flowise, Dify all occupy it.
- **Developer tool marketing rewards radical specificity.** Vague "AI agent" positioning is saturated.

---

## Product Naming Analysis

### "SlackAdapter" — Current Name: Grade D
Class name from source code. "Adapter" is enterprise middleware vocabulary. Zero memorability.

### 5 Alternatives

1. **Instar Presence** *(recommended)* — Captures what the feature does: makes the agent present where the user lives. Resonates with Slack's presence API. Generalizes: "Presence for Telegram," "Presence for Discord."
2. **Instar Reach** — Communicates capability expansion. "Instar Reach: Slack" works.
3. **Instar Wire** — Connotes communication, speed, infrastructure. Short and punchy.
4. **Instar Bridge** — Established integration vocabulary without being enterprise-stale.
5. **Instar Channels** — Leverages Slack's vocabulary. Very generic, hard to protect.

---

## Critical Issues

1. **No product name.** "SlackAdapter" is a class name. Must be resolved before external communication.
2. **No differentiation from OpenClaw.** Spec doesn't acknowledge the most direct competitor. Any launch will face this comparison immediately.
3. **Setup wizard is undersold.** The most marketable element is buried in Section 6. Should be the opening hook.
4. **No persona articulation.** The "Slack-Native Developer" persona is the acquisition target — someone whose life runs in Slack who doesn't want to context-switch to Telegram.
5. **The Echo story is missing.** An AI agent that built its own Slack integration is a novel, shareable narrative. Appears nowhere in the spec.

---

## Positioning & Messaging

**Recommended value prop**: "Talk to your AI agent in the tools you already use — without handing your conversations to anyone else."

**The DIY table in Section 1.4 is marketing content in disguise.** Published App vs. DIY comparison is the clearest articulation of instar's philosophy. Surface it in launch copy.

**Best analogy (already in spec)**: "BotFather for Slack, but automated." Developer-legible, lands instantly.

---

## Narrative & Story

**The emotional hook is the disappearance of complexity**: "You used to spend an afternoon creating Slack apps, reading OAuth docs, debugging webhooks. Now you say 'set up Slack' and it's done in two minutes."

**The story nobody else can tell**: Echo built this Slack integration to use on itself. "The AI agent that built its own Slack integration" is shareable and novel.

---

## Competitive Framing

**Instar's defensible differentiation** (inferred, not stated):
1. Setup wizard — zero-config vs OpenClaw's manual setup
2. Deeper platform integration — job scheduler, attention queue, stall detection, prompt gate
3. Claude Code native — purpose-built, not model-agnostic
4. Echo story — agent-built-by-agent; OpenClaw cannot tell this story

---

## Virality & Demo Moments

- **Wizard demo**: Browser opens, automations run, two minutes later messaging the agent from Slack
- **Reaction acks** (👀, ⏳, ✅): Visually distinctive, screenshot-worthy
- **Block Kit Prompt Gate**: Interactive buttons are visually polished

---

## Launch Strategy

1. **Hacker News**: "Show HN: I automated Slack app creation for my local AI agent"
2. **Developer Twitter/X**: 60-second wizard video
3. **r/LocalLLaMA and r/selfhosted**: Natural home for local-first AI tooling
4. **Content**: Before/after comparison (15 manual steps vs 2-minute wizard), philosophy post on token sovereignty, Echo-authored OpenClaw comparison

---

## Scalability Assessment

DIY model and local-first philosophy are genuine long-term differentiators as AI lock-in anxiety grows. OpenClaw competitive gap narrows as their Slack integration matures — window for differentiated positioning is 3-6 months.
