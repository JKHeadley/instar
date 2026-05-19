# Upgrade Guide — v1.0.6

<!-- bump: patch -->

## What Changed

Lands the Conversational-action primitive (Layer-3 required primitive #10) — but **deliberately narrow**: pure-data catalog primitives only, no direct AGENT.md write.

Foundational stance, locked 2026-05-18 per Justin: users should never have to know any Instar internals. Conversational is the default; slash-commands are a backstop. When the user says "let's switch to local" the agent recognizes that intent and either invokes /local-model or guides the user there — without surfacing the slash-command name.

For the agent to translate intent to action, it needs a catalog of what is invocable. The earlier draft of this PR would have written that catalog directly into AGENT.md (the always-loaded identity file). After a scope-coherence pause + Justin's research request, we caught that this contradicts three Instar systems built specifically to prevent AGENT.md bloat: ContextHierarchy (Tier 0/1/2 segments), Playbook (scored decaying items), Self-Knowledge Tree (on-demand probes). So we removed the AGENT.md-writing API from v0.1.

v0.1 ships only the pure-data primitives:
- discoverActions(projectRoot) walks .instar/skills/ and returns the discovered actions sorted by name
- renderCatalogBlock(actions) generates a stable markdown block as a string (caller decides where it lands)

v0.1 explicitly does NOT ship:
- A function that writes the catalog into AGENT.md. v0.2 will route the catalog through ContextHierarchy Tier 2 segments (loaded on demand when the agent is interpreting user intent), a Self-Knowledge Tree probe (queried on demand), and a Playbook item (scored + decaying). All three load conditionally, not always.
- Authed POST execution endpoints. v0.2 with per-action shape declarations + trust integration.
- The user-invocable: true frontmatter filter. v0.2 once Skill primitive surfaces that field.

14 unit tests cover discovery and rendering, including a structural assertion that the AGENT.md-writing API is absent from the public surface — the bloat-aware design is enforced at the test layer.

Spec at specs/instar-concepts/conversational-action.md (converged + approved per hybrid-C pre-auth). ELI16 + convergence report alongside. Side-effects review documents the amendment in full.

## What to Tell Your User

- "The first piece of the conversational-action primitive is built — it discovers what is invocable and generates the catalog. The wiring step is held until v0.2 so we can load the catalog only when the agent needs it, instead of inlining it into the always-on identity prompt. That avoids the context-bloat trap we hit three times before."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conversational action catalog (pure-data) | Import discoverActions and renderCatalogBlock from src/providers/parity/conversationalActionCatalog.js. Walks installed skills, generates the catalog block as a string. |
| Bloat-aware design enforced at test layer | The applyCatalogBlock API is deliberately absent from the public module exports; a structural test asserts this. |

## Deferred (Tracked Follow-ups)

- v0.2 wiring through ContextHierarchy Tier 2 segment + SelfKnowledgeTree catalog probe + Playbook context item (all three on-demand loaders).
- v0.2 FrameworkParitySentinel wiring as a catalog-drift parity rule.
- v0.2 authed POST /api/conversational/execute endpoints with per-action shape declarations + trust integration.
- v0.2 user-invocable: true frontmatter filter (pending Skill v0.2 field surface).
- InstructionFile primitive (separate spec, next) — decides what minimal pointer goes into framework-native instruction files.
- Intent-classification examples in skill frontmatter.
