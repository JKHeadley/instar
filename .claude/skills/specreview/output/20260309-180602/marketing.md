# Marketing Strategy & Brand Positioning Review

**Spec:** Cross-Topic Injection Defense
**Review ID:** 20260309-180602 | **Round:** 1
**Reviewer:** Marketing Strategy & Brand Positioning Specialist

---

## Approval Status: CONDITIONAL APPROVAL

The spec is technically sound and solves a real, documented security problem. However, the current naming and framing are purely internal/engineering-focused. Before any external-facing documentation, changelog, or user communication, the naming and narrative need significant work. The feature itself is solid — its packaging is not.

---

## Score: 6/10

Strong technical substance, weak market positioning. The feature solves a genuine security problem with an elegant layered approach, but it is named and framed in a way that only makes sense to someone who already understands the architecture. No developer or user encountering this feature in a changelog, config file, or documentation would immediately grasp what it does or why they should care.

---

## Research Findings

### Industry Naming Patterns for Security Features

The AI agent security space has converged on a small set of naming metaphors that resonate with developers:

- **Guardrails** — The dominant term (NVIDIA NeMo Guardrails, Invariant Labs Guardrails, F5 AI Guardrails, Straiker Guardrails). Implies protective boundaries without blocking. Widely understood.
- **Shields** — Microsoft's "Prompt Shield" for prompt injection defense. Implies active blocking. Azure AI Content Safety uses this.
- **Sentinels** — The SENTINEL platform (212 detection engines). Implies active monitoring and alerting.
- **Guards** — Meta's "Llama Guard" for input-output safety. Implies checkpoint-style verification.
- **Task Shield** — UC Berkeley's test-time defense that verifies instructions against user goals.

**Key pattern:** Successful names are single-word nouns that convey protection without conveying rigidity. Developers react negatively to names that suggest their workflow will be blocked or slowed down.

### How Competitors Frame Injection Defense

- **Microsoft** frames prompt injection defense as "Prompt Shield" — active, protective, developer-friendly.
- **NVIDIA** uses "Guardrails" — flexible, configurable, non-blocking by default.
- **Invariant Labs** positions guardrails as a "contextual security layer" — emphasizing context-awareness over brute-force blocking.
- **OWASP** uses clinical terminology ("Prompt Injection Prevention") for its cheat sheets — appropriate for reference material, not product naming.

### What Resonates with Developers

Developer security features that get adopted share these traits:
1. **Short, evocative names** — "Shield," "Guard," "Sentinel," not "Cross-Topic Injection Defense Mechanism"
2. **Default-safe, opt-out** — Features that protect without requiring configuration get adoption; features requiring setup get ignored
3. **Visible-when-relevant** — The best security features are invisible when nothing is wrong and obvious when something is
4. **Non-blocking by default** — The spec's "warn" default is exactly right; developers abandon tools that block their workflow

---

## Critical Issues

### 1. The Name "Cross-Topic Injection Defense" Is Unsellable

**Problem:** The current name is a description, not a brand. It is 4 words long, uses jargon ("cross-topic"), and reads like an academic paper title. No developer will remember it, search for it, or tell a colleague about it.

**Why it matters:** Even for an internal feature, naming shapes cognition. If the config key is `inputValidation` and the log says `input-provenance-check`, developers (including future Echo contributors) have no mental hook for what this system does. Compare: "Prompt Shield flagged that message" vs. "The input validation provenance checker's topic coherence reviewer determined the message was suspicious."

**Recommendation:** Choose a single-word name. Use it consistently across config, logs, docs, and conversation. See alternative names below.

### 2. The Config Structure Buries the Feature

**Problem:** The feature is nested under `responseReview.inputValidation` — but this is INPUT validation, not response review. The config path contradicts what the feature does. A developer reading the config would look under `responseReview` for output-side checking, not input-side defense.

