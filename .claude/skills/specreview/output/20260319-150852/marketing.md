# Marketing Review: Session Prompt Bridge
**Review ID:** 20260319-150852
**Round:** 1
**Reviewer Role:** Marketing Strategy & Brand Positioning Specialist
**Spec:** `specs/session-prompt-bridge.md`
**Date:** 2026-03-19

---

## Approval Status

**CONDITIONAL**

The feature solves a real, felt pain point and the architecture is sound. The marketing surface — the name, the framing, and the story the product tells — needs tightening before this ships. The core problem is a naming mismatch: "Session Prompt Bridge" is an implementation description, not a user-facing value proposition. This is fixable without any engineering changes.

---

## Critical Issues

**1. The name describes the mechanism, not the outcome.**

"Session Prompt Bridge" communicates how it works (bridging prompts from sessions to Telegram) rather than what it delivers (unblocking your agent so you can respond from anywhere). Developers and non-technical users alike care about the outcome: the agent stops freezing, you get notified, you tap a button and it continues. The name should anchor to that.

**2. "Bridge" is overloaded in developer tooling.**

Research confirms "bridge" is already heavily used in the ecosystem — cross-chain blockchain bridges, middleware bridge metaphors, and database bridge layers. In the agent orchestration space, the term has no distinctive flavor. It reads as generic infrastructure vocabulary, not a memorable capability name.

**3. The spec's own language is better than its title.**

The spec contains far more evocative phrases in the body copy: "silent freeze," "session stalls silently," "zero visibility," "Session needs your input." These are the hooks. The title "Session Prompt Bridge" throws all of that away in favor of dry technical taxonomy.

**4. No clear positioning sentence.**

There is no one-sentence statement of the value proposition anywhere in the spec. Every feature needs one: who it's for, what problem it solves, why now. This omission makes downstream communication (release notes, dashboard UI copy, docs) harder to write consistently.

---

## Name Analysis

### Current Name Assessment

**"Session Prompt Bridge"** — 4/10

- Accurate but inert. Communicates the mechanism without evoking value.
- Three nouns stacked together read as internal jargon, not a product feature name.
- "Prompt" is overloaded: in 2025-2026, "prompt" primarily means an LLM instruction. Users reading "Prompt Bridge" may think it is about system prompts or prompt management, not interactive terminal prompts waiting for input.
- No memorability or narrative pull.

### Alternative Names (5 options)

**1. Agent Interrupt Relay**
Rationale: "Interrupt" is the established term in LangGraph and broader human-in-the-loop literature — the industry has already converged on this vocabulary. "Relay" clearly indicates messages traveling back and forth. Together they signal: the agent pauses (interrupt) and you are brought in (relay). Developer-legible and precise.
Risk: "Interrupt" reads slightly technical. Acceptable for this audience.

**2. Input Gate**
Rationale: Short, punchy, and accurate. When the agent needs input, the gate opens to you. "Gate" also aligns with the existing external-operation-gate naming already in Instar. Low cognitive load, high recall.
Risk: Could be confused with a security/access control gate. Context mitigates this.

**3. Prompt Intercept**
Rationale: Frames the feature as catching something mid-flight — which is exactly what it does. Slightly more dramatic, suggests vigilance and responsiveness.
Risk: "Intercept" can read as surveillance. Neutral in developer contexts.

**4. Session Handoff**
Rationale: "Handoff" is well-understood in mobile/engineering as the moment control passes from one context to another. Communicates that control moves to the user when the agent cannot proceed alone. Warm and action-oriented.
Risk: "Handoff" might imply the session is being fully transferred rather than temporarily paused.

**5. Live Approval**
Rationale: Aligns with Mastra's "human approval" framing and Microsoft Copilot Studio's "multistage approvals" — the market vocabulary for this problem. "Live" emphasizes it happens in real time via Telegram, not asynchronously.
Risk: Slightly generic. Works best as a subfeature label rather than a standalone feature name.

**Recommendation:** "Agent Interrupt Relay" or "Input Gate" — both are precise, defensible, and distinct from competitive naming. "Input Gate" has the additional advantage of cohering with Instar's existing gate metaphor family (external-operation-gate, coherence gate).

---

## Recommendations

### 1. Add a positioning sentence to the spec header

Before or after the problem statement, add:

> "Agent Interrupt Relay lets Telegram users respond to interactive prompts from their running sessions — so a stalled Claude Code session unblocks in seconds, not hours."

This becomes the source-of-truth sentence for release notes, docs, and any in-app copy.

### 2. Rename the feature config key

The spec proposes "promptBridge" as the config key. Given the naming concerns above, consider "agentInterrupt" or "inputGate". Config keys have surprising longevity — they become API surface, documentation anchors, and user vocabulary. Getting this right now avoids a breaking change later.

### 3. Refine the Telegram notification copy

The spec shows:
  "Session needs your input:"

This is serviceable but generic. Small improvements by prompt type:
- For permission prompts: "Your agent is waiting — approve or decline:"
- For clarifying questions: "Your agent has a question:"
- For plan approval: "Agent plan ready — do you want to proceed?"

