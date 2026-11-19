# Local Verify keeps the age of an unverified main across restarts

<!-- bump: patch -->

## What Changed

While `main` is healthy, waiting pull requests go ahead of a `main` verify until the oldest unverified merge is 90 minutes old. That age was kept only in memory, so every restart set it back to zero. On 2026-11-18 a coordinator restarted 12 times, never more than 79 minutes apart, and `main` went unverified for ten hours with no warning.

The age is now stored in the existing main-health watermark (`state/local-verify/main-health.json`, two optional fields) and restored once at each process start. A restart no longer resets the 90-minute wait or the 3-hour `local-verify:main-unverified` signal.

When there is no usable stored value (the first start on this version, a damaged file, a time in the future, or the coordinator role coming back from another machine), the age is treated as unknown, and unknown means due: one `main` verify goes ahead of waiting pull requests. The time it became unknown is stored too, so the 3-hour signal still fires and reads "at least" that long (`atLeast: true`). The audit log gets one `main-age-unknown` line per process start, with the reason.

No new setting, file or route. The 90-minute and 3-hour limits are unchanged.

## What to Tell Your User

- **Main is checked on time even when I restart often**: "I used to lose track of how long the shared code had gone untested each time I restarted, so on a day with many restarts it could go unchecked for hours without a warning. I now remember that across restarts. If I can't tell how long it has been, I test it next instead of guessing, which can make one waiting change wait a little longer."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| The age of an unverified `main` survives a restart | Automatic |
| An unknown age is tested next and warned about as "at least" | Automatic; `main-age-unknown` in `logs/local-verify.jsonl` gives the reason |

## Evidence

- `tests/unit/localVerify/mainHealth.test.ts`: written only when the age changes; a green verify writes the cleared age with the green head; restore of a past value; a future, non-finite or other-machine value dropped; three boots keep both fields; `unknownSince` set once and cleared when the age is settled; `decideStart` with an unknown age.
- `tests/unit/localVerify/LocalVerifyService.test.ts`: two boots 50 minutes apart, a ready pull request starts at 89 minutes and `main` at 90; no stored value starts `main` first; unknown across two boots raises the signal 3 hours after the first unknown; own-machine and foreign lease re-acquisition; release collapse; an unusable `unknownSince`.
- `tests/e2e/local-verify-lifecycle.test.ts`: a stored `oldestUnverifiedAt` is restored through the production-built service after boot.
