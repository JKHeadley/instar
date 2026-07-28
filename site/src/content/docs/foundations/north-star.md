---
title: North Star — Continuous Working Awareness
description: The homing beacon for Instar's evolution — an agent that never silently loses track of something that mattered.
---

An Instar agent should never silently lose track of something that mattered. When an important context surfaces — "we're testing over Telegram," "this customer hates jargon," "the real goal is X, not the bug I'm chasing" — it should be **captured automatically**, ranked by how much it matters and over what horizon, **kept warm** while relevant, **re-surfaced** the moment it matters again, and **allowed to fade** once it stops. None of it can depend on anyone — user or agent — remembering to do it by hand. Capture is automatic or it doesn't happen.

That's the North Star: a continuously-maintained *working awareness* that keeps the agent grounded no matter when, where, or how it operates.

:::note
This page is the digestible version. The **full vision doc** — with the architecture deep-dive, the honest inventory of what already exists, the live case studies, and the staged evolution path — is the canonical source at [`docs/NORTH-STAR.md`](https://github.com/JKHeadley/instar/blob/main/docs/NORTH-STAR.md) in the repo. It's a beacon, not a contract; it's meant to move as the framework learns.
:::

## Three facets that are really one thing

"Awareness" has three faces, and they're the same machine pointed in different directions:

- **Awareness of the world** — tasks, conversations, goals, constraints. "We're testing over Telegram right now."
- **Awareness of itself** — its own capabilities and features. "I have a Secret Drop feature that's perfect for this."
- **Awareness of its standards** — the principles that guide how it builds. "This feature would violate framework-agnostic."

An agent that forgets the test surface, an agent that forgets its own feature, and an agent that ships a standards-violating feature are all failing the *same way*: a relevant context existed and never reached the moment it was needed.

## Drift is a context-lifecycle failure

The tempting fix for each kind of drift is a dedicated detector — watch for missing Telegram actions, watch for audience mismatch, watch for goal-drift. That's whack-a-mole: an ever-growing pile of brittle, single-purpose sentinels, each with its own stale state and its own dismiss-fatigue.

Step back and every one of these is the same failure:

> An important context **arose**, **mattered**, then **aged out** of the working set as the task evolved — and nothing **pulled it back** when it became relevant again.

So the fix isn't a detector per symptom. It's one general lifecycle for important contexts: **capture → rank → maintain → re-surface → decay.** Build that once, and method-drift, audience-drift, and goal-drift all fall out of it for free.

## The hierarchy of contexts

Different contexts live on different time horizons, and decay rate is the knob:

- **Short-term** (this task): "we're testing over Telegram right now." High weight, fast decay.
- **Medium-term** (this project/relationship): "this project auto-publishes on any non-template release note." Survives sessions, fades over weeks if unused.
- **Long-term** (identity/values): "Justin wants ELI16, always." Near-permanent.

Decay is **demotion, not deletion** — a faded context drops out of the hot set but stays retrievable, and a later reference re-warms it, exactly like human memory.

## The architecture

```
          Live conversation + action stream
                  │ (reads)        │ (reads)
          ┌───────▼──────┐   ┌─────▼──────────┐
          │  LIBRARIAN   │   │  USHER         │
          │ auto-capture │   │ grounding watch│
          └───────┬──────┘   └─────┬──────────┘
                  │ writes          │ queries
          ┌───────▼─────────────────▼──────────┐
          │   WORKING AWARENESS STORE            │
          │   world + capabilities + standards   │
          │   ranked · time-horizoned · decaying │
          └───────┬──────────────────────────────┘
                  │ injection decision (full-context gate)
                  ▼
          Inject into the agent — only when it
          changes what the agent does next.
```

Two design choices carry the whole thing:

- **Signal vs. authority.** The Librarian and Usher are cheap and fast, and they only emit *signals* — "this might matter," "this might be worth re-surfacing." A higher-context decision step decides whether to actually inject or stay silent.
- **Near-silent by default.** A loop that chatters becomes the next thing dismissed 73 times. The Usher injects only when it would change the agent's next action. Everything else goes to a pull surface, never into the agent's face.
- **The right to interrupt is earned, not assumed.** Before the Usher is ever allowed to inject mid-task, it has to prove its re-surface signals are useful. `UsherSignalStore` records every fired signal and its precision (`acted / fired`); `UsherActedCorrelator` credits a signal when the agent's next reply actually uses the re-surfaced context, or when the user later has to correct the agent on something a nudge already flagged. That measured precision is the hard precondition on the final rung — the loop must demonstrate accuracy before it gets to interrupt. See [Observability](/features/observability/) for the live metrics.

## Not starting from scratch

The North Star isn't greenfield — it generalizes a loop Instar already prototyped. The in-progress **Topic-Intent Layer** is almost exactly this capture→rank→decay→inject→gate loop, scoped narrowly to conversational facts: an LLM auto-captures every substantive turn (no manual step), ranks each item with a user-authority clamp, decays them on a grace-period-plus-half-life model, injects a settled-vs-tentative briefing at session start, and gates pre-send drafts.

The genuine gaps are three: **generality** (capture *what I'm doing*, not just conversational facts), **unification** (a dozen single-purpose watchers should feed one ranked working set), and a **continuous mid-task injection surface** (today injection happens at session-start or pre-send, never in the middle of a task when a faded-but-now-relevant context should return).

## Why this is the right north star

The agent's whole value is *coherence* — being the same grounded entity whether it's writing an email, driving a test, or chasing a bug. Drift is the slow leak in that coherence, and Instar has been patching leaks one at a time. The North Star is the decision to build the thing that keeps the agent grounded *in general* — to make "structure beats willpower" true for **attention**, not just procedure. Every session the loop runs, the next session starts more grounded than the last.

The [Standards Registry](/foundations/standards-registry/) is the first tangible artifact of this vision — the normative facet (awareness of standards) made real, ahead of the continuous machinery that will eventually surface it automatically.

---

*Disagree with any of this? It's a beacon, not a contract — it's supposed to move. The [full vision doc](https://github.com/JKHeadley/instar/blob/main/docs/NORTH-STAR.md) has the complete architecture, inventory, and evolution path.*