Differentiating the copy by prompt type reduces cognitive load. The user understands immediately what kind of decision they are making.

### 4. Give the auto-approve behavior a user-facing name

The spec treats auto-approval as an implementation detail. But "auto-approval" is actually a trust/safety claim worth marketing explicitly. Consider naming it "Smart Auto-Approve" or "Safe-by-Default Approvals" — and making the audit log (prompt-bridge-log.jsonl) visible in the dashboard as a trust artifact: "Here is everything your agent approved on your behalf."

### 5. Reframe the stall safety net notification

"Session appears to be waiting for input" reads as a failure message. Reframe it as a reassurance: "Your agent paused and is waiting for you — tap here to respond." This shifts the tone from alarm to invitation.

---

## Observations

### Market dynamics worth considering

**1. The human-in-the-loop problem is the defining challenge of agentic AI in 2026.**

Every major agent framework — LangGraph (uses interrupt()), AutoGen (uses UserProxyAgent with human_input_mode), CrewAI, Mastra, Microsoft Copilot Studio — has developed its own answer. Instar is solving the same problem for a specific runtime (Claude Code via tmux) and a specific notification channel (Telegram). This is a real and valued capability, not a niche concern.

**2. The "mobile approval" pattern is emerging as a competitive differentiator.**

HumanLayer SDK, Mastra, and Microsoft Copilot Studio all emphasize mobile-native approval workflows. Instar's Telegram-first approach is well-positioned here — Telegram's InlineKeyboardMarkup buttons are a genuinely better mobile approval UX than email links or web dashboards. This advantage is undersold in the spec.

**3. "Bridge" has lost its freshness.**

In developer tooling generally, bridge reads as middleware infrastructure — functional but unmemorable. The naming research confirms this is not a differentiating word. In the crypto/DeFi ecosystem it now carries additional negative baggage (bridge exploits, bridge failures).

**4. The Telegram bot integration space is crowded but shallow.**

Relevance AI, Make, Lindy, and others offer Telegram integrations. None appear to solve the specific problem of interactive prompt relay from a Claude Code session. This is genuine whitespace. The feature should be framed around that uniqueness: not "Telegram bot" but "real-time agent approval via Telegram."

**5. The callback_data 64-byte limit is a solved problem.**

The spec's Open Question 5 (callback data size) is well-understood in the Telegram developer community. The standard solution — store full context server-side, use a short opaque ID in callback_data — is the correct approach and should be documented as the decided implementation path rather than left as an open question.

---

## Narrative & Story Assessment

The spec tells an honest, accurate story about the problem and solution. What it lacks is a user-centric narrative arc.

The problem statement reads from the system perspective. A stronger marketing narrative reads from the user perspective:

> You sent a task to your agent from your phone. Two hours later, nothing happened. The agent froze. It needed you to answer a question — but had no way to reach you. You found out when you got home and checked the dashboard.
>
> Agent Interrupt Relay changes this. The moment your agent needs input, you get a Telegram message. Tap Yes, tap No, or reply with your answer. Your agent continues. You never need to open a dashboard for routine decisions again.

This narrative should live in the spec preamble, in release notes, and in any future marketing copy.

---

## Virality & Word-of-Mouth

Moderate potential. The feature is "silent" when working correctly — auto-approvals are invisible in the happy path. Virality requires showcasing the relay moment: the Telegram notification with buttons is the shareable screenshot.

Suggestions:
- The dashboard indicator dots (spec section 6) should have a "copy link" affordance to show others what an agent approval flow looks like.
- The audit log is an undermarketed trust asset. "Your agent made 47 decisions for you this week, all logged" is a compelling weekly summary.
- The relay notification UI with inline buttons is worth showcasing prominently in documentation. It is visually distinctive and demonstrates Telegram as a professional agent control surface.

---

## Launch Strategy

**Phase 1 (Internal/Alpha):** Frame as closing a known gap — "sessions no longer go silent." This manages expectations: the feature prevents a failure mode, not adds a new workflow.

**Phase 2 (Beta announcement):** Lead with the Telegram button UX. Screenshot-driven. Show a prompt arriving, buttons appearing, one tap, agent continues. This is the feature's best face.

**Phase 3 (GA):** Position as part of Instar's broader "agent autonomy with human oversight" story. The auto-approve engine plus audit log plus relay together form a coherent trust architecture. Name this architecture — something like "Supervised Autonomy" or "Bounded Automation" — and make the Interrupt Relay one pillar of it.

---

## Research Findings

### How competing tools name prompt/permission features

| Framework | Feature Name | Vocabulary |
|-----------|-------------|------------|
| LangGraph | Human-in-the-Loop via interrupt() | "interrupt," "resume," "checkpoint," "breakpoint" |
| AutoGen | UserProxyAgent with human_input_mode | "proxy," "ALWAYS/TERMINATE/NEVER" modes |
| CrewAI | Human input tool | "human_input," no distinctive feature name |
| Mastra | Human-in-the-Loop | "approval," "suspend," "resume" |
| Microsoft Copilot Studio | Multistage approvals | "approval flow," "approve/decline" |
| HumanLayer SDK | @require_approval decorator | "approval," "just-in-time," "human as tool" |
| Telegram Bot API | approveSuggestedPost / declineSuggestedPost | "approve," "decline," "gateway" (for SMS) |

