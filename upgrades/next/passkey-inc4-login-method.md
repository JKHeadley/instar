# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fourth increment of the approved agent-held Google passkeys spec
(`docs/specs/agent-held-google-passkey.md` §3.4). The sign-in repair system now knows a
`google-passkey` login method exists: a browser-profile account can carry it (with a pointer to a
machine-local passkey entry, never the key itself), the admission policy admits a passkey repair only
when that account's passkey cell is verified ready and otherwise refuses with a named reason, the repair
history records which method each repair used so unattended graduation is earned per method, the browser
driver never falls back to a password fill for a passkey account, and a PIN-gated `POST
/passkeys/revert-method` restores the method a passkey enrollment replaced.

Nothing turns the method on. No build code can assign it yet and no passkey repair can be admitted; the
only new thing you can actually do is revert.

## What to Tell Your User

Nothing changes for you in this update. It's groundwork: your agent's sign-in repair now has a proper
slot for passkeys, with a way to switch an account back if needed.

## Summary of New Capabilities

- A `google-passkey` login method, dark until the passkey store and health checks land.
- Repair approval is per method: an approval for the password path can't authorize the passkey path.
- Graduation evidence is per method; bad history (identity mismatches) carries across methods.
- `POST /passkeys/revert-method` (dashboard PIN) restores the previous method; accounts without one are
  listed, never guessed.

## Evidence

- `tests/unit/playwright-registry-passkey-method.test.ts`, `tests/unit/subscription-relogin-policy-passkey.test.ts`,
  `tests/unit/subscription-relogin-store-login-method.test.ts` (incl. the column added to an existing
  database), `tests/unit/anthropic-relogin-driver-passkey-method.test.ts`,
  `tests/unit/PostUpdateMigrator-passkeyLoginMethodBullet.test.ts`.
- `tests/integration/subscription-relogin-runtime-passkey.test.ts` (through the production-shaped
  runtime), `tests/integration/passkeys-revert-method-routes.test.ts`.
- `tests/e2e/passkeys-revert-method-lifecycle.test.ts` — the route is alive on a dev agent, PIN-gated, and
  dark on the fleet.
