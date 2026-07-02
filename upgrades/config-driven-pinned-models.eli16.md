# The last few "model choices burned into the code" are now settings

Instar makes hundreds of small AI calls a day — checking messages, validating credentials, running its setup wizard, executing background dispatch steps. For almost all of them, WHICH model gets used is a setting an operator can change. But an audit this week found a handful of stragglers where the model name was typed directly into the code: the background dispatch runner always spawned "haiku", the setup wizard always asked "gpt-5.3-codex" (or "gemini-2.5-flash") to write its intro text, and the credential checker always pinged Anthropic with a hard-typed "claude-haiku-4-5". If benchmarking ever showed a better/cheaper model for one of these jobs, changing it meant editing source code and shipping a release — for what should be a one-line setting.

This change makes those last callsites configurable, with one iron rule: **if you change nothing, nothing changes.** Every one of them keeps exactly its old model as the built-in default. The new settings don't even get written into config files — absence IS the default, so no existing agent's config is touched on update, and there is nothing to migrate.

The specifics, in plain terms:

- The background dispatch runner's model can now be set in config (`intelligence.pinnedModels.dispatchAgentic`). Unset, it's "haiku" like always.
- The credential checker's tiny "does this key work?" ping model is configurable too (`intelligence.pinnedModels.anthropicCredentialProbe`) — and its default now comes from the central model list instead of a lone typed-out string, so a future Claude model bump can't silently miss it.
- The setup wizard is special: it runs BEFORE the config file exists (creating that file is its whole job), so a config setting could never reach it. Its override is an environment variable instead (`INSTAR_WIZARD_CODEX_MODEL` / `INSTAR_WIZARD_GEMINI_MODEL`), which is the only kind of setting that CAN reach it.
- One honest discovery: the mentor loop — listed in the audit as hardcoded to "opus" — turned out to already be configurable (`mentor.autonomousFix.model`); the audit row was wrong. A test now pins that so the record stays honest.

Also cleaned up: the wizard's codex model name was typed in TWO places that could drift apart; now there's one source of truth that the other re-exports.

Safety story: this adds no new decision-making, no gating, no blocking — it only lets an operator choose the model for five existing, unchanged jobs. Fifteen new tests prove both directions on every surface: leave it unset and you get byte-for-byte the old behavior; set it and your value wins; set it to whitespace and it's treated as unset. The existing wizard canary tests (which pin the "-m model" discipline on every codex spawn) pass unmodified. Rollback is deleting a config line.

Why now: this is step one of the INSTAR-Bench v2 program (operator-approved 2026-07-02) — before benchmark results can drive model routing, every model choice has to be reachable by configuration rather than buried in code.
