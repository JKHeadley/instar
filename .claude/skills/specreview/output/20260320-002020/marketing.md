# Marketing Review: Input Gate
**Review ID:** 20260320-002020
**Round:** 2
**Reviewer Role:** Marketing Strategy & Brand Positioning Specialist
**Spec:** `specs/session-prompt-bridge.md`
**Date:** 2026-03-20
**Based on Round 1 Review:** 20260319-150852

---

## Approval Status

**APPROVED**

The spec has addressed every critical issue raised in Round 1. The name is stronger, the positioning sentence is present, the Telegram copy is differentiated, and the auto-approve trust posture is explicitly documented. The marketing surface is now fit to ship. Remaining observations below are refinements, not blockers.

---

## Round 1 Issue Resolution Status

| R1 Critical Issue | Resolution |
|-------------------|------------|
| Name describes mechanism, not outcome | **RESOLVED.** "Input Gate" adopted â one of the two R1 top recommendations. Short, accurate, and outcome-oriented. |
| "Bridge" is overloaded in developer tooling | **RESOLVED.** "Bridge" is gone from the name and config key. |
| No clear positioning sentence | **RESOLVED.** Positioning sentence added to spec header: *"Input Gate lets Telegram users respond to interactive prompts from their running sessions â so a stalled Claude Code session unblocks in seconds, not hours."* |
| Telegram notification copy was generic | **RESOLVED.** Three differentiated copy variants now in spec: permission prompts, clarifying questions, and plan approval each have distinct framing. |
| Config key was "promptBridge" | **RESOLVED.** Config key is now `inputGate`, consistent with the feature name and the gate metaphor family. |
| Callback data size was an open question | **RESOLVED** (was R1 observation, now formally closed in spec). CallbackRegistry with 8-char token approach is documented as the decided implementation. |
| Auto-approve default posture was ambiguous | **RESOLVED.** Opt-in is explicitly stated with rationale documented in spec. |

All seven R1 critical issues and key observations have been addressed. This is a clean resolution round.

---

## Name Analysis

### Current Name: "Input Gate"

**Score: 8/10**

The name delivers on the core criteria:

- **Memorable:** Two syllables, no jargon. Sticks on first read.
- **Searchable:** "Input Gate" as a phrase returns no direct collision in the software developer tool space (see Research Findings). Hardware SiC gate driver ICs use "input gate" in technical copy, but there is no branded developer product of that name.
- **Scalable:** The concept generalizes. "Where user input is gated before reaching the agent" works for any notification channel (Telegram, Slack, email). It survives scope expansion.
- **Coherent with the ecosystem:** The gate metaphor is already established in Instar â external-operation-gate, coherence gate. "Input Gate" extends a pattern the user already knows.
- **Honest:** The name describes what it does: input (from the user) passes through a gate (classification and routing). No overreach.

**One remaining risk:** "Gate" in security contexts often connotes access control or permission barrier. A developer new to Instar might initially read "Input Gate" as something that blocks user input rather than routes it. The positioning sentence immediately beneath the name corrects this. Risk is low in context.

### Alternative Names (for reference â not recommended over current)

The R1 top recommendation "Agent Interrupt Relay" remains viable and industry-aligned. However, "Input Gate" is the better fit for Instar specifically because:

1. It integrates with the existing gate metaphor family rather than introducing new vocabulary ("relay" is not an established Instar term)
2. It is shorter and lower cognitive load
3. It does not imply an asynchronous hand-off ("relay" slightly undersells the immediacy of the inline keyboard UX)

If a future v2 expands to multi-channel or multi-agent relay scenarios, "Agent Interrupt Relay" could be revisited as the broader umbrella concept. "Input Gate" would still make sense as the Telegram-specific implementation name under it.

---

## Positioning Sentence Assessment

The adopted sentence:

> "Input Gate lets Telegram users respond to interactive prompts from their running sessions â so a stalled Claude Code session unblocks in seconds, not hours."