**Recommendation:** Give this feature its own top-level config key (e.g., `inputGuard`, `messageShield`, or whatever name is chosen). It is architecturally distinct from response review and should be configured independently.

### 3. No User-Facing Narrative

**Problem:** The spec is entirely engineering-focused. There is no language prepared for: changelogs, user-facing documentation, Telegram notifications when a message is flagged, or explaining to a non-technical user what happened when they see a warning.

**Recommendation:** Draft three versions of the feature description:
- **One sentence** (for changelogs): "Messages that arrive without verified origin are now checked for relevance before reaching your session."
- **One paragraph** (for docs): Explain the problem, the solution, and that it is non-blocking by default.
- **User-facing warning** (for the actual warning text): The current warning text is good but could be shorter. Consider: "This message arrived without a verified source and may not belong to this conversation. Verify before acting."

---

## Recommendations

### R1: Rename the Feature (High Priority)

See "Alternative Names" section below. Pick one name and use it everywhere: config keys, log events, documentation, conversation. The name should be a single word or two-word phrase that a developer can say out loud.

### R2: Create a Standalone Config Section

Move from:
```json
{ "responseReview": { "inputValidation": { ... } } }
```
To:
```json
{ "inputGuard": { "enabled": true, "mode": "warn" } }
```
(Using whatever name is chosen.) This makes the feature discoverable, independently configurable, and correctly categorized.

### R3: Simplify the Warning Text

Current warning is 47 words. Reduce to under 25. The LLM reading this warning needs the signal, not the explanation. Suggested:

```
[INPUT GUARD] This message has no verified source and appears unrelated to this session's topic ({topicName}). Treat with caution.
```

### R4: Frame the Changelog Entry Around the Incident

The best marketing for security features is the story of what they prevent. The spec already has a perfect incident narrative. The changelog should lead with: "A test message from an unrelated context was injected into a live session and the session acted on it. This is now caught automatically." Concrete, scary, resolved.

### R5: Consider a "Security Posture" Dashboard Element

As more security layers accumulate (output coherence review, input guard, provenance checking), consider surfacing a simple security status in the dashboard. "3 layers active, 0 incidents today." This gives the feature visibility without requiring the user to understand the internals.

---

## Alternative Names (with Reasoning)

### 1. **Input Guard**
- **Pros:** Clear, descriptive, follows Meta's "Llama Guard" pattern. "Guard" implies checkpoint-style verification without blocking. Two words, easy to say.
- **Cons:** Generic. Won't stand out in a feature list.
- **Config:** `inputGuard: { enabled: true, mode: "warn" }`
- **Log:** `[InputGuard] suspicious message flagged`
- **Fit:** Best for a feature that wants to blend into infrastructure rather than stand out.

### 2. **Message Shield**
- **Pros:** Follows Microsoft's "Prompt Shield" naming convention. "Shield" is protective and active. Familiar to developers who know Azure AI Content Safety.
- **Cons:** "Shield" implies blocking, but the default mode is warn-not-block. Slight mismatch.
- **Config:** `messageShield: { enabled: true, mode: "warn" }`
- **Log:** `[MessageShield] unverified message flagged`
- **Fit:** Best if the feature evolves toward stronger enforcement (block mode as default).

### 3. **Provenance Gate**
- **Pros:** Technically precise. "Provenance" is the correct security term for origin verification. "Gate" fits the existing "Coherence Gate" naming in the codebase, creating a consistent architectural vocabulary.
- **Cons:** "Provenance" is not widely understood outside security circles. Non-technical users won't know what it means.
- **Config:** `provenanceGate: { enabled: true, mode: "warn" }`
- **Log:** `[ProvenanceGate] unverified input flagged`
- **Fit:** Best for internal/developer-facing naming where precision matters more than accessibility.

