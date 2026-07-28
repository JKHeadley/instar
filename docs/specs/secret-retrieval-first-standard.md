---
title: Secret-Retrieval-First Standard — agent fetches secrets it can reach; Secret Drop is the last resort
date: 2026-06-07
author: echo
parent-principle: "Structure > Willpower"
parent-principle-fit: "The wrong default ('the moment you need a credential, use Secret Drop — the ONLY correct way') was baked into the CLAUDE.md template, so every agent inherited it and threw avoidable work at the user for secrets the agent could fetch itself. Fixing the behavior by 'remembering to try harder' is willpower; fixing it in the template + a content-sniffing migration so every agent — new and already-deployed — carries agent-retrieves-first is structure. This change moves the correct default into the artifact agents actually read."
review-convergence: single-pass-self-review-2026-06-07
review-convergence-detail: "Low-risk docs/template + migration change (no runtime behavior, no new deps/routes/stores). Self-reviewed against the diff: (a) template guidance inverted; (b) migrator inject-block embedded text inverted so freshly-injected sections are correct; (c) NEW content-sniff patch rewrites the harmful 'ONLY correct way' trigger for already-deployed agents, idempotent (anchors on the stable old phrase; skips once the inversion is present), mirroring the adjacent store-first-durability patch. Covered by 3 new unit tests (rewrite / idempotent / fresh-inject) atop the existing 18 in PostUpdateMigrator-secretDropHardenedRetrieve.test.ts — all 21 green; tsc clean. Migration Parity satisfied across all three surfaces."
approved: true
approved-by: Justin
approved-via: "Telegram topic 12476 (2026-06-07): direct instruction after I issued a Secret Drop for a webhook secret readable from his own Vercel project — 'Why do you think I have such easy access to some random secret? This is an INSTAR user experience violation... I don't see why you can't get the secret yourself. You have complete access to all accounts and complete approval from me so let's correct this behavior, including if needed amending our standards.' This spec IS that correction."
---

# Secret-Retrieval-First Standard

## Problem (2026-06-07 UX violation)
The CLAUDE.md template's Secret Drop guidance told agents: *"the moment a user offers to give you a credential … or you realize you need one, use Secret Drop. It is the ONLY correct way to collect a secret."* That default is wrong. It dumps avoidable work on the user and assumes the user keeps secrets on hand — even when the secret is sitting in an account the agent already has access to. Live instance: Echo issued a Secret Drop asking the operator to submit the feedback webhook HMAC secret (`INSTAR_WEBHOOK_SECRET`) that was readable directly from the operator's own Vercel project (`the-portal` → `vercel env pull`). The operator called it an INSTAR UX violation.

## Standard
When an agent needs a credential/secret, the order is:
1. **Retrieve it yourself** from an account/service you already have access to — the encrypted vault (`secret-get.mjs`), a Vercel project you can read (`vercel env pull`), GitHub (`gh`), a cloud console, etc. Agents run with full account access and standing operator approval; a secret already in one of the operator's accounts is the agent's to fetch, not the user's to produce. (Handle safely: extract only the one var, never print the value, delete any multi-secret temp file immediately.)
2. **Only if you genuinely cannot reach it yourself** (an operator-only credential the user actually holds): mint a one-time Secret Drop link **or** walk the user through obtaining it in a **mobile-friendly, step-by-step** way. Never assume the user has it on hand.
3. When a user **proactively offers** a credential, Secret Drop remains the correct collection mechanism (never accept it pasted into chat; never create a local file for the user to edit).

## Change (3 Migration-Parity surfaces)
- **Template** (`src/scaffold/templates.ts` `generateClaudeMd`): Secret Drop "When to use" rewritten to agent-retrieves-first / Secret-Drop-last-resort — fresh `init`s get the correct default.
- **Migrator inject-block** (`src/core/PostUpdateMigrator.ts` `migrateClaudeMd`): the embedded section injected into agents that lack a Secret Drop section now carries the new guidance.
- **Migrator content-sniff patch** (new, `migrateClaudeMd`): for agents that already have the old section, anchors on the stable harmful sentence (`It is the ONLY correct way to collect a secret.`) and rewrites it to agent-retrieves-first. Idempotent; mirrors the existing store-first-durability patch.

## Out of scope
No runtime behavior, no new deps/routes/stores/config. Pure guidance/standard change. The shadow-capability slicer (AGENTS.md for Codex/Gemini) inherits the corrected text from CLAUDE.md automatically.
