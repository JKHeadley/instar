<!-- slug: account-machine-matrix -->
<!-- bump: patch -->

## What Changed

Adds a machine × account matrix on the dashboard Subscriptions tab — the on-demand "put account X on machine Y" surface that was missing (the account-follow-me Approve cards are quota-driven and never offered accounts on demand, so adding accounts to another machine meant a clunky chat dance). Rows are accounts, columns are machines; each cell is a ✓ (active there), a "Set up" button (not yet), or an honest in-progress / needs-reauth / offline / held state. Tapping "Set up" runs the whole sign-in IN the dashboard: it PIN-checks (operator presence — the agent shares the Bearer token, so the dashboard PIN is what proves a human is acting), drives the existing PIN→mandate→enroll-start chain to start a fresh login on the target machine (that machine re-mints its own login, ToS-safe), shows the auth link + a code box, and the shipped code-paste-back relay finishes it — flipping the cell to ✓. The wrong-account safety (S7 email-gate) and cross-machine delivery are reused unchanged. Dev-gated (`multiMachine.accountFollowMe`), dark on the fleet.

## What to Tell Your User

There's now a grid on the Subscriptions tab showing which of your accounts are signed in on which machines, at a glance. To add an account to another machine, tap the empty cell, enter your dashboard PIN, sign in on the page it opens, and paste the code right there — it sets up that machine and the cell turns into a check mark. No more routing sign-in codes through chat.

## Summary of New Capabilities

- **Account × Machine matrix (Subscriptions tab).** See which accounts are active on which machines at a glance, and set up an account on any machine on demand — PIN-gated, fully in-dashboard auth (sign-in link + code paste in the cell), with the machine minting its own login (nothing copied). The wrong-account email check and cross-machine delivery are the same proven ones used elsewhere. Dev-gated; dark on the fleet.

## Evidence

- `tests/integration/account-matrix-start-cell-route.test.ts` (6) — dark→503, missing/invalid PIN→403 (no enroll started), valid PIN+resolvable→201 with verificationUrl + a pending login carrying expectedEmail, unresolvable email→409, idempotent re-call reuses the pending login, missing accountId/machineId→400.
- `tests/unit/subscriptions-render.test.ts` — matrix renders ✓ for active, "Set up" for empty, a disabled offline column for a `pool.failed` machine (no fabricated ✓), in-progress for a pending login.
- `tests/unit/follow-me-controller-wiring.test.ts` — a "Set up" tap with a PIN POSTs start-cell {accountId, machineId, pin}; no-PIN does not POST.
- `npx tsc --noEmit` clean; `npm run lint` (full battery) clean; 47 tests green.
