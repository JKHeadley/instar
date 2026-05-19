---
title: "Conversational-action v0.2 — ELI16"
slug: "conversational-action-v02-eli16"
parent: "conversational-action-v02.md"
---

# Conversational-action v0.2 — explained simply

## What this finishes

Instar has a foundational stance: users should never have to know that Instar exists. Conversation is the default, slash-commands are a backstop. When the user says "let's switch to local," the agent should recognize that intent and either invoke the right action or guide the user there — without surfacing the slash-command name.

For the agent to translate intent to action, it needs a catalog of what's invocable. The v0.1 release shipped the catalog primitives — discoverActions walks the skills directory, renderCatalogBlock turns that into a markdown block. The v0.1 deliberately did NOT inline that catalog into AGENT.md. That was the bloat lesson Justin caught: Instar has three pre-built defenses against AGENT.md bloat (ContextHierarchy Tier 0/1/2 segments, Playbook scored items, SelfKnowledgeTree probes), and the catalog should route through them instead of always-on.

This release wires the catalog through all three on-demand loaders. The catalog content lives in the SelfKnowledgeTree probe (it's dynamic, generated fresh on every probe call). The ContextHierarchy Tier 2 segment is the dispatch instruction — when the agent is interpreting user intent or matching to a skill, the dispatch table tells it to load this segment, which in turn instructs the agent on how to fetch the catalog. The Playbook manifest item is the relevance signal — Playbook's scoring engine surfaces the catalog pointer when an intent-interpretation moment matches the item's load triggers.

## Three load paths, none of which inline

The structural promise: every load path is on-demand. No always-on. The conversational-actions content is not in Tier 0 (always loaded) or Tier 1 (session-boundary loaded); it's strictly Tier 2 (dispatched when triggers fire). The probe is invoked at the agent's discretion. The Playbook item is scored and decays.

A semantic correctness test in the suite asserts these properties directly. Tier 1 loadTier output must not contain the conversational-actions content. If a future PR accidentally re-introduces AGENT.md inlining, that test fails and the PR can't ship without a deliberate decision.

## What changes for you

For Justin: when the agent encounters an intent like "let's switch to local," the dispatch table fires the conversational-actions segment, which tells the agent to invoke the probe. The probe walks the skills directory at call time and returns the live catalog. The agent finds the local-model skill, invokes it, and the user never sees the slash-command surface. v1.0's conversational-default promise is structurally realized.

For deployed agents on update: the parity-renderings backfill (released earlier in this session) refreshes the ContextHierarchy segment. The new PostUpdateMigrator step ships the Playbook manifest template. Operators can mount it via instar playbook mount whenever they want; before mounting, the segment and probe still work (Playbook is the third on-ramp, not a required gate).

## What this is NOT

Not a UI change. Not a new primitive — the v0.1 catalog primitives are unchanged. Not an automatic Playbook mount — mounts are explicit operator consent per Playbook design; the manifest template is shipped, the mount is the operator's call. Not a return of applyCatalogBlock — that deliberate omission stands; the three on-demand loaders are the structural replacement.

## Why this completes v1.0

The framework functional parity roadmap had 11 required Layer-3 primitives. Conversational-action was the last one needing a v0.2 wiring step beyond its v0.1 primitives. With this release shipping the three on-demand loaders, the conversational-action layer is structurally complete. All 11 primitives have either native framework support, Instar-native fallback, or both. The audit-identified backfills (Sentinel mirror-trust, Migration Parity, Testing Integrity Tier-3) all landed earlier in this autonomous session.
