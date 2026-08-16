# Business Review: Input Gate (Session Prompt Bridge)
**Review ID:** 20260320-104716
**Round:** 2
**Reviewer Role:** Business Strategy & Product-Market Fit
**Date:** 2026-03-20
**Spec:** `/Users/justin/.instar/agents/echo/specs/session-prompt-bridge.md`

---

## Approval Status

**APPROVED** — Proceed to implementation.

This feature addresses a genuine, documented friction point that directly limits Instar's core value proposition. The business case is clear, the timing is urgent given the competitive landscape, and the opt-in safety posture protects trust during rollout.

---

## Research Findings

### The Competitive Shift (February 2026)

Anthropic shipped Claude Code Remote Control in February 2026 as a research preview. This is the most significant competitive development directly relevant to this spec. Key findings:

- **Claude Code Remote Control** connects claude.ai/code and the Claude iOS/Android apps to a local Claude Code session via WebSocket sync. It provides a mobile-native UI for approvals and instruction-sending.
- It explicitly handles the **same problem** this spec targets: users switching from terminal to phone to handle approvals mid-session.
- It requires a **Pro or Max subscription** and is opt-in by default on Team/Enterprise.
- Limitation noted: users still need to approve actions — Remote Control does not auto-approve.

### The Telegram-First Positioning

Research confirms a growing ecosystem of Telegram-based AI agent interfaces:
- **OpenClaw** (171k GitHub stars as of early 2026) uses Telegram + inline keyboards for AI control, including "Regenerate," "Continue," and "Switch Model" buttons — a pattern nearly identical to what Input Gate proposes.
- **Claude-Code-Remote** (open source) allows controlling Claude Code via email, Discord, and Telegram, with task completion notifications and command-reply flows.
- **n8n + Telegram** inline keyboard integrations are documented as of January 2026 for dynamic approval flows.

### Instar's Market Position

Instar's Hacker News launch framed it as "persistent autonomy infrastructure" — Claude Code with scheduled jobs, session management, Telegram integration, and self-directed agent growth. The key differentiator is Telegram-first mobile control for users who want always-on agent infrastructure without Anthropic's subscription tier requirements or claude.ai dependency.

### Verdict on Competitive Timing

Claude Code Remote Control's launch makes Input Gate **more urgent, not less**. The official Anthropic solution requires claude.ai/Pro subscription and routes through Anthropic's servers. Instar's Telegram-based Input Gate offers:
1. Works without Anthropic account upgrades
2. Works in the background without a browser session open
3. Configurable auto-approval (which official Remote Control explicitly does not offer)
4. Audit log and per-topic overrides — not available in the official tool

---

## Problem-Solution Fit

**Strong.** The problem is concrete: a Telegram user starts a session, Claude hits a permission prompt, the session blocks silently, the user has no idea why. This is a session-killing failure mode, not an edge case.

The solution directly closes the loop: detect -> classify -> relay -> respond. Each component maps cleanly to a specific failure point in the current flow.

What's working:
- The problem statement is crisp and non-hypothetical. It describes exactly what happens today.
- The scope is correctly bounded. Partial streaming output and session management commands are explicitly out of scope.
- The stall safety net is good engineering conservatism — it catches what pattern matching misses.
- Opt-in auto-approve is the right default. Users need to build trust in the detection quality before handing over autonomous approval authority.

One concern: the spec conflates two distinct user problems:
1. **Permission prompts** (Claude Code tool confirmations) — high-frequency, usually safe, good candidates for auto-approval
2. **Clarifying questions** (Claude asking the user something) — qualitatively different, always needs human judgment

These have very different UX implications. The spec handles them separately in the pattern catalog, but the feature name "Input Gate" bundles them together in a way that may create user confusion about what the feature does. A clearer mental model (two modes: auto-gate for permissions, relay for questions) would help with user education.

---

## Target Market

**Primary:** Instar users who run Claude Code agents via Telegram on mobile. This is the entire Telegram integration user base — not a subset.

