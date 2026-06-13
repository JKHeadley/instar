# WS5.2 Step 9 — Migration parity + CLAUDE.md awareness for live credential re-pointing (dark)

<!-- bump: patch -->

<!--
  NOTE: docs + migration parity ONLY. No runtime behavior. Two src files touched —
  src/scaffold/templates.ts (generateClaudeMd: new awareness section for new agents)
  and src/core/PostUpdateMigrator.ts (migrateClaudeMd: the same section, content-sniffed
  + idempotent, for existing agents). The config-defaults half of Migration Parity is
  already satisfied by construction: SHARED_DEFAULTS.subscriptionPool.credentialRepointing
  (enabled:false + dryRun:true + manualLeversEnabled:true) is carried into getMigrationDefaults
  and added to existing configs by the generic applyDefaults add-missing merge — this step adds
  the parity TEST that proves it (installs on a config lacking it; never clobbers an operator's
  explicit enabled:true). The /credentials/* routes were already in CapabilityIndex (Step 7).
  No new config flag, no credential write path, dark-gate line-map UNCHANGED.
-->

## What Changed

Closes the Migration Parity + Agent Awareness gap for live credential re-pointing: existing agents (not just fresh installs) learn the `/credentials/*` manual levers and the zero-touch default-account flip on their next update, and the dark config defaults are proven to install in place.

- **CLAUDE.md awareness (new + existing agents)** — `generateClaudeMd()` (new agents) and `migrateClaudeMd()` (existing agents, content-sniffed + idempotent) both gain a "Live Credential Re-pointing" section documenting the levers (`GET /credentials/locations`, `POST /credentials/swap`, `POST /credentials/set-default`, `POST /credentials/restore-enrollment`, `GET /credentials/rebalancer`) and the two proactive triggers: "flip my default account" → `set-default`; "which account is this slot on?" → `GET /credentials/locations` (read the ledger, never infer from `claude auth status`).
- **Config-defaults parity (proven)** — the dark `subscriptionPool.credentialRepointing` block (`enabled:false`, `dryRun:true`, `manualLeversEnabled:true`) already rides the generic `ConfigDefaults` → `getMigrationDefaults` → `applyDefaults` add-missing path onto existing agents. This step adds the parity test that proves it installs on a config lacking it AND never overwrites an operator who explicitly set `enabled:true`.
- **Dark** — every lever still 503s/no-ops behind the existing `subscriptionPool.credentialRepointing.enabled` flag. This step adds zero runtime behavior; it only makes the (still-off) feature discoverable and its dark defaults durable across the install base.

## What to Tell Your User

Nothing changes for you yet — the underlying feature is still switched off. What this does is make me *aware* of it so that, once it's turned on after a review window, you can just say "flip my default account to X" or "which account is this session on?" and I'll know exactly which lever to use instead of guessing. It also makes sure that awareness reaches agents that were set up before this feature existed, not only brand-new ones — so the capability isn't silently missing on an older install.

## Summary of New Capabilities

No new runtime capability — this is the Migration Parity + Agent Awareness step. New + existing agents' CLAUDE.md now documents the live-credential-re-pointing levers and the "flip my default account" / "which account is this slot on?" proactive triggers, and the feature's dark config defaults are proven to install on existing agents without clobbering an operator's explicit settings. The feature itself remains dark behind `subscriptionPool.credentialRepointing.enabled`.

## Evidence

- `tests/unit/PostUpdateMigrator-credentialRepointing.test.ts` (8) — migrateClaudeMd adds the section when absent (with both proactive triggers + the dark-posture line + the `claude auth status` honesty caveat present), is idempotent (no duplicate on re-run, byte-identical), preserves prior content, and gracefully skips a missing CLAUDE.md; the generateClaudeMd template emits the same section (source parity); and migrateConfig installs the DARK credentialRepointing block on a config lacking it, NEVER clobbers an operator's explicit `enabled:true` (fills only the missing sibling default), and is idempotent.
- tsc clean; full `npm run lint` clean (dark-gate unchanged — no ConfigDefaults edit; the defaults already existed from Steps 1/7).
