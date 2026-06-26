## What Changed

Fixed a config load-path bug that made the `pi-cli` framework permanently
unavailable on every deployed agent. `loadConfig` built the `sessions` block from
an explicit field list and never copied `sessions.frameworkDefaultModels` from
`.instar/config.json` — the same load-path gap class as the 2026-06-06
`componentFrameworks` fix sitting right beside it. Since the pi-cli provider
requires its model pattern (`frameworkDefaultModels['pi-cli']`) to build, the
pattern was always `undefined` at boot, the factory degraded pi-cli to null
("binary missing / not built"), and pi-cli was silently unavailable despite a
valid binary and correct config. Added the `frameworkDefaultModels` pass-through
(same `typeof === 'object'` guard) plus two unit tests (carries / omits-when-absent).

## What to Tell Your User

If you set up a default model for the Pi engine in your config, it now actually
takes effect — before, it was silently dropped at startup, so Pi could never turn
on. If you did not set one, nothing changes: Pi still only activates when both its
program is installed and a model is chosen. This restores the fast, reliable Pi
backend and gives you a real fallback option instead of a single point of failure.

## Summary of New Capabilities

- The per-framework default-model setting in your config is now honored at boot,
  unblocking Pi (and any per-framework default-model) routing.
- No new API surface; one additive, default-absent config field is now read.

## Evidence

- **Reproduction:** Load the real agent config through the v1.3.667 loader and
  inspect the sessions block — `sessions.frameworkDefaultModels` comes back
  `undefined` even though it is present in the config file (the loader omits it
  from its sessions field list, while `componentFrameworks`/`frameworkBinaryPaths`
  beside it survive).
- **Observed before:** `/intelligence/routing` reported `pi-cli available:false`;
  the boot log carried `framework 'pi-cli' unavailable (binary missing / not built)`
  and `pi-cli routing requested but no model pattern is configured`, despite a valid
  `pi` binary (0.78.1) and a correct config value.
- **Observed after:** The patched loader returns the model map intact; deployed to
  the running agent and restarted, `/intelligence/routing` shows `pi-cli
  available:true`, the tone gate routed to pi-cli served a real verdict, and a
  Telegram reply went through on the first attempt at ~6s (versus the slower,
  flaky fallback it had been stuck on).