The dominant vocabulary in the space: interrupt, approve/decline, suspend/resume, human-in-the-loop. "Bridge" is not used. "Relay" appears in cross-chain contexts, not agent contexts.

### Naming conventions in agent orchestration

Naming in the space tends toward either:
- Functional verbs: interrupt, suspend, approve, gate
- Role nouns: proxy, guardian, sentinel, observer

The spec's current name ("Session Prompt Bridge") uses noun-noun-noun stacking, which is the weakest pattern in this taxonomy. It describes a component, not a capability.

### How "bridge" metaphors are used in developer tooling

"Bridge" is extremely common in:
- Cross-chain blockchain infrastructure (Relay Bridge, Wormhole, LayerZero)
- Middleware and integration layers
- React Native, Electron, and mobile native bridges

In all these contexts, "bridge" denotes low-level plumbing. It is not used for user-facing features. Using it here positions the feature as infrastructure rather than a user-facing capability — a positioning mistake for something that directly improves the user's moment-to-moment experience.

### Market positioning of similar Telegram bot integrations

The Telegram AI agent integration market (Relevance AI, Make, Lindy, AstrBot) focuses on:
- Sending messages TO users (notifications, summaries)
- Receiving commands FROM users (trigger workflows)

None appear to solve the specific interactive prompt relay problem — the bidirectional "agent is waiting for a decision, route that decision back to the agent" flow. This is genuine differentiation. The spec should name and claim this advantage more explicitly.

---

## Scalability Assessment

**Brand scalability: Moderate (conditional on name choice)**

"Session Prompt Bridge" does not scale. If Instar adds WhatsApp, Slack, or email relay (Open Question 2 in the spec), the name breaks — it is too Telegram-specific and too tmux-specific. A better name scales across channels and runtimes.

"Agent Interrupt Relay" scales: channel-agnostic and runtime-agnostic.
"Input Gate" scales: a logical concept that applies wherever agents need human input.

**Architecture scalability: Strong**

The spec's design is already messaging-agnostic at the component level. PromptDetector, PromptClassifier, and AutoApprover are channel-independent. The spec notes this explicitly. The naming should reflect this forward-looking design.

**Positioning scalability: Strong if reframed**

The "supervised autonomy" positioning (agents act, humans remain in control of consequential decisions) is the dominant market narrative for agentic AI in 2026. This feature is a clean instantiation of that story. If Instar builds more features in this direction (audit logs, trust levels, operation gates), they cohere into a "Supervised Autonomy" suite. The Interrupt Relay is the most user-visible feature in that suite. It should be named like a flagship, not an infrastructure component.

---

## Score

**6.5 / 10**

The engineering spec is excellent — thorough, well-reasoned, and production-ready in its technical design. The deduction is entirely on the marketing surface: the name is weak, there is no positioning sentence, the auto-approve trust story is undermarketed, and the spec does not capitalize on genuine competitive whitespace (bidirectional Telegram prompt relay is a real differentiator no competing tool appears to offer). These are all fixable before launch without touching the implementation. Conditional approval: resolve the naming and add a positioning sentence, and this ships cleanly.

---

## Sources

- [LangGraph Interrupt Documentation](https://docs.langchain.com/oss/python/langgraph/interrupts)
- [Interrupts and Commands in LangGraph — DEV Community](https://dev.to/jamesbmour/interrupts-and-commands-in-langgraph-building-human-in-the-loop-workflows-4ngl)
- [Human-in-the-Loop: When to Use Agent Approval — Mastra](https://mastra.ai/blog/human-in-the-loop-when-to-use-agent-approval)
- [Human-in-the-Loop for AI Agents — permit.io](https://www.permit.io/blog/human-in-the-loop-for-ai-agents-best-practices-frameworks-use-cases-and-demo)
- [Multistage and AI approvals in agent flows — Microsoft Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/flows-advanced-approvals)
- [LangGraph vs AutoGen vs CrewAI — Latenode](https://latenode.com/blog/platform-comparisons-alternatives/automation-platform-comparisons/langgraph-vs-autogen-vs-crewai-complete-ai-agent-framework-comparison-architecture-analysis-2025)
- [The Approval Window UX for Safe AI Autonomy — Medium](https://medium.com/@ThinkingLoop/the-approval-window-ux-for-safe-ai-autonomy-532597a48b6b)
- [Relay Bridge — Webisoft](https://webisoft.com/articles/relay-bridge/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Better Claude Code permissions — Korny's Blog](https://blog.korny.info/2025/10/10/better-claude-code-permissions)
- [AutoGen — Microsoft Research](https://www.microsoft.com/en-us/research/blog/autogen-enabling-next-generation-large-language-model-applications/)
