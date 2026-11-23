# Silent computers can be confirmed gone for good, and PIN guessing across computers raises one alert (SEC-170, part 3 of 3)

<!-- bump: patch -->

## What Changed

Part 3 of 3 of the pool-wide PIN guess budget, under the same dev-gated switch (`security.pinBudget.poolWide`).

- **Silent computers.** `GET /pin-budget/silent-machines` lists every computer of the agent not heard from in 7 days or more (signed contact anywhere in the pool, registry last-seen or pairing, whichever is latest). It also returns whether one of them is holding a share raise back, and whether the one agent-wide Needs-you item should show. `POST /pin-budget/silent-machines/dismiss {fingerprint}` keeps the item quiet until another computer goes silent or a hold starts.
- **Gone for good.** `POST /pin-budget/gone-for-good {machineId}` (a listed computer only) registers a pending owner approval with server-written wording, purpose `pin-gone-for-good`. The owner approves it on the phone with Face ID through the existing owner-approval routes (`/mobile/action-approval/*`). That purpose is usable under this feature's switch even where `security.ownerApprovedActions` is off. Only then is the confirmation saved to `state/pin-gone-for-good.json`, and each machine's signed state report carries it to the others. It counts toward a raise only while no machine in the pool has had signed contact from that computer for 7 days, and it lapses for good if the computer is heard from after it.
- **Agent-wide alert.** Each machine's signed report now carries its wrong unknown-browser guesses from the last hour. When the pool's total reaches 20, the machine with the lowest id raises the existing `DashboardPin.bruteForce` alert, at most once per 30 minutes. Counting never changes what is admitted.

## What to Tell Your User

- **Gone for good**: "If one of my computers was wiped, lost or destroyed, I list it for you after a week of silence, and you can confirm it from your phone so the others get its share of the PIN guess limit back."
- **One alert**: "If someone spreads PIN guesses across my computers, you get one warning, not one per computer."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Silent computers list | `GET /pin-budget/silent-machines` (and the Needs-you list) |
| Confirm a silent computer gone for good | Pick it, then approve on your phone with Face ID |
| Agent-wide PIN guessing alert | Automatic |

## Evidence

- `tests/unit/sec170-pin-owner-surface.test.ts`:
  - confirmations are saved, adopted from members (newer wins, never for itself, never future-dated) and lapse once the computer is heard from;
  - the silent list, its fingerprint and "something new" rule;
  - "gone for good" registers only a server-worded pending approval and only for a listed computer, and applies only after a recorded phone approval, once;
  - the alert's one voice, threshold and cooldown;
  - the per-purpose switch on the phone routes.
- `tests/e2e/sec170-pin-share-agreement-alive.test.ts`: a confirmation saved on one real server reaches the other in its signed report, with the hourly count, and a live peer cannot be confirmed gone.
