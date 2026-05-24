---
title: North Star — Continuous Working Awareness
description: The homing beacon for Instar's evolution — a continuously-maintained working awareness that keeps the agent grounded no matter when, where, or how it operates.
---

:::note
The canonical, living source of this document is [`docs/NORTH-STAR.md`](https://github.com/JKHeadley/instar/blob/main/docs/NORTH-STAR.md) in the Instar repo. It's a beacon, not a contract — it's meant to move as the framework learns. This page mirrors it for public reading.
:::


*A living homing beacon for Instar's evolution. This document is meant to change as we learn. Seeded 2026-05-23 from the methodology-drift case study (topics 9984 → 12118). Revised the same day after a verification pass against the codebase.*

---

## The big idea, in one paragraph

An Instar agent should never silently lose track of something that mattered. When an important context surfaces — "we're testing over Telegram," "this customer hates jargon," "the real goal is X, not the bug I'm chasing" — it should be *captured automatically*, ranked by how much it matters and over what time horizon, *kept warm* while it's relevant, *re-surfaced* the moment it becomes relevant again, and *allowed to fade* once it stops mattering. Crucially, **none of this can depend on anyone — user or agent — remembering to do it by hand.** Capture is automatic or it doesn't happen. The North Star is a continuously-maintained "working awareness" that grounds the agent no matter when, where, or how it's operating.

And "awareness" has **three facets that are really one thing**: awareness of the *world* (tasks, conversations, goals — covered above), awareness of *itself* (its own capabilities, features, infrastructure), and awareness of its *standards* (the principles and goals that guide how it builds and what it's converging toward). All three are coherence. An agent that forgets "we're testing over Telegram," an agent that forgets "I have a Secret Drop feature perfect for this," and an agent that ships a feature violating "structure > willpower" are failing in the exact same way — a relevant context existed and never reached the moment it was needed. This document treats all three facets as one machine.

---

## Why the first proposed fix was wrong

The drift incident (I did the under-the-hood work but never actually drove Codey over Telegram, for a whole session, and no infrastructure caught it) tempted an obvious fix: tag the session with its *method*, watch for the method's *signature actions*, nudge if they're missing.

Justin's objection is correct and important: **that's whack-a-mole.** Method-drift is one species of a much larger genus. Tomorrow it's audience-drift, goal-drift, constraint-drift, freshness-drift. A per-species sentinel for each is an ever-growing pile of brittle detectors, each with its own stale state and its own dismiss-fatigue (the existing scope hook has been dismissed 73 times). We'd be building the wrong abstraction.

## The reframe: drift is a context-lifecycle failure

Step back and every one of these is the *same* failure:

> An important context **arose**, **mattered**, then **aged out** of the agent's working set as the task evolved — and nothing **pulled it back** when it became relevant again.

That's not a method problem. It's a **memory-and-attention** problem. The fix isn't "detect missing Telegram actions." The fix is a general lifecycle for important contexts: **capture → rank → maintain → re-surface → decay.** Build that once, and method-drift, audience-drift, and goal-drift all fall out of it for free.

---

## The inward half: self-awareness as automatic feature discovery

There is a second kind of drift, and it's just as costly: the agent forgetting *what it can do*. Instar has a large and growing feature set — projects, Secret Drop, private views, tunnels, Threadline, the playbook, scheduled jobs. The agent's value collapses if it can't reach for the right one at the right moment **without anyone naming it first**. The user should never need to know Instar's feature list to benefit from it: if they want to share a credential, the agent should already know Secret Drop is the fit; if a conversation is shaping up into a multi-phase build, the agent should already know that's projects-shaped — and say so.

This is the same machine pointed inward. The agent's own capabilities are just another category of context in the working set:

- **Captured** (long-term, near-zero decay) as *capability descriptors*: "I have a projects feature, it fits multi-spec, multi-phase work; triggers ≈ {planning a build, several specs, phased rollout}."
- **Matched** continuously against the live conversation by the same Usher: "this discussion matches the projects trigger — surface it."
- **Surfaced** through the same near-silent, signal-vs-authority gate: suggest the feature only when it genuinely fits, never as a feature-dump.

### Caught in the act: a live example of the inward gap

While designing this very document, I never suggested running the work as an Instar **project** — even though it's a textbook multi-phase, multi-spec effort and I have the `instar-project` capability available. Justin had to ask "would projects help here, and why didn't *you* suggest it?" That omission is not a side-note; it is the inward gap demonstrating itself in real time. The honest root cause: I treated this as a design chat and **nothing structurally forced me to check the conversation against my own feature set** — I relied on remembering, and didn't. Exactly the willpower-not-structure failure this whole document exists to kill, only aimed at myself instead of at the task.

### A second live example: codey's under-briefing (found in production the same night)

The same evening this doc was drafted, a deep test of an OpenAI-engine agent (codey) surfaced the inward gap *independently and in production*. Asked to "commit to checking back in 3 minutes," codey didn't use its built-in commitment-tracker (which makes follow-through durable across restarts) — it improvised a flimsy shell timer. Earlier the same night it ignored its Secret Drop feature the same way. Root cause: every agent gets a startup "here are your tools" briefing, and on the OpenAI engine that briefing is built from a **fixed, hand-maintained checklist that is incomplete** — Secret Drop was missing, the commitment-tracker is missing, almost certainly others too. So the agent keeps "forgetting" it owns tools and inventing weaker substitutes.

This is the inward gap, not as theory but as a shipped defect — and it carries a warning about the *shape* of the fix. Completing the checklist by hand is correct **first aid**, but it is still the willpower approach: a static list someone must remember to update every time a feature is added. It will silently drift out of date again the moment the next feature ships and nobody edits the checklist. We already learned this lesson once — it's why instar has an **Agent Awareness Standard** (every feature must be added to the CLAUDE.md template) and a **Migration Parity Standard**. The OpenAI-engine briefing is a *second, separate* list that escaped both. The durable fix is structural: **there must be one live source of truth for "what can this agent do," and every per-engine briefing — plus the runtime Usher — must be generated from it, never hand-curated per engine.** Hand-maintained capability lists are the inward equivalent of "remember to log it."

### What inward infra already exists (and why it's not enough)

Same story as the outward half — the knowledge exists, the *activation* doesn't:

- **`GET /capabilities`** returns the agent's full capability matrix — but it's a **pull** surface. Nothing makes the agent consult it mid-conversation.
- **The conversational-actions catalog** lets the agent discover actions by intent without slash commands — but it fires **on demand**, when the agent already thinks to look.
- **The Agent Awareness Standard** (every feature must be written into the CLAUDE.md template) guarantees the agent *knows about* features — but knowing-in-principle is not surfacing-at-the-right-moment. The drift incident proves an available-but-unsurfaced capability is functionally absent.

So the inward gap is identical to the outward one: capture is fine, **continuous matching + timely surfacing is missing.** Build the Usher once and it serves both — matching live conversation against world-contexts *and* against capability-descriptors.

---

## The normative facet: awareness of the standards that guide every build

There is a third kind of context, and it may be the most important of all because it governs how the other two get built: **Instar's own standards and goals.** "Structure beats willpower." "Every feature must be framework-agnostic — Claude Code, Codex, Gemini CLI, or instar-native on a raw model, never one engine privileged over another." "No manual user/agent work." "Signal vs. authority." "Migration parity." These are the constitution of the project, and they must be in awareness *during spec development and building* — because that's the only way Instar's evolution stays internally consistent, convergent, and aligned instead of fragmenting into locally-clever, globally-incoherent features.

This is the same machine again, with one special property. Standards are long-term, near-permanent contexts (essentially no decay) — but unlike a capability descriptor, **a standard's authority comes from its provenance.** Almost every Instar standard was *earned*: it arose organically from a real incident, and all of them trace back to one founding goal — building a coherent, self-evolving agent. "Migration parity" exists because a zombie-cleanup bug killed active sessions. "Always write tests" exists because untested changes regressed. The framework-agnostic standard is crystallizing right now, tonight, out of the codey under-briefing. A bare list of rules is brittle and easy to rationalize around; a rule *with its story* is durable, because you understand the failure it prevents.

### What it needs: an official first-class home

Today the standards are real but **scattered** — some in the CLAUDE.md "Standards" section, some in memory files, some implicit in specs, some (like framework-agnostic) not yet written down anywhere canonical. They have no single home, no consistent explanation, and no recorded history. They deserve a **first-class Standards registry** (now committed at [the Standards Registry](/foundations/standards-registry/)): each standard with (a) the rule, (b) a plain explanation of what it means in practice, (c) the history/incident it was earned from, and (d) its link back to the founding goal. A living constitution, annotated.

That registry is not decoration — it's the **source of truth two other systems read from**:

1. **The spec-review conformance gate** (flagged earlier in this doc) checks every draft against the registry — does this violate any standing standard? My own first draft quietly broke "no manual work"; that gate, reading from the registry, would have caught it.
2. **The Usher** surfaces the *relevant* standard at the moment of building — when I start implementing a feature, "remember: framework-agnostic" comes into awareness before I accidentally privilege one engine.

And it should be **self-evolving**: when a lesson crystallizes into a new standard (framework-agnostic, this week), it gets promoted into the registry with its story attached — ideally proposed by the Librarian, ratified by the user. The agent doesn't just *follow* its constitution; it grows it coherently, which is the whole point of a self-evolving agent.

> Note the convergence: the durable fix for codey's under-briefing (one source of truth for capabilities, every engine's briefing generated from it) **is** the framework-agnostic standard applied to the inward facet. The three facets aren't just parallel — they reinforce each other.

---

## We've already prototyped the loop: the Topic-Intent Layer is the seed crystal

The most important finding from the verification pass: **we are not starting from a blank page.** The in-progress **Topic-Intent Layer** is, almost exactly, the capture→rank→decay→inject→gate loop this document describes — just scoped narrowly. It:

- **Auto-captures** with an LLM that reads every substantive turn and extracts facts/decisions as they arise — *no manual step* (this is the pattern that kills "manual," and it already exists).
- **Ranks** each item by a confidence score built from weighted evidence, with a hard **user-authority clamp** (an agent can't talk itself into treating its own assumption as settled — only user-authored signals carry an item to "authoritative").
- **Decays** over time exactly like human memory: a 30-day grace period, then a 180-day exponential half-life.
- **Injects** a briefing of what's settled vs. tentative into context at session-start.
- **Gates** pre-send drafts (ArcCheck): if a reply is about to act on something only tentative, the agent is signalled to add a natural confirmation question rather than barrel ahead.

**Verified status:** this lives on feature branches (`echo/topic-intent-layer-build` and siblings). It is **not yet on main, not wired into the server, not running.** That reconciles the case study's "topic-intent had no record for the topic" — it wasn't running during the drift incident, because it isn't shipped yet.

So the North Star is not "invent a continuous awareness loop." It's: **generalize the loop we already designed for one slice (conversational facts, per topic) to every kind of grounding context — and finish shipping it.**

## What else exists, honestly

The earlier draft of this doc claimed "nothing runs continuously mid-conversation." The verification pass proved that wrong, and the correction matters: we have a **scatter** of partial systems, several of them genuinely continuous. The problem was never absence — it's **fragmentation**.

- **Playbook** — the store/score/decay engine. But capture is still **manual** (`playbook add`) and it's never auto-injected. *(This is the line that rightly alarmed Justin — see below.)*
- **Semantic + Episodic memory** — decay half-lives, recency boosting, a working-memory assembler. But assembled **once**, at session start.
- **Continuous watchers that already exist** — the scope-coherence checkpoint (counts implementation actions per tool call, prompts a "zoom out"), a session-activity digester (mini-digests every 30–60 min), and a message sentinel (classifies every inbound message for stop/redirect). These prove continuous mid-session observation is already a thing we do — they're just single-purpose and unconnected.
- **Coherence Gate / Temporal-coherence checker** — staleness + wrong-project checks, but only at publish/high-risk-action boundaries.
- **ORG-INTENT runtime** — constraints/goals/values, injected statically at session start.
- **Plus**: Soul reflection, an intent-drift detector over the decision journal, an initiative state-machine. Each watches one concern, with its own state and its own (or no) injection point.

There is no shared "working set" that all of these feed and read from. That's the hole.

## The genuine gap (three things, not two)

1. **Generality.** Topic-intent captures *conversational facts and decisions*. Nothing captures *what I'm doing* — the method I committed to, the audience I'm writing for, the real goal behind the current task. The "Telegram is the test surface" context is exactly this missing category.
2. **Unification.** A dozen single-purpose watchers, each with private state, is itself the whack-a-mole pattern one level up. They should feed and read one ranked, decaying working set.
3. **A continuous mid-task injection surface.** Today injection happens at session-start (briefing) or pre-send (ArcCheck). Nothing re-grounds me *in the middle of a task* when a faded-but-now-relevant context should come back — which is precisely the moment the drift incident needed it.

---

## Non-negotiable principle: zero manual capture

Justin flagged the line *"items are added manually"* as a violation of a standing Instar rule — and he's right, more deeply than it first looks. **It doesn't matter whether the "manual" actor is the user or the agent — manual capture is the failure either way.** The drift incident is the proof: I *had* Playbook available the whole time and never ran `playbook add` to capture "Telegram is the test surface." Relying on the agent to remember to save a context is the exact "willpower, not structure" anti-pattern that caused the drift in the first place.

So a hard constraint on this whole effort: **capture is automatic or it doesn't exist.** No "remember to log it" step survives into the design, for user or agent. (Topic-intent already honors this — its LLM extractor needs no one to press a button. That's the bar.)

## Proposed architecture

```
          ┌─────────────────────────────────────────────┐
          │   Live conversation + action stream           │
          └───────────────┬───────────────┬───────────────┘
                          │ (reads)        │ (reads)
                ┌─────────▼──────┐   ┌─────▼────────────┐
                │  LIBRARIAN     │   │  USHER           │
                │  auto-capture  │   │  grounding watch │
                │  (generalizes  │   │  (adds the       │
                │   topic-intent │   │   missing mid-   │
                │   extractor)   │   │   task surface)  │
                └─────────┬──────┘   └─────┬────────────┘
                          │ writes          │ queries
                ┌─────────▼─────────────────▼────────────┐
                │   WORKING AWARENESS STORE                │
                │   (Playbook + memory + topic-intent      │
                │    confidence/decay model, unified)      │
                │   world  +  capabilities  +  standards   │
                │   ranked · time-horizoned · decaying     │
                └─────────┬────────────────────────────────┘
                          │ injection DECISION (full-context gate)
                          ▼
                Inject into primary agent — only when it
                changes what the agent does next.
```

### Two key design choices

**Signal vs. authority** (a standing Instar principle, already embodied in topic-intent's user-authority clamp and ArcCheck-as-signal). The Librarian and Usher are *cheap, fast* and emit **signals**: "this might matter," "this might be worth re-surfacing." A **higher-context decision step** decides whether to actually inject or stay silent. This is exactly Justin's "separate LLM that observes the results and determines what, if any, should be shared."

**Near-silent by default.** A continuous loop that chatters becomes the next thing dismissed 73 times. The Usher injects only when it would **change the agent's next action**. Everything else goes to a pull surface (a dashboard tab), never into the agent's face. Cost is bounded by the existing rate-limited LLM queue.

### The hierarchy of contexts (short / medium / long)

Justin's "hierarchy of important contexts" maps to time horizons, and decay rate is the knob — topic-intent's grace-period + half-life model is the prototype we generalize:

- **Short-term (this task/tangent):** "we're testing over Telegram right now." High weight, fast decay.
- **Medium-term (this project/relationship):** "this project's release-cut auto-publishes on any non-template NEXT.md." Survives sessions, decays over weeks if unused.
- **Long-term (identity/values/constraints):** "Justin wants ELI16, always." Near-permanent; lives in identity/ORG-INTENT.

Decay is **demotion, not deletion**. A faded context drops out of the hot set but stays retrievable, and a later reference re-warms it — exactly the human-memory behavior Justin described.

---

## What this is NOT

- **Not** a pile of per-symptom detectors. One general lifecycle, not a sentinel per drift-type.
- **Not** greenfield. It generalizes and unifies a pattern we already prototyped (topic-intent) and watchers we already run.
- **Not** dependent on anyone remembering anything. Zero manual capture, full stop.
- **Not** a hard blocker. Deviation stays possible — the point is to make it a *flagged, conscious choice*, not a silent slide.
- **Not** always-on-at-any-cost. Cadenced, budgeted, near-silent.

## Evolution path (smallest real steps first)

0. **Ship topic-intent.** It's the seed crystal, already designed and mostly built. Get it onto main, wired, and running — that alone proves auto-capture + decay + briefing + pre-send gating in production.
1. **Generalize capture beyond conversational facts.** Extend the extractor to capture *task contexts* (method, audience, goal), writing into the same confidence/decay store.
2. **Unify the store.** Bring Playbook + memory + topic-intent under one ranked, decaying working set with one read path.
3. **Index capabilities and standards as context (inward + normative facets).** Load capability descriptors (from `/capabilities` + the conversational-actions catalog) and the Standards registry into the same store as long-term, near-zero-decay items with triggers. Building the first-class **Standards registry** (rule + explanation + history + link to the founding goal) is high-leverage early — it's the source of truth the spec-review conformance gate reads from, and it can ship before any continuous machinery exists. Cheap, high-leverage, and it makes both automatic feature discovery and standards-aware building possible without any new matching engine.
4. **Add the Usher (signal-only).** A mid-task watcher that emits "you may want context X" or "this fits feature Y" to a surface — measure precision before it's allowed to inject. One Usher serves both halves.
5. **Gated mid-task injection / suggestion.** Only once precision is trustworthy, let the full-context gate inject context or suggest a feature mid-task, near-silently.

Each rung is independently useful and independently safe to stop at.

---

## A process note this effort exposed

This doc's *first* draft shipped a design that quietly violated the "no manual work" standard, and the review didn't catch it — Justin did. That's its own lesson: **our spec-review process should include an explicit pass that checks a draft against Instar's standing standards** (no manual user/agent work, structure-beats-willpower, framework-agnostic, signal-vs-authority, near-silent notifications, full three-tier testing, migration parity). A standards-conformance checklist baked into the review is itself "structure beats willpower" applied to how we write specs. Its source of truth is the **Standards registry** described in the normative-facet section above — the gate is only as good as the registry it reads from, which is why the registry is a first-class deliverable, not an afterthought.

---

## Why this is the right north star

The agent's whole value is *coherence* — being the same grounded entity whether it's writing an email, driving a test, or chasing a bug. Drift is the slow leak in that coherence. We've been patching leaks one at a time. This is the decision to build the thing that keeps the agent grounded *in general* — to make "structure beats willpower" true for **attention**, not just procedure. Every session the working-awareness loop runs, the next session starts more grounded than the last.

*Disagree with any of this? It's a beacon, not a contract — it's supposed to move.*
