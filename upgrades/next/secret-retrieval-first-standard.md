<!-- bump: patch -->

## What Changed

The CLAUDE.md Secret Drop guidance now defaults to **agent-retrieves-first**: when an agent needs a credential, it first tries to fetch it itself from an account/service it already has access to (the encrypted vault, a Vercel project via `vercel env pull`, GitHub via `gh`, a cloud console). Secret Drop — or asking the user — is now the **last resort**, used only when the secret genuinely lives somewhere the agent cannot reach, and even then mobile-friendly and step-by-step. The prior wording told agents Secret Drop was "the ONLY correct way to collect a secret … the moment you realize you need one," which threw avoidable work at the user for secrets the agent could fetch itself. When a user proactively *offers* a credential, Secret Drop remains the correct collection mechanism.

Applied to all three Migration-Parity surfaces — the template (new inits), the migrator inject-block (agents missing the section), and a new idempotent content-sniff patch that rewrites the old harmful trigger for already-deployed agents.

## What to Tell Your User

Nothing you need to do. Behind the scenes, your agent now fetches secrets it can already reach on its own instead of asking you for them — so you should get fewer "please submit this secret" prompts for credentials that live in accounts the agent can access. It will still ask you (securely) only when a secret genuinely isn't reachable any other way.

## Summary of New Capabilities

No new endpoint, command, or config. A standards/guidance correction: agents default to retrieving secrets themselves; Secret Drop is the documented last resort.

## Evidence

- 21/21 unit tests green in `tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts` (3 new: trigger-rewrite, idempotent, fresh-inject-carries-new-wording; 18 pre-existing unchanged). `npx tsc --noEmit` clean.
- Origin (causal autopsy): **process-gap** — the wrong default was baked into the template/standard, so every agent inherited it. Live trigger: a Secret Drop issued for `INSTAR_WEBHOOK_SECRET` that was readable from the operator's own Vercel project (`the-portal`), flagged by the operator as a UX violation (2026-06-07, topic 12476).
- Migration Parity verified across template + inject-block + existing-agent content-sniff patch.
