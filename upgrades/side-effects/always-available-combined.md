# Side effects: Always available and the app key replace, as one change

This combines three reviewed PRs so they need one verify run: #3351 (the same Mac replaces its own lost app key), #3354 (Always available guards) and #3357 (the before-login Claude sign-in). Each one's side-effects note, plain-language note and release note are included unchanged:
- `upgrades/side-effects/replace-app-key.md`
- `upgrades/side-effects/always-available-guards.md`
- `upgrades/side-effects/always-available-token.md`

## Merge
They were merged in that order onto main with no conflicts. The shared files (`src/cli.ts` and the spec files) merged cleanly, and the spec copies are identical. Typecheck is clean, and the three targeted unit files pass together (48/48).

## Review
Each part had its own independent review, which concurred (two rounds each). The combination adds no new code.
