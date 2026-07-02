<!-- bump: patch -->

## What Changed

The last hardcoded-model callsites from the LLM Routing Registry audit ("Risk
items" #3/#5/#6/#7) are now overridable configuration with behavior-preserving
inline defaults — with nothing set, every callsite behaves byte-for-byte as
before, and nothing is written to any config file (absence IS the default; no
migration needed).

- `DispatchExecutor.runAgentic`'s spawned dispatch session model:
  `intelligence.pinnedModels.dispatchAgentic` (default 'haiku', unchanged).
- The anthropic-headless credential-probe validation ping:
  `intelligence.pinnedModels.anthropicCredentialProbe` (default now sourced
  from `ANTHROPIC_MODELS.haiku` in the central tier map instead of a
  free-floating `'claude-haiku-4-5'` literal, so a future model bump cannot
  silently miss it).
- The setup wizard's narrative models (codex + gemini drivers): env-var
  overrides `INSTAR_WIZARD_CODEX_MODEL` / `INSTAR_WIZARD_GEMINI_MODEL` — env
  not config, because the wizard runs before `.instar/config.json` exists.
  `setup.ts`'s duplicate `WIZARD_CODEX_MODEL` const collapsed into a single
  source of truth in `setup-wizard/model-constants.ts` (re-exported, canary
  contract preserved).
- Honest audit correction: risk item #4 (mentor loop → 'opus') needed no code
  change — it was already config-driven via `mentor.autonomousFix.model`; a
  canary test now pins that fact.

15 new unit tests cover both sides of every boundary (absent ⇒ shipped
default, present ⇒ override wins, whitespace ⇒ absent) plus wiring canaries
asserting `server.ts` threads both config keys. This is step one of the
INSTAR-Bench v2 program (operator-approved 2026-07-02): before benchmark
results can drive model routing, every model choice must be reachable by
configuration rather than buried in code.

## What to Tell Your User

Nothing proactively — this changes no behavior on its own. If your operator
asks: a handful of my internal helpers (the background dispatch runner, my
setup wizard's text generator, and the tiny "does this credential work?"
check) had their AI model choice typed directly into my code; those choices
are now ordinary settings, with the old models still used unless someone
deliberately changes them.

## Summary of New Capabilities

- New config block `intelligence.pinnedModels` (`dispatchAgentic`,
  `anthropicCredentialProbe`) — inline-defaulted, absent means today's
  behavior exactly.
- New env overrides `INSTAR_WIZARD_CODEX_MODEL` / `INSTAR_WIZARD_GEMINI_MODEL`
  for the pre-config setup wizard.
- New adapter config field `credentialProbeModel` on anthropic-headless.
