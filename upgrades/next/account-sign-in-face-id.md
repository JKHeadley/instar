## What Changed
The owner's phone can start an account sign-in with Face ID instead of the dashboard PIN.
- **New route `POST /mobile/accounts/sign-in/start`** `{accountId, machineId, challenge, presenceSig}`: owner phone only, behind the same Face ID write gate as the app's other owner actions. The challenge is `POST /mobile/permissions/challenge {action: "account-sign-in", target: "<accountId>@<machineId>"}` and the signed line is `account-sign-in <accountId>@<machineId>`, so a proof covers one account on one machine, once.
- **Same core as the dashboard.** The route runs `POST /subscription-pool/matrix/start-cell`'s own write barrier and core (now shared functions in routes.ts) and answers the same body (`verificationUrl`, `loginId`, `machineId`, `expectedEmail`, `ttlExpiresAt`, `notice`, `kind`). The PIN route is unchanged for the dashboard.
- Strict ids (`accountId` as the pool stores it, `machineId` one word with no `@`); a member or team phone, the bearer, a bad signature and a proof for another account are refused and audited in `state/mobile-permission-actions.jsonl`.

## What to Tell Your User
When an account needs signing in, the app can now confirm it with Face ID, like everything else in the app, instead of asking for your dashboard PIN. The app update that uses this comes separately; until then the PIN still works.

## Summary of New Capabilities
- Start an account sign-in from the owner phone with Face ID (`POST /mobile/accounts/sign-in/start`), running the dashboard's own start-cell code.

## Evidence
- `tests/unit/account-sign-in-face-id.test.ts`: target and signed line; every malformed account or machine id refused.
- `tests/integration/account-sign-in-face-id.test.ts`: owner + Face ID gets start-cell's body; member phone 403; bearer 403; bad signature 401; replay 401; a proof for one account cannot start another or another machine; malformed ids 400.
- `tests/e2e/account-sign-in-face-id-alive.test.ts`: on the production AgentServer boot path the route is allowlisted, mounted, wired to the real start-cell core (pending login created with the approved email), and the PIN route still answers the same shape.
- `tests/integration/account-matrix-start-cell-route.test.ts`: the PIN route's behaviour is unchanged after the extraction.