**Profile:** Developers who have set up Instar specifically because they want persistent, always-on agent capability they can check from their phone. They are already comfortable with Telegram as a control interface. They are likely not paying for Claude Pro/Max (or prefer to keep agents off Anthropic's server infrastructure).

**Secondary:** Users who run long-horizon agentic tasks and step away from their machine. Input Gate converts a "check back in 20 minutes and it did nothing" failure into a "respond from your phone in 10 seconds" success. This directly expands the useful task horizon for Instar agents.

**Market size:** Telegram has ~1 billion monthly active users. The developer + AI agent intersection is a small but fast-growing segment. Instar's addressable market is developers who want CLI-grade control with mobile accessibility — a positioning that Remote Control does not fully satisfy (Remote Control requires a browser or the Claude app, not a messaging app you already have open).

---

## Competitive Landscape

| Solution | Approach | Requires | Auto-Approve | Audit Log |
|----------|----------|----------|--------------|-----------|
| **Instar Input Gate** | Telegram inline buttons + pattern detection | Instar + Telegram | Yes (opt-in) | Yes |
| **Claude Code Remote Control** | claude.ai / Claude app WebSocket sync | Pro/Max subscription | No | No |
| **OpenClaw** | Telegram inline keyboards | Self-hosted server | No | No |
| **Claude-Code-Remote** | Telegram/email/Discord relay | Self-hosted Node.js | No | No |
| **Dashboard (existing Instar)** | Browser-based button bar | Local/tunnel access | No | No |

**Instar's durable differentiators:**
1. Auto-approve with configurable rules — nobody else offers this
2. Per-topic overrides — granular control per agent context
3. Audit log with rotation — production-grade accountability
4. Stall safety net — fallback for undetected prompts
5. Full integration with Instar's existing coherence gate and external operation gate

**The threat from Claude Code Remote Control:** If Anthropic adds auto-approve to Remote Control (plausible, it's a research preview), Instar's advantage narrows. However, Telegram-first users are a sticky audience — they've already integrated Telegram into their workflow and are unlikely to switch to a browser-based flow for approvals.

---

## Revenue & Sustainability

This is an internal platform feature, not a standalone product. The relevant business question is: does this feature increase Instar's retention and word-of-mouth sufficiently to justify implementation cost?

**Yes, for three reasons:**

1. **Churn prevention:** Silent session stalls are the most frustrating Instar failure mode. Users who hit this repeatedly will stop using Telegram-based agent workflows. Input Gate directly prevents this churn.

2. **Capability expansion:** With Input Gate, users can run sessions that require interactive decisions while away from their machine. This unlocks a class of tasks (long-horizon research, code review loops, file manipulation workflows) that were previously impractical via Telegram.

3. **Differentiation narrative:** "Your agent can ask you questions on your phone and you tap a button to continue" is an extremely clear, compelling demo. It's the kind of thing that gets shared on Hacker News and developer communities. The spec's happy path scenarios are essentially already written as demo scripts.

Implementation cost is moderate — four new components plus TelegramAdapter extension. The phased build plan is well-structured and each phase delivers standalone value.

---

## Network Effects

Instar does not have strong direct network effects (more users does not make it better for existing users). However, there are indirect effects:

- **Social proof:** Users sharing "my agent texted me a question while I was in a meeting and I approved it from my phone" builds organic awareness.
- **Integration stickiness:** Once users have Telegram-based approval flows embedded in their workflow, switching costs rise significantly.
- **Multi-agent future:** The spec correctly notes that InputDetector/InputClassifier/AutoApprover are channel-independent. If Instar expands to Slack, WhatsApp, or email adapters, the core classification logic reuses cleanly. This is a foundation, not a one-off.

---

## Go-to-Market

Because this is a platform feature, GTM is internal rollout rather than external launch. Key considerations:

**Rollout sequencing:**
- Phase 1-2 (detector + auto-approver) are invisible to users. Ship quietly.
- Phase 3 (Telegram relay) is the user-visible moment. This should be announced with a demo video or GIF showing the before/after flow.
- Phase 4 (dashboard indicators, audit log viewer) rounds out the feature for power users.

**User education challenge:** Users need to understand the distinction between auto-approved prompts (invisible) and relayed prompts (they see a Telegram message). The post-session digest (Phase 4) is good, but consider an onboarding message the first time Input Gate relays a prompt: "Your agent asked for your input. Here's how this works..."

**Documentation need:** The per-topic override config (`topicOverrides.autoApproveAll`) is powerful but non-obvious. It needs clear docs and ideally a conversational command: "always auto-approve in this topic" should configure it without requiring JSON edits.

---

## Risk Assessment

| Risk | Probability | Impact | Assessment |
|------|-------------|--------|------------|
| False positive auto-approval corrupts session state | Low | High | Narrow patterns + 2s debounce + opt-in default adequately mitigates |
| Anthropic extends Remote Control to cover the same ground | Medium | Medium | Instar's Telegram-first positioning and auto-approve remain differentiated |
| Pattern drift as Claude Code updates its prompt formats | Medium | Medium | Acceptable — stall fallback catches misses, pattern catalog is maintainable |
| User confusion between prompt reply and new message | Low | Low | pendingPromptReply priority is correct; clear message formatting helps |
| CallbackRegistry data loss on server restart | Low | Low | Well-handled — stale button message shown, user falls back to dashboard |
| Users enable auto-approve and lose trust on a false positive | Low | High | Audit log + dry run mode enable controlled trust-building before enabling |

**Highest-priority residual risk:** A user enables auto-approve, a false positive fires on output that looks like a prompt (e.g., Claude printing a template that contains "(y/n)"), an unexpected key is injected into the session, and the session produces garbage output. The 2s debounce and ANSI stripping substantially reduce this risk, but the mitigation tracking (last 5 injections, flag unexpected state) described in Section 5 should be treated as required for Phase 2, not optional.

---

## Recommendations

1. **Prioritize the post-session digest (Phase 4).** The audit log solves an accountability problem; the post-session digest solves a trust problem. Users who can't see what was auto-approved will be uncomfortable enabling the feature. Move the digest to Phase 2 or 3.

2. **Add a conversational configuration interface.** "Enable auto-approve for this topic" as a natural language command is more likely to be used than config.json edits. This aligns with Instar's positioning as a conversational agent interface.

3. **Instrument adoption metrics.** Track: (a) how often Input Gate fires vs. stall fallback fires, (b) auto-approve vs. relay ratio, (c) relay-to-response time. These metrics tell you if the pattern catalog is working and if users are actually engaging with relayed prompts.

4. **Clarify the mental model in user-facing messages.** The Telegram relay messages are well-formatted, but consider a one-time explanation: "Input Gate is active. Safe operations are auto-handled; questions and risky operations will come to you here."

5. **Treat pattern drift maintenance as ongoing infrastructure.** Claude Code's prompt formats will evolve. Assign a scheduled task to verify the pattern catalog after each Claude Code release. The stall fallback is a safety net, not a substitute for keeping patterns current.

---

## Observations

- The spec's resolution of the 64-byte Telegram callback limit via CallbackRegistry is clean and correct. This was a genuine technical constraint that could have derailed the Telegram relay design.
- The text reply fallback for clarifying questions (pendingPromptReply) is a simple, correct solution to a tricky routing problem.
- The superseded prompt handling (old prompt updated to "Superseded by new prompt below") is good UX — avoids leaving stale buttons that confuse users.
- The open question about non-Telegram sessions is correctly deferred. The abstraction boundary (relay via adapter interface) is already in place.
- The concurrent prompt queue for multi-session/same-topic workflows is correctly flagged as a v2 concern. The current "last prompt wins" approach is safe for v1.

---

## Scalability Assessment

**Technical scalability:** The 500ms capture loop integration is correct. InputDetector runs on each capture pass — O(N) where N is the number of active sessions. This scales linearly with session count and is not a bottleneck at any plausible Instar deployment scale.

**Pattern catalog scalability:** The single-catalog approach is maintainable for v1. As Claude Code adds new interactive patterns (e.g., new MCP permission types), the catalog will need ongoing updates. A test suite covering each pattern (already specified) makes this safe to extend.

**Multi-agent scalability:** One pendingPromptReply per topic is the binding constraint. If Instar evolves toward multi-session workflows per topic, a queue-based approach will be needed. The spec correctly identifies this as a v2 evolution.

**Operational scalability:** The 10MB log rotation with 3 kept rotations is appropriate. At high auto-approve volume, logs could grow quickly — consider compressing rotated files rather than keeping raw JSONL.

---

## Score

**8.5 / 10**

Strong feature with clear user value, correct competitive timing, and a well-structured phased implementation plan. The opt-in auto-approve default is the right call. The primary gaps are: (1) the post-session digest should ship earlier than Phase 4 to support trust-building, and (2) the conversational configuration interface would significantly increase feature adoption. Neither is a blocker for proceeding.

The competitive arrival of Claude Code Remote Control validates the problem space and makes this feature more urgent. Instar's Telegram-first, auto-approve-capable positioning remains differentiated.

---

*Sources consulted:*
- [Claude Code Remote Control Docs](https://code.claude.com/docs/en/remote-control)
- [Simon Willison on Claude Code Remote Control](https://simonwillison.net/2026/Feb/25/claude-code-remote-control/)
- [3 Ways to Run Claude Code from Your Phone](https://zilliz.com/blog/3-easiest-ways-to-use-claude-code-on-your-mobile-phone)
- [Instar on GitHub](https://github.com/SageMindAI/instar)
- [Instar Hacker News Launch](https://news.ycombinator.com/item?id=47414744)
- [OpenClaw Telegram Setup](https://aifreeapi.com/en/posts/openclaw-telegram-setup)
- [Claude-Code-Remote (GitHub)](https://github.com/JessyTsui/Claude-Code-Remote)
- [Building Dynamic Telegram Inline Keyboards in n8n (Jan 2026)](https://medium.com/ai-mindset/building-dynamic-telegram-inline-keyboards-in-n8n-solving-the-missing-buttons-problem-1ec36fd6397a)
