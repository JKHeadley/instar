# Side-Effects Review — Secret-Retrieval-First Standard

**Version / slug:** `secret-retrieval-first-standard`
**Date:** `2026-06-07`
**Author:** `echo`
**Tier:** `1` (docs/template + idempotent migration; no runtime behavior, no deps/routes/stores)
**Second-pass reviewer:** `not-required (Tier-1 guidance/template change; correctness self-owned + covered by 3 unit tests)`

## Summary of the change
Inverts the CLAUDE.md Secret Drop "When to use" guidance from "use Secret Drop the moment you need a credential — the ONLY correct way" to **agent-retrieves-first; Secret Drop is the last resort**. Applied across all three Migration-Parity surfaces: the template (`generateClaudeMd`), the migrator inject-block (agents missing the section), and a new content-sniff patch in `migrateClaudeMd` that rewrites the harmful trigger for already-deployed agents.

Files: `src/scaffold/templates.ts` (template guidance), `src/core/PostUpdateMigrator.ts` (inject-block text + new content-sniff patch), `tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts` (+3 tests), `docs/specs/secret-retrieval-first-standard.md` (+ .eli16).

## Decision-point inventory
- **Runtime behavior change?** None. This is agent-facing guidance text only — no code path, route, store, config, or scheduler is touched. Secret Drop itself (endpoints, retrieve script, durability) is unchanged.
- **New dependency / state / route / config?** None → trips none of the SqliteRegistry-wiring / feature-delivery-completeness / docs-coverage(new-class) guard classes.
- **Migration parity?** Satisfied on all three surfaces (template for new inits; inject-block for agents lacking the section; content-sniff patch for agents with the old section). The content-sniff patch is **idempotent** — it anchors on the stable old phrase `It is the ONLY correct way to collect a secret.` and skips once `AGENT-RETRIEVES-FIRST` / the new wording is present. Unit-tested (rewrite / idempotent / fresh-inject).
- **Silent fallbacks?** None added. No new `try/catch`; pure string edits + one guarded `content.replace`.
- **Shadow-capability slicer (AGENTS.md for Codex/Gemini)?** Inherits the corrected CLAUDE.md text automatically (the slicer copies sections from CLAUDE.md) — no separate edit needed; this is a positive side-effect (shadows stop carrying the wrong default too).
- **Secret-handling safety baked into the new guidance:** explicitly tells agents to extract only the needed var, never print the value, and delete multi-secret temp files immediately — codifying the safe-retrieval discipline I followed pulling the value from `the-portal` env.
- **Rollback?** Trivial — revert the three edits; guidance returns to prior wording, no state to unwind.

## Why ship
A wrong default in the template propagates to every agent (and every shadow). Justin flagged it as a UX violation (2026-06-07) and directed the standards amendment. Fixing it in the artifact agents read — not by per-agent willpower — is the Structure > Willpower path.
