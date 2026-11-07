# The Gemini spec reviewer gets past the trust check and names its failures

## What Changed
The gemini-cli cross-model spec reviewer had degraded on every run with the generic reason `error`. Measured on gemini CLI 0.67.0: a headless run outside a trusted folder exits 55, and once past that the CLI's login fails with `IneligibleTierError` (`UNSUPPORTED_CLIENT`, the "Gemini Code Assist for individuals" tier no longer serves this client). The reviewer now passes `--skip-trust` on its own gemini call only (an opt-in provider option; other gemini callers keep their exact argv), and maps the two failures to named degraded reasons: `gemini-untrusted-folder` and `gemini-tier-unsupported`. Older gemini CLIs that reject the unknown flag are retried once without it. The spec-level cross-model flag is computed exactly as before.

## What to Tell Your User
If your agent uses Gemini for spec review, a failure now tells you why. `gemini-untrusted-folder` means the gemini CLI refused to run in an untrusted folder. `gemini-tier-unsupported` means Google no longer accepts your Gemini login's tier for this CLI; that needs a different Gemini account or auth method and cannot be fixed by an update.

## Summary of New Capabilities
- The Gemini spec reviewer runs past gemini's trusted-folder check.
- Two named Gemini failure reasons replace the generic `error`.

## Evidence
tests/unit/gemini-reviewer-trust-and-tier.test.ts drives reviewer → factory → provider → a fake gemini that logs argv and replays the measured 0.67.0 stderr. 5 of its 7 tests fail on the original code; each of the two mappings, the reviewer opt-in, the provider flag and the old-CLI retry was removed in turn and its test failed.