**Assessment:** Strong. It does the work a positioning sentence must do:
- States the audience (Telegram users)
- States the action (respond to interactive prompts)
- States the outcome (stalled session unblocks)
- Quantifies the value ("seconds, not hours")
- Contains a contrast that creates emotional resonance ("not hours")

**One refinement to consider:** The phrase "interactive prompts from their running sessions" is slightly inside-baseball. A non-developer reading this might not parse "interactive prompts." A more universal version:

> "Input Gate lets Telegram users approve, answer, and unblock their running sessions â without opening a dashboard."

The "without opening a dashboard" framing highlights the key workflow change more sharply. Either version is acceptable for a developer audience. For any future public-facing copy (blog post, social), the revised version will land better with a mixed audience.

---

## Critical Issues

None. There are no blocking marketing issues in Round 2.

---

## Recommendations

### 1. Name the auto-approve trust artifact explicitly

The auto-approve audit log (`.instar/input-gate-log.jsonl`) is present in the spec but framed as an implementation detail. The R1 recommendation to give this a user-facing name was not fully addressed. The spec now calls it the "audit log" â this is accurate but generic.

Consider naming this the **Input Gate Log** and surfacing it in the dashboard as a named panel ("Input Gate Log"), not just a dot indicator. The log is actually a trust artifact: "Everything your agent approved on your behalf, with full reasoning." That is a compelling story for skeptical adopters of auto-approve. A named, surfaced log makes the feature feel safer and more transparent.

### 2. Strengthen the stall fallback copy

The stall fallback notification was improved from R1's suggestion â "Your agent paused and is waiting for you â tap here to respond." This is good. However, the spec still calls the fallback notification the "stall safety net" internally. If this message ever surfaces in dashboard UI or settings copy, the word "stall" carries a failure connotation. Consider "Idle Fallback" or "Pause Fallback" as the internal label. Small change, positive signal.

### 3. Add a one-liner to the dashboard indicator

The dashboard dot indicators (yellow/green/blue/white) are well-designed, but a tooltip or one-line status label would help mobile users who cannot hover. Example: "Input Gate: awaiting your response" next to the blue dot. This reinforces the feature name and teaches users the terminology through use.

### 4. The post-session digest (Phase 4) should carry the feature brand

The spec mentions a post-session digest: "Session completed. 3 auto-approved actions: created foo.py, edited bar.py, ran ls." Consider formatting this as:

> Input Gate summary: 3 decisions approved automatically, 1 forwarded to you.

This keeps the feature name present in the user's regular workflow, building brand recall over time.

---

## Observations

### The competitive positioning has improved implicitly

By adopting "Input Gate," the spec now occupies a distinct naming position from every major competitor:

| Framework | HITL Feature Name |
|-----------|------------------|
| LangGraph | interrupt() |
| Mastra | Human-in-the-Loop (suspend/resume) |
| AutoGen | UserProxyAgent |
| Strands SDK | Interrupt Handling |
| HumanLayer | @require_approval |
| Instar | **Input Gate** |

None use "gate." The name is genuinely differentiated.

### The "approval" vocabulary is now dominant in the space

Research confirms that "approve/decline" language has become market-standard by 2026. The Telegram copy in the spec already uses this vocabulary correctly â "approve or decline" for permission prompts, "do you want to proceed" for plan approval. This alignment is good and requires no changes.

### "Interrupt" vs "Gate" â the framing choice matters

The industry converged on "interrupt" (LangGraph, Strands SDK) because it describes the agent-side event: the agent is interrupted. "Gate" describes the routing mechanism from the user perspective: input is gated. This is a subtle but meaningful difference. Instar's choice to frame from the user perspective ("your input is the gate") rather than the agent perspective ("the agent is interrupted") is the right call for a mobile-first, non-developer-facing product. It positions the user as in control, not the recipient of an error condition.

### The spec is now well-named at every layer

