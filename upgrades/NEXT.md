# Upgrade Guide — v1.2.10 (Codex wizard model pin)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: Codex setup wizard now passes a working model name.**

`instar setup --framework codex-cli` and the v1.2.1 bareword runtime
prompt both spawn Codex without passing `-m`/`--model`. Codex CLI
falls back to its bundled default, `gpt-5.2-codex`, which OpenAI
retired from ChatGPT-subscription accounts on 2026-04-14. The first
real end-to-end install attempt by a ChatGPT-subscription user
returned a 400 from OpenAI before the wizard could render:

```
The 'gpt-5.2-codex' model is not supported when using Codex with a
ChatGPT account.
```

The fix:

- New module constant `WIZARD_CODEX_MODEL = 'gpt-5.3-codex'` in
  `src/commands/setup.ts`. The "balanced" tier from the existing
  empirically-probed availability table at
  `src/providers/adapters/openai-codex/models.ts`.
- Both `codex exec` spawns in setup.ts (the setup-wizard launch and
  the secret-setup micro-session) now include `-m
  WIZARD_CODEX_MODEL` in the argv.
- New unit-tier canary at
  `tests/unit/setup-codex-model-canary.test.ts` AST-greps every
  `framework === 'codex-cli'` exec block in setup.ts and refuses
  any block that omits the flag. If a future PR adds a third codex
  spawn without the flag, or removes the flag from either existing
  one, CI fails.

Spec: `specs/dev-infrastructure/codex-wizard-model.md`.
ELI16: `specs/dev-infrastructure/codex-wizard-model.eli16.md`.
Side-effects review: `upgrades/side-effects/fix-codex-wizard-model.md`.

## What to Tell Your User

The first-time-install path on Codex CLI now actually reaches the
wizard. Before this release, typing the bareword instar command and
picking Codex bounced off OpenAI with a model-not-supported error
before anything visible happened. After this release, the same flow
proceeds into the wizard prompt for identity, secrets, etc.

If you already have an OPENAI API-key style auth and want to use a
different Codex model, set the CODEX_MODEL env var — Codex CLI
honors it and overrides the wizard default.

## Summary of New Capabilities

No new capabilities. Behavior fix on top of v1.2.9.

## Evidence

Reproduction prior: ran `npx instar@1.2.9` inside a cloned project,
picked Codex CLI at the runtime prompt, observed the exact 400
error above and the wizard never rendering.

After: the canary unit test passes. End-to-end re-test on
ChatGPT-subscription Codex auth pending on publish.
