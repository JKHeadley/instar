# Silent computers can be confirmed gone for good, and PIN guessing across computers raises one alert (SEC-170, part 3 of 3)

<!-- bump: patch -->

## What Changed

Part 3 of 3 of the pool-wide PIN guess budget, under the same dev-gated switch (`security.pinBudget.poolWide`).

- **Silent computers.** `GET /pin-budget/silent-machines` (with `evidenceComplete` false when some computer's records could not be read) lists every computer of the agent not heard from in 7 days or more (signed contact anywhere in the pool, registry last-seen or pairing, whichever is latest). It also returns whether one of them is holding a share raise back, and whether the one agent-wide Needs-you item should show. `POST /pin-budget/silent-machines/dismiss {fingerprint}` keeps the item quiet until another computer goes silent or a hold starts.
- **The owner's two choices.** For a listed computer the owner can retire it (remove its pairing, the same registry revocation as `instar machines remove`), or confirm it gone for good (wiped, lost or destroyed). Both are owner-phone only: `POST /mobile/pin-budget/silent-machine`, a permission action with Face ID whose signed line is `silent-machine <machineId> <retire|gone-for-good> <list fingerprint>`, so a stale screen cannot act. No bearer token or dashboard PIN reaches either one. A request that cannot succeed (switched off, list changed, not listed, this computer, or a retire while some computer's records are unreadable) is refused before Face ID is asked for, and the phone can check first with `POST /mobile/pin-budget/silent-machine/preflight` and read the list with `GET /mobile/pin-budget/silent-machines`. A confirmation is saved to `state/pin-gone-for-good.json`, and each machine's signed state report carries it to the others. It counts toward a raise only if the computer had already been silent for 7 days when the owner confirmed it, has not been heard from since, and the whole pool still agrees.
- **Agent-wide alert.** Each machine's signed report now carries its wrong unknown-browser guesses from the last hour. When the pool's total reaches 20, the machine with the lowest id raises the existing `DashboardPin.bruteForce` alert, at most once per 30 minutes. Counting never changes what is admitted.

## What to Tell Your User

- **Gone for good**: "If one of my computers was wiped, lost or destroyed, I list it for you after a week of silence, and you can confirm it from your phone so the others get its share of the PIN guess limit back."
- **One alert**: "If someone spreads PIN guesses across my computers, you get one warning, not one per computer."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Silent computers list | `GET /pin-budget/silent-machines` (and the Needs-you list) |
| Retire a silent computer, or confirm it gone for good | On your phone, with Face ID |
| Agent-wide PIN guessing alert | Automatic |

## Evidence

- `tests/unit/sec170-pin-owner-surface.test.ts`:
  - confirmations are saved, adopted from members (newer wins, never for itself, never future-dated) and lapse once the computer is heard from;
  - the silent list, its fingerprint and "something new" rule;
  - both choices are refused before Face ID unless the computer is listed and the list is the one the owner saw, apply once, and report a failed save;
  - the alert's one voice, threshold and cooldown;
  - the phone action's signed line and its owner-phone-only allowlist rule.
- `tests/e2e/sec170-pin-share-agreement-alive.test.ts`: a confirmation saved on one real server reaches the other in its signed report, with the hourly count, and neither choice can act on a live peer.
