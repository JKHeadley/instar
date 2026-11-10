## What Changed
- **Switch sign-in repair on for any machine from any dashboard.** The Accounts page's "Automatic sign-in repair" section now gives every machine a tick box, whatever its setting is now, so you can switch any of the agent's machines to "repairs without asking", or back to "asks you first", from whichever machine's dashboard you have open. Before, a machine that was off or asked first could only be switched on from its own dashboard.
- **The permission carries your PIN unlock.** Each machine receives a signed, single-use permission that says you unlocked the dashboard with your PIN. Without that, a machine still refuses to be switched on from elsewhere. Each machine still only accepts its own accounts, refuses a setting that changed since you looked, and writes an audit line; the machine you tapped on writes one too.

## What to Tell Your User
You can now turn on automatic sign-in repair for every one of your machines from one dashboard: open the Accounts page, unlock with your PIN, tick the machines you want and tap "Turn on for ticked machines". Machines you don't tick are left exactly as they are.

## Summary of New Capabilities
- Any machine's dashboard can switch any paired machine's sign-in repair to "without asking" and back, authorised by the operator's PIN unlock carried in a signed single-use permission.

## Evidence
- `tests/unit/subscription-relogin-remote-configure.test.ts`: a remote raise with the carried unlock succeeds from asks-first, watch-only and off; without it, refused.
- `tests/integration/subscription-relogin-configure-pool.test.ts`: real HTTP and signatures; peer raised with audit on both sides; mandate without the unlock, expired, or replayed is refused.
- `tests/unit/console-auto-repair-model.test.ts`, `tests/unit/PostUpdateMigrator-oneTapAnyDashboard.test.ts`.
