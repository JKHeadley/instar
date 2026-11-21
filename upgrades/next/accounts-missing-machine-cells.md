<!-- bump: patch -->
## What Changed

The console Accounts page now shows a machine that answered the pool read but lacks an account, and lets the owner set the account up there (feedback fb-8c1a18ef-daf).

- `buildAccountsPage` adds a `missing` cell for each machine in the pool-scope read that holds no row for an account. Machines in `pool.failed` are left out: their accounts are unknown, not missing.
- A missing cell renders as a dotted "+" chip. In the account sheet the machine reads "not on this machine", with a quiet **Set up** button that runs the existing PIN-gated `POST /subscription-pool/matrix/start-cell` flow. A running sign-in episode for that cell shows "signing in".
- Missing cells never count toward "needs you", the ready/needs-sign-in counts or the "machine has no signed-in account" notice, because not every account belongs on every machine.

## What to Tell Your User

If your agent runs on more than one computer, the Accounts page now shows when a computer is missing an account the others have, for example after a computer was rebuilt or switched off while you added an account. Open the account and tap Set up next to that computer to sign it in there. It is never flagged as something you must do, because some accounts are kept off some computers on purpose.

## Summary of New Capabilities

- Console Accounts page: missing-machine cells with a PIN-gated Set up action. No new routes, no config.

## Evidence

- Unit: `tests/unit/console-accounts.test.ts`: missing cell with a quiet Set up and no needs-you, counts and notices unaffected, an unanswered machine is unknown not missing, a running episode shows signing in, no missing cell when every machine holds the account, plus a DOM test where the sheet's Set up asks for the PIN and posts start-cell for the missing machine (35/35).
- Live origin: the 2026-11-20 Mac Studio rebuild left four accounts missing there with no sign on this page.
