---
title: "Conversational action — ELI16"
slug: "conversational-action-eli16"
parent: "conversational-action.md"
---

# Conversational action — explained simply

## What it is

A **conversational action** is an Instar capability the agent can perform when the user asks for it in plain English. Instead of "type /spec-converge", the user says "let's review this spec" and the agent figures out which action to run.

The capability has two layers:
1. The **catalog** — the list of what the agent can do conversationally. Each entry has a name, a description, and what triggers it.
2. The **classifier** — the agent's LLM, at runtime, reading the catalog + the user's words and picking the right action.

This spec defines layer 1 (the catalog). Layer 2 is the agent's own intelligence using catalog + context to decide.

## Why it matters

Justin's foundational stance, locked 2026-05-18: **Instar users should not need to know any Instar internals.** Conversational is the default; slash commands are a backstop. If you have a new skill called `/local-model` and the user says "can we switch to local?" — the agent should recognize the intent and either invoke the action or guide the user through it. The user should never have to know that "local-model" is a thing.

For this to work, the agent needs a *catalog* of what's invocable, loaded into context **at the right moment** — not crammed into the always-loaded identity file.

## What's new in this spec

Two pure-data primitives:
1. `discoverActions(projectRoot)` — walks installed skills, returns the list as data.
2. `renderCatalogBlock(actions)` — generates a stable markdown block from that list, as a string.

**What we deliberately did NOT ship:** a function that writes the block into AGENT.md. Instar has hit AGENT.md bloat three times and built three defenses against it (`ContextHierarchy` tiered loading, `Playbook` scored decaying items, `SelfKnowledgeTree` on-demand probes). Inlining a 40-line skill catalog into the always-loaded identity file would burn through all three at once. v0.2 wiring goes through those infrastructures: a Tier 2 segment loaded only when the agent is "interpreting user intent", a probe queried on demand, a Playbook item that ages out if unused.

## What this is NOT

This spec doesn't classify intent at runtime — that's the agent's own LLM access. It doesn't execute the actions — the slash-command surface does that. It doesn't add authed POST endpoints (v0.2). It doesn't write to AGENT.md (deliberately deferred to v0.2 via the proper Tier 2 / probe / Playbook pathways). It just produces the catalog as composable data.

## What changes for the user

Nothing visible until v0.2 wires the catalog into the right loading vehicles. The agent will eventually be able to translate intent into action because the catalog is loaded *when relevant*, not memorized in always-on context. This preserves the "structure over willpower" principle: don't ask the agent to ignore irrelevant context — don't load it in the first place.
