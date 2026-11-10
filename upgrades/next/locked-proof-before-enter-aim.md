<!-- internal-only -->
# Upgrade Guide — locked-proof-before-enter-aim

## What Changed

Locked-Mac proof driver (`scripts/locked-proof`) only. "Before Enter" injections (15.1, 15.3, 15.5, 15.7) now aim from the duty's own `createdAt` plus a calibrated `createToEnterMs` (new calibration field), less a 170 ms lead, and sleep to that point instead of firing on the next 250 ms poll. Each case records `injectMinusEnterMs` (or `limitMinusEnterMs` for the deadline case), and a before-enter step that started at or after Enter fails the verdict. `run` refuses cases that need calibration when `calibration.json` is missing or predates `createToEnterMs`. Fixes fb-fcb17087-521 items 1 and 2.

## Evidence

`tests/unit/locked-proof-driver.test.ts`: 74 pass, including three new tests: a simulated Mac with Enter 640 ms after duty creation sees the step fire exactly 170 ms before Enter; a step that started 891 ms after Enter fails with that gap and one 170 ms before passes; the calibration refusal names the cases that need it. Live measurements behind the fix (injection minus Enter, merged scripts): +15 to +891 ms across 15.1, 15.5, 15.7.