| Layer | Name |
|-------|------|
| Feature | Input Gate |
| Config key | `inputGate` |
| Components | InputDetector, InputClassifier |
| Audit log | `input-gate-log.jsonl` |
| Log path config | `inputGate.logPath` |

This coherence is excellent. Every layer uses the same vocabulary. Docs, dashboards, and error messages will be naturally consistent.

---

## Narrative & Story Assessment

The positioning sentence is the core narrative anchor. The problem statement (section 1) remains strong. The end-to-end flows in section 4 are the best developer documentation of the feature's value â they show, not tell, what the user experience is.

If a launch blog post or changelog entry is written, the section 4 happy path flows should be the skeleton. They are already written in plain prose and cover the three key scenarios (auto-approve, relay with text reply, relay with buttons). The writer just needs to add the user perspective wrapper.

The "two hours later, nothing happened" narrative from R1 remains useful for external-facing copy. It was not adopted in the spec (which is appropriate â specs are not marketing copy), but it should surface in any launch communication.

---

## Virality & Word-of-Mouth

**Assessment: Moderate-to-high potential, unchanged from R1.**

The shareable moment is unchanged: Telegram notification with inline keyboard buttons is visually distinctive and immediately legible. One screenshot tells the whole story.

The Round 2 spec improves this slightly by sharpening the copy variants â "Your agent is waiting â approve or decline:" vs "Your agent has a question:" vs "Agent plan ready â do you want to proceed?" These variants are all screenshot-worthy in their appropriate context. The three message types could be showcased in a single image (three messages, three prompt types) as a launch visual.

The audit log, if surfaced prominently in the dashboard, becomes a second screenshot moment: "Your agent made 12 decisions today" as a weekly/daily summary is shareable for power users who want to demonstrate autonomy + oversight.

---

## Launch Strategy

Unchanged from R1 recommendations, which stand:

**Phase 1 (Alpha/Internal):** Frame as closing a known gap â "sessions no longer go silent." Show the stall fallback firing and the dashboard indicator. The feature works even before auto-approve is adopted.

**Phase 2 (Beta):** Lead with the Telegram inline keyboard UX. Screenshot-first. Show all three message variants. Showcase the audit log as a trust artifact.

**Phase 3 (GA):** Position Input Gate as the visible face of Instar's supervised autonomy model. The full architecture â external-operation-gate + coherence gate + Input Gate + audit log â is a coherent "agent trust stack." Name the stack and position Input Gate as its most user-facing layer.

---

## Research Findings

### "Input Gate" as a product name â collision check

No direct collision found. Web search returns:
- Infineon hardware SiC gate driver ICs with "opto-emulator input" â hardware, not software, no brand overlap
- LogicGate (risk management software) â "gate" in name but different domain and not "Input Gate"
- No developer tool, agent framework, or SaaS product named "Input Gate"

**Finding: The name is clear.** There is no brand collision in the software developer tool or agent framework space.

### How competing agent frameworks name HITL features (2026 update)

The dominant vocabulary remains: **interrupt, approve/decline, suspend/resume, control gate, hard interrupt.** Key updates from live research:

- "Control Gate" and "Hard Interrupt" are now in use (FlowHunt, MyEngineeringPath) as human-in-the-loop primitives in 2026 literature
- "Approval gate" appears in senior-engineering-role descriptions as a design pattern
- Strands Agents SDK (AWS) uses "Interrupt Handling and Human-in-the-Loop" as a named doc section
- No competing framework uses "Input Gate" or the input-from-user-side framing

"Gate" as a concept (approval gate, control gate) is becoming more common in human-in-the-loop writing, but no competing product has claimed it as a feature name. **First-mover advantage on "gate" framing is intact.**

### Developer tool naming trends in 2026

The market has bifurcated:
- **No-code platforms** (n8n, Make, Zapier AI) use action-verb names and workflow metaphors
- **Developer frameworks** (LangGraph, CrewAI, AutoGen) use noun-based, technical vocabulary â "graph," "crew," "gen"

