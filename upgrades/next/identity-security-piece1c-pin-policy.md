# One PIN guessing policy for every place the PIN is asked

<!-- bump: patch -->

## What Changed

Before, only the dashboard sign-in screen had full protection against PIN guessing. Several owner actions had none, step-up and the mandate PIN counted every internet caller as one, and the money-layer routes kept one counter that could lock everyone out for 15 minutes. Now one policy covers them all:
- **Public routes** (sign-in, step-up, the email-code page) use the sign-in screen's limits: each visitor has its own budget, and an overall cap of 20 wrong guesses per 5 minutes survives a restart.
- **Approval links** are limited per live request, so a stranger cannot use one up.
- **Owner actions behind sign-in** are limited per credential, so another caller's wrong guesses never refuse the owner's right PIN.
- **The guess counter file** is pruned and capped. If it is damaged, PIN sign-in from unknown browsers pauses for one window rather than letting guesses through. A failed write keeps counting in memory.
- **Settings** can now only make the limits stricter. The old off switch is ignored.

## What to Tell Your User

- **Safer PIN**: "Every place that asks for your dashboard PIN now has the same protection against guessing, and a stranger guessing at the sign-in page can't lock you out of your own actions. With the right PIN, nothing changes for you."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| One PIN guessing policy everywhere | Automatic |

## Evidence

- Unit: `tests/unit/owner-pin-verifier.test.ts`, `tests/unit/pin-attempt-store-hardening.test.ts`, plus the existing PIN throttle and money-layer suites.
- Throwaway: see the PR.
