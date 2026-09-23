# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Codex model tiers move to the GPT-6 family. `fast` (the light tier that
about 60 internal background checks request) goes from `gpt-5.6-sol` to
`gpt-6-luna`; `balanced` (also the default for Codex sessions launched with no
model) goes from `gpt-5.6-sol` to `gpt-6-sol`; `capable` stays `gpt-6-astra`. The
same map applies to the one-shot intelligence path (`TIER_TO_MODEL`) and the
session-launch path (`resolveModelForFramework`), and the two codex session
defaults that were hardcoded literals now look the `balanced` tier up, so they
cannot drift from the map again. `gpt-6-sol` and `gpt-6-luna` join
`KNOWN_CODEX_MODEL_IDS` and the model-registry manifest.

The retirement safety floor `CODEX_CHATGPT_FALLBACK_MODEL` deliberately stays
`gpt-5.6-sol`. Codex CLI 0.153.4 refuses `gpt-6-luna` and `gpt-6-sol` with the
exact ChatGPT-account "not supported" 400 that the existing one-shot self-heal
already catches, so an agent on an older CLI retries onto the floor and keeps
working rather than failing. Interactive and job sessions have no such retry: on
a CLI older than 0.156 a Codex session launched on the light or medium tier will
report the model as unsupported until Codex is upgraded
(`npm install -g @openai/codex@latest`).

## What to Tell Your User

My light background checks now use gpt-6-luna, the smallest current Codex
model, and everyday Codex work uses gpt-6-sol. If you run Codex sessions and
your Codex app is older than version 0.156, update it; background checks keep
working either way, but a Codex session on an old version will refuse these models.

## Summary of New Capabilities

- Light internal Codex checks run on gpt-6-luna instead of gpt-5.6-sol.
- Medium-tier Codex work and default Codex sessions run on gpt-6-sol.
- Background checks on an older Codex CLI fall back automatically to gpt-5.6-sol.

## Evidence

- Live probe 2026-09-23, Mac Mini, ChatGPT-account Codex. On codex CLI 0.153.4:
  gpt-6-luna and gpt-6-sol returned 400 "The '<id>' model is not supported when
  using Codex with a ChatGPT account"; gpt-6-astra and gpt-5.6-sol answered. After
  upgrading to 0.156.1 all four answered (gpt-6-luna 2,734 tokens, gpt-6-sol
  2,145). The same upgrade + probe on the Laptop: luna, sol and astra all answered.
- A new unit test feeds the exact 0.153.4 refusal text for the light and medium
  tier ids to `classifyCodexErrorMessage` and asserts `unsupported`, the signature
  the self-heal retries on; another pins the floor to an id outside the GPT-6 tiers.
- `lint-model-registry-freshness` passes with the two new rows.