For developer-facing features, **short compound nouns or noun phrases** are standard (LangGraph's "interrupt()", OpenAI's "Agents SDK"). Input Gate follows this pattern. It is developer-legible without being opaque to adjacent stakeholders.

### "Gate" in existing developer/security tooling

"Gate" is used in:
- **CI/CD quality gates** (SonarQube, Azure DevOps) â pass/fail checkpoints in pipelines
- **API gateways** (Kong, AWS API Gateway) â routing and policy enforcement
- **Security policy gates** (OPA, Falco) â rule evaluation before action
- **Instar's own gate family** â external-operation-gate, coherence gate

The pattern is consistent: a gate is a point of evaluation and routing, not a block. "Input Gate" aligns naturally with this usage. Users familiar with CI/CD quality gates or API gateways will intuitively understand "a gate for input."

---

## Scalability Assessment

**Brand scalability: Strong.**

"Input Gate" scales cleanly:
- If Instar adds Slack relay: "Input Gate" works. The gate concept is channel-agnostic.
- If Instar adds email or SMS relay: "Input Gate" works.
- If Instar adds more agent runtimes beyond Claude Code: "Input Gate" works.
- If the gate concept expands (pre-action gates, output gates): "Input Gate" names one specific gate type in a family. This is a good problem to have.

The config key `inputGate` also scales â per-topic overrides, per-agent config, and any future API surface all use the same term.

**Positioning scalability: Strong.**

The "supervised autonomy" positioning story from R1 holds. Input Gate is the most user-visible feature in that story. The external-operation-gate and coherence gate are the less visible but architecturally important siblings. Together they are Instar's answer to "how do you keep agents safe while keeping them useful?" Input Gate is the part users see and feel on a daily basis.

---

## Score

**8.5 / 10**

Up from 6.5 in Round 1. The name is now right, the positioning sentence is present and effective, the Telegram copy is differentiated, the auto-approve trust posture is explicit, and the config naming is consistent. The spec reads as a complete, launch-ready feature document. The remaining 1.5 points are refinement opportunities â naming the audit log panel, strengthening the stall fallback internal label, and ensuring the post-session digest carries the brand â none of which are blockers. This ships cleanly.

---

## Sources

- [Human-in-the-Loop Patterns for AI Agents (2026) â MyEngineeringPath](https://myengineeringpath.dev/genai-engineer/human-in-the-loop/)
- [Interrupt Handling and Human-in-the-Loop â Strands Agents SDK (DeepWiki)](https://deepwiki.com/strands-agents/sdk-python/2.7-interrupt-handling-and-human-in-the-loop)
- [Human in the Loop Middleware in Python â FlowHunt](https://www.flowhunt.io/blog/human-in-the-loop-middleware-python-safe-ai-agents/)
- [5 Key Trends Shaping Agentic Development in 2026 â The New Stack](https://thenewstack.io/5-key-trends-shaping-agentic-development-in-2026/)
- [Top 9 AI Agent Frameworks as of March 2026 â Shakudo](https://www.shakudo.io/blog/top-9-ai-agent-frameworks)
- [Developer AI Tooling in 2026: Trends Shaping How We Build â Uno Platform](https://platform.uno/blog/ai-tooling-trends-shaping-how-we-build/)
- [6 things developer tools must have in 2026 â Evil Martians](https://evilmartians.com/chronicles/six-things-developer-tools-must-have-to-earn-trust-and-adoption)
- [Security in the Vibe Code Era: There's No Gate to Keep â GuidePoint Security](https://www.guidepointsecurity.com/blog/security-vibe-code-part-one-no-gate-to-keep/)
- [Human-in-the-Loop for AI Agents â permit.io](https://www.permit.io/blog/human-in-the-loop-for-ai-agents-best-practices-frameworks-use-cases-and-demo)
- [Interrupts and Commands in LangGraph â DEV Community](https://dev.to/jamesbmour/interrupts-and-commands-in-langgraph-building-human-in-the-loop-workflows-4ngl)
