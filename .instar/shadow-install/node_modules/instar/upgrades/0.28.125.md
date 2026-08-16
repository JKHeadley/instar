# Upgrade Guide — v1.0.13

<!-- bump: patch -->

## What Changed

Wires the v0.1 conversational-action catalog primitives (`discoverActions`, `renderCatalogBlock` from PR #256) through Instar's three pre-built bloat defenses — ContextHierarchy Tier 2 segment, SelfKnowledgeTree probe, and Playbook context item. The v0.1 deliberately shipped the catalog as pure data with no inlining into AGENT.md, because Instar already has structural defenses against AGENT.md bloat. This release wires the consumers.

The catalog content lives in the `conversational-catalog` SelfKnowledgeTree probe — generated fresh on each probe call, never cached. The new ContextHierarchy Tier 2 segment `.instar/context/conversational-actions.md` is the dispatch instruction (when the agent is in an intent-interpretation moment, this segment tells it to fetch the catalog via the probe). The new `conversational-catalog.json` Playbook manifest item is the third on-demand loader — Playbook's scoring engine surfaces the pointer when intent-interpretation triggers fire. All three paths are on-demand by design. The catalog is never inlined into the always-loaded identity prompt.

A semantic correctness test asserts that the Tier 1 loadTier output does not contain the conversational-actions segment content. If a future PR accidentally re-introduces AGENT.md inlining, the test fails.

## Evidence

Reproduction prior to this release: a user says "let's switch to local model" in conversation. The agent has no on-demand path to discover the available conversational actions — `.instar/skills/` exists on disk but the agent has no instruction to consult it for intent interpretation, no probe registered at server boot, and no Playbook item surfaced by the scoring engine. The agent falls back to asking the user for a slash command, breaking the conversation-default promise.

Observed after this release: same setup, three on-demand load paths come alive. The dispatch table for the new Tier 2 segment fires on the `interpreting-user-intent` trigger; the segment instructs the agent to invoke the `conversational-catalog` probe. The probe calls `discoverActions` + `renderCatalogBlock` and returns the live catalog. The agent matches the user's intent against the catalog and routes to the local-model skill. The slash-command surface is never shown.

Unit-test verification: three new ContextHierarchy tests (segment content presence, dispatch table registration, Tier 1 loadTier exclusion) and three new PostUpdateMigrator tests (manifest install when missing, idempotency on second run, refresh on content drift). The existing 19 ContextHierarchy tests continue to pass.

## What to Tell Your User

- "When you say something like 'let's switch to local' or 'send Dawn a message', I now have three independent on-demand paths to discover the right action without you having to know a slash-command name. The catalog is generated live on each lookup, never inlined into my always-loaded identity prompt, and the bloat-aware design is asserted-against in the test suite so a future regression can't sneak it back in."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conversational-actions ContextHierarchy segment | Automatic. The Tier 2 segment loads on `interpreting-user-intent`, `matching-to-skill`, or `translating-conversation-to-action` triggers. |
| `conversational-catalog` SelfKnowledgeTree probe | Automatic. Registered at server boot when `selfKnowledgeTree` is enabled. The probe walks `.instar/skills/` and returns the live catalog on each call. |
| Playbook conversational-catalog manifest | Automatic install via PostUpdateMigrator; mount with `instar playbook mount` (explicit consent per Playbook design). |

## Deferred (Tracked Follow-ups)

- HTTP endpoint `/capabilities/conversational-catalog` is referenced in the segment as a third fallback after the probe; not implemented in this PR. The probe is the canonical access path; the HTTP endpoint is a future convenience.
- Future v0.3 may add new triggers to the manifest template; PostUpdateMigrator's content-sniff guard will refresh the manifest on update without operator action.
