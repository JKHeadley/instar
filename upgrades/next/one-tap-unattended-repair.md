## What Changed
Automatic sign-in repair can now be managed from one place.
- **A new section on the dashboard's Accounts page.** "Automatic sign-in repair" lists every machine, what repair is set to there in plain words, the exact accounts its list will hold (with removals marked), how many accounts on that machine aren't covered yet, and which accounts will still ask and why.
- **One tap after one PIN unlock.** "Turn on for ticked machines" sets the machine you're on to repair without asking, and refreshes the account list of any other machine already set that way. "Switch ticked machines back to asking first" undoes it. "Finish restarting" re-queues a restart that didn't happen. A machine set to "asks you first", watching only, or off is never changed from another machine; it is switched on from its own dashboard.
- **Changes are signed, exact and ordered.** A tap that reaches another machine travels as a single-use permission naming that machine, the exact setting and the setting it expects to find. That machine accepts only its own accounts, never lowers its waits, and refuses a request based on an outdated reading.
- **Setting changes really take effect.** A repair-setting change now asks for an ordinary restart, so the per-version update-restart limit can no longer skip it. This also fixes the existing configure route.

## What to Tell Your User
There's a new "Automatic sign-in repair" section on your dashboard's Accounts page. After your PIN, one tap keeps every machine that already repairs on its own covering all of its accounts, and turns repair on for the machine you're on. A machine you've set to ask first or left off stays as it is unless you turn it on from that machine.

## Summary of New Capabilities
- Accounts page section to view and set automatic sign-in repair across machines, with one tap.
- `POST /subscription-relogin/configure-pool` (recent dashboard unlock) and `POST /subscription-relogin/configure-with-mandate` (target point of use).
- `GET /subscription-relogin` now carries each machine's repair setting (`config`, `pool.configs`).

## Evidence
- `tests/unit/subscription-relogin-operator-config.test.ts`, `tests/unit/subscription-relogin-remote-configure.test.ts`, `tests/unit/console-auto-repair-model.test.ts`: the rules on both sides of every boundary.
- `tests/integration/subscription-relogin-configure-pool.test.ts`: two real servers, real signatures, replay, ordering, owner-consent and tamper refusals.
- `tests/e2e/subscription-relogin-one-tap-lifecycle.test.ts`: the production server path is alive.
