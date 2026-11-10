## What Changed
The machine-coherence guard now compares each machine's default model (`sessions.frameworkDefaultModels` for `claude-code` and `codex-cli`; an empty setting is advertised as `account-default`). A machine whose default differs from the others raises the usual "my machines have drifted apart" alarm. Found live on 2026-11-09: topic 141133 was placed on Mama PC, which had no Claude default, so it ran Fable 5.1 while the Studio and Mac Mini defaulted to Opus 5.5.

## What to Tell Your User
If your machines are set to different default models, I'll now tell you, name the machines, and offer to line them up, so a conversation doesn't quietly switch models when it moves to another machine.

## Summary of New Capabilities
- Default-model drift across an agent's machines is detected and raised by the machine-coherence guard.

## Evidence
- `tests/unit/machine-coherence-default-model.test.ts`: Opus 5.5 next to an empty default produces a skew row; matching defaults produce none; values stay inside the advert clamp.
- Live: `GET /topic-profile/141133` resolved `claude-opus-5-5` (frameworkDefaultModels) on the Studio and Mac Mini, `null` (account-default) on Mama PC and the Laptop.
