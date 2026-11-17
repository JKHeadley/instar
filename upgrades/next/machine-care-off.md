# Turn off machine care for a machine

<!-- bump: patch -->

## What Changed

The Machine care page has a Turn off button for a machine that is signed up. After your PIN, the machine is no longer signed up: nothing restarts it, including a restart countdown already running, and its restart permission is removed where that is possible without a password. You can sign it up again from the same page.

## What to Tell Your User

- **Turn off machine care**: "On the Machine care page you can turn restarts off for a machine. Nothing restarts it after that, and you can sign it up again any time."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stop restarting a machine | Dashboard → Capacity → Machine care → Turn off |

## Evidence

- Unit: `tests/unit/machine-enrolment-controller.test.ts`, `tests/unit/console-machine-care.test.ts`; integration: `tests/integration/machine-maintenance-route.test.ts`; e2e: `tests/e2e/machine-maintenance-lifecycle.test.ts`.