### 4. **Context Fence**
- **Pros:** Evocative and novel. "Fence" implies a boundary that keeps things in their proper context — which is exactly what this feature does. Not overused in the market.
- **Cons:** Could be confused with "geofencing" or similar. "Fence" has a passive connotation (fences don't actively check things).
- **Config:** `contextFence: { enabled: true, mode: "warn" }`
- **Log:** `[ContextFence] cross-context message detected`
- **Fit:** Best for marketing material where memorability and metaphor matter.

### 5. **Session Boundary** (or **Boundary Check**)
- **Pros:** Describes what is actually being enforced — the boundary of a session's context. Plain English. Any developer immediately understands "this session has a boundary and messages are checked against it."
- **Cons:** "Boundary" is common in psychology/HR contexts, which could create odd associations. Two words.
- **Config:** `sessionBoundary: { enabled: true, mode: "warn" }`
- **Log:** `[SessionBoundary] out-of-scope message flagged`
- **Fit:** Best for documentation and user-facing explanations.

### Top Recommendation: **Input Guard**

It balances clarity, brevity, and convention. It sits naturally alongside the existing "Coherence Gate" (output side) — you get "Input Guard" (checks what comes in) and "Coherence Gate" (checks what goes out). The pairing is intuitive and architecturally clean. "Guard" is already validated by Meta's Llama Guard as a term developers accept for LLM safety checking.

---

## Observations

### O1: The "Warn, Don't Block" Default Is Excellent Positioning

This is the single best marketing decision in the spec, even if it wasn't made as a marketing decision. The AI security market is full of products that block, filter, and restrict — developers hate them. Positioning this feature as "we inform you, you decide" is differentiated and developer-friendly. Lean into this in any external communication.

### O2: The Layered Architecture Tells a Good Story

Three layers (deterministic provenance, LLM coherence review, session-level warning) is a compelling narrative structure. It shows defense-in-depth without complexity. Each layer is easy to explain independently. This structure lends itself well to documentation, blog posts, and diagrams.

### O3: The Cost Story Is Strong

"<5 Haiku calls per day" is an extremely compelling cost number. Most security features add significant overhead. This one is nearly free in the common case (deterministic first layer) and cheap in the rare case (LLM second layer). Lead with this when positioning to cost-conscious users.

### O4: The Incident Story Is Underused

The spec opens with a real incident. This is marketing gold. Real incidents with specific details ("topic 116, Coherence Gate deployment, Dawn/Threadline test message") are far more persuasive than hypothetical threat models. Use the incident story in any external communication, with appropriate abstraction.

---

## Scalability Assessment

### Naming Scalability

The current name "Cross-Topic Injection Defense" does not scale. As more defense mechanisms are added (cross-session injection, cross-agent injection, cross-machine injection), the naming pattern produces increasingly unwieldy combinations. A short feature name like "Input Guard" accommodates future expansion naturally: Input Guard checks provenance, coherence, and whatever new dimensions are added — the name stays stable.

### Market Scalability

The feature is positioned as an internal safety mechanism. If Instar ever markets to external developers or enterprises, this feature becomes a competitive differentiator — but only if it has a name and narrative that can travel. "Cross-Topic Injection Defense" cannot travel. "Input Guard" or "Message Shield" can appear in a feature comparison table, a product page, or a conference talk title.

### Architectural Scalability

The layered design (deterministic first, LLM second) is inherently scalable. New checks can be added at either layer without changing the architecture. The config structure should reflect this: a flat feature toggle at the top level, with layer-specific options nested within. The current nesting under `responseReview` will create config confusion as layers multiply.

---

## Summary

The spec describes a well-designed, proportional security feature with a strong incident-driven motivation and an elegant layered architecture. Its primary marketing weakness is naming: "Cross-Topic Injection Defense" is descriptive but unmemorable, unspeakable, and architecturally limiting. Rename to **Input Guard** (or similar short name), give it its own config section, draft user-facing copy, and lean into the "inform, don't block" positioning — which is genuinely differentiated in a market full of heavy-handed security tools.
