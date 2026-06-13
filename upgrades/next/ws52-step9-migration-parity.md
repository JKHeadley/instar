# WS5.2 Step 9 — live-credential-repointing migration parity (dark)

<!-- bump: patch -->

<!--
  NOTE: migration + docs only. NO src behavior change beyond migration: no credential
  write, no new route, no runtime gate. Two halves of the Migration Parity Standard for
  the live-credential-repointing feature:
   1. CONFIG: the dark subscriptionPool.credentialRepointing block reaches EXISTING agents
      via the generic ConfigDefaults applyDefaults path in migrateConfig — the block lives
      in SHARED_DEFAULTS (Step 1), so add-missing installs enabled:false+dryRun:true
      idempotently and NEVER clobbers an operator-set enabled:true. NO hardcoded migrateConfig
      block added (single source of truth for the dark shape; no behavior creep). The
      config-block auto-detect in feature-delivery-completeness does NOT fire (no
      `if (!config.X) { config.X = {` pattern), and the dark-gate line-map is UNCHANGED
      (ConfigDefaults untouched — dark-gate 24/24 green as-is, no recompute).
   2. CLAUDE.md awareness: a new section in BOTH generateClaudeMd (new agents, **-bold form)
      AND migrateClaudeMd (existing agents, content-sniffed ### H3 form), registered in
      featureSections + BOTH shadow-marker variants (Codex/Gemini parity).
  CapabilityIndex /credentials routes were already registered in Step 7 — verified, not
  duplicated.
-->

## What Changed

Closes the migration gap for the live-credential-repointing feature: a deployed agent that auto-updates now picks up the dark config defaults AND the operator-facing awareness, not only a freshly-initialized one.

- **Config reaches existing agents, dark.** The `subscriptionPool.credentialRepointing` block (`enabled:false` + `dryRun:true` + `manualLeversEnabled:true`) lives in `SHARED_DEFAULTS`, so the generic `applyDefaults` path inside `migrateConfig()` add-missings it on update — idempotently, and it never overwrites an operator's deliberate `enabled:true`. No hardcoded migrator block was added: a single source of truth for the dark shape, no behavior creep.
- **CLAUDE.md awareness in both sites.** A new "Live Credential Re-Pointing" section is emitted by `generateClaudeMd()` for new agents and content-sniff-injected by `migrateClaudeMd()` for existing agents — so an existing agent is never blind to a capability a new agent sees. It carries the proactive triggers ("flip my default account" → `POST /credentials/set-default`; "which account is this session/slot on?" → `GET /credentials/locations`), states that the levers ship dark, and folds in the one-line `/switch-account` + `autoMigrate` deprecation note.
- **Framework parity.** The section is registered in `featureSections` plus both the `**`-bold and `### `-H3 shadow-marker variants, so Codex (`AGENTS.md`) and Gemini (`GEMINI.md`) agents learn it too.
- **Dark + no behavior creep.** Migration + docs only — no credential write, no new route, no runtime gate. `lint-no-unfunneled-credential-write` clean, dark-gate unchanged (ConfigDefaults untouched).

## What to Tell Your User

Nothing changes for you today. Under the hood, there is a feature I have been building that can move which of your subscription accounts a login slot serves — including flipping which account my default login points at — without restarting the sessions that are using it. That feature ships turned off and stays off until you choose to enable it after a review window. This step makes sure that when one of your already-running agents updates itself, it quietly picks up that same turned-off setting and learns how the feature works, exactly like a brand-new agent would. In other words, every machine you run me on ends up in the same safe, consistent starting state on its own, with no per-machine hand-setup. Once you do turn it on, you will be able to just say things like "flip my default account" or "which account is this session on?" and I will use the right levers — and I will tell you plainly if the feature is still disabled rather than improvising.

## Summary of New Capabilities

No new runtime capability and no new config flag — this is the migration + awareness half of the live-credential-repointing feature. Existing agents now receive the dark `subscriptionPool.credentialRepointing` config defaults and the "Live Credential Re-Pointing" CLAUDE.md awareness section (with `AGENTS.md`/`GEMINI.md` shadow parity) on auto-update, reaching parity with newly-initialized agents.

## Evidence

- `tests/unit/PostUpdateMigrator-credentialRepointing.test.ts` (7) — config dark-posture parity (a config without the block gets `enabled:false`+`dryRun:true`+`manualLeversEnabled:true`; a config with no `subscriptionPool` at all still gets it; an operator-set `enabled:true`+`dryRun:false` is NEVER clobbered; double-migration leaves a single dark block) and CLAUDE.md awareness (injects when absent with the proactive triggers + both routes + the dark statement + the `/switch-account` deprecation note; skips when present via content-sniff; idempotent — one section after a second run).
- `tests/integration/credential-repointing-migration.test.ts` (2) — the full `migrate()` pipeline over a realistic stale agent lands BOTH the dark config block and the awareness section, and is byte-stable + single-block + single-section on re-run.
- `tests/e2e/credential-repointing-awareness-parity.test.ts` (3) — the new-vs-migrated parity proof: a freshly scaffolded `generateClaudeMd()` CLAUDE.md and a migrated existing CLAUDE.md both carry the same section (same triggers, same routes); both sites name the identical lever pair.
- `tests/unit/feature-delivery-completeness.test.ts` (99) green — the section is tracked in `featureSections` + both shadow-marker variants; the config auto-detect does not fire (no hardcoded migrator block).
- tsc clean; `lint:credential-write` clean; dark-gate 24/24 unchanged (ConfigDefaults untouched, no recompute); docs-coverage green.
