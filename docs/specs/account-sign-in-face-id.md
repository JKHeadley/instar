---
title: Account sign-in from the owner's phone with Face ID instead of the dashboard PIN
slug: account-sign-in-face-id
eli16-overview: account-sign-in-face-id.eli16.md
status: converged
author: echo
created: 2026-11-09
tier: 2
parent-principle: "Mobile-Complete Operator Actions"
operator-request: "Justin, 2026-11-09 21:36, topic 134088 (screenshot of the app's account Sign in sheet): \"This should accept a Face ID scan, just like any feature in the app instead of a PIN\""
review-iterations: 1
review-convergence: "2026-11-09T22:00:00.000Z"
approved: true
approved-by: "echo under the standing grant (only constitution changes need Justin); independent review subagent concurred 2026-11-09; operator request Justin 2026-11-09 21:36 topic 134088"
---

# Account sign-in from the owner's phone with Face ID

## Problem

The Instar app's account "Sign in" sheet (Accounts, an account that needs signing in on a machine)
asks for the dashboard PIN. It POSTs `dashboard/unlock {pin}` for a bearer, then
`POST /subscription-pool/matrix/start-cell {accountId, machineId, pin}`. Every other owner action in
the app (approve a request, switch a feature, move or close a session, team access) is confirmed with
Face ID: a single-use challenge bound to the exact action, signed by the phone's Secure Enclave
presence key. The operator asked for the same here.

## What already exists

- `POST /subscription-pool/matrix/start-cell` (routes.ts): behind the subscription-pool write barrier
  (`enforceSubscriptionPoolWriteCapability`, classified `requiresEmailReconciliation`), checks that
  account follow-me is on and the mandate engine, wizard and pool exist, validates the body, checks the
  dashboard PIN (`checkMandatePin`, the operator-presence proof, FD4), then: for this machine reuses a
  live pending login for the account, else issues the per-(account, machine) `account-follow-me`
  mandate and drives the existing mandate-gated `follow-me/enroll/start` (loopback for self, delivered
  mandate plus remote call for a peer). It answers `201 {verificationUrl, loginId, machineId,
  expectedEmail, ttlExpiresAt, notice, kind[, reused]}` or a 404/409/502/503 with `error`.
- The owner-phone Face ID write gate (mobilePermissionsRoutes.ts `writeGate` + `proven`): the
  permission-actions switch, a device-signed request from an ACTIVE OWNER phone (never a team or MSP
  phone), local TLS or loopback, a configured dashboard PIN, an enrolled presence key, then a
  single-use challenge (`POST /mobile/permissions/challenge {action, target}`) bound to device, Host
  and the exact action line, and a presence signature over
  `permissionPresenceMessage(deviceId, host, challenge, line)`. Every refusal and success is audited
  in `state/mobile-permission-actions.jsonl`. The design note at the top of that file: the proof
  "stands in for the dashboard PIN the console asks for, and the action itself runs the console's own
  code".

## Design

One new owner-phone route, built only from those two existing pieces:

`POST /mobile/accounts/sign-in/start` with body `{accountId, machineId, challenge, presenceSig}`.

1. `writeGate(req, res)`: the same gate as approve/decline/feature/session actions (not the team
   control variant). A team or MSP phone is refused (403 `owner-phone-required`, and the device
   allowlist rule is `ownerOnly` and never named for team phones). The bearer is refused (403
   `device-signature-required`): the agent shares the bearer, so the bearer must never start a
   sign-in without the operator.
2. Strict ids: `accountId` must match `^[a-z0-9-]{1,64}$` (the pool's own `ID_RE`, bounded);
   `machineId` must match `^[A-Za-z0-9_-]{1,64}$` (an `m_<hex>` mesh id, or `local`/a configured id
   with no mesh). Neither may contain whitespace or `@`, so the signed line cannot be split. A
   malformed pair is refused 400 `bad-target` both at the challenge and at the route.
3. The Face ID action is `account-sign-in`, target `<accountId>@<machineId>`, signed line
   `account-sign-in <accountId>@<machineId>`. The route rebuilds the target from the body, so a
   challenge or signature for one account (or one machine) cannot start another: the challenge lookup
   fails (401 `challenge-invalid`) or the signature fails (401 `presence-invalid`).
4. After the proof, routes.ts wires `startAccountSignIn` to run, in start-cell's order: the same
   subscription-pool write barrier for `POST /subscription-pool/matrix/start-cell`
   (`subscriptionPoolWriteRefusal`, extracted from the middleware so both share one body), then
   `runMatrixStartCell(accountId, machineId)`, which is start-cell's own core extracted verbatim
   (preconditions, reuse, mandate, enroll/start). The PIN route now calls the same two functions; its
   behaviour, order and answers are unchanged.
5. The phone gets start-cell's status and body unchanged, so the app's existing `started(status:
   json:cell:)` parser reads it as is. The audit row is `account-sign-in` (or `refused` with the
   core's error code) naming the device and the target.

The device allowlist gets one owner-only rule in the shared `permission-actions` bucket (12/min). The
route timeout budget is start-cell's (`followMe.startCellRouteMs`), since it runs the same chain.

## What it does not change

- The PIN route stays for the dashboard, byte-for-byte in behaviour.
- No new authority: the mandate issued is identical (same scope, bounds, expiry, author), the
  enroll/start path is identical, and the presence proof is the one already accepted for every other
  owner action in the app.
- The app change (send Face ID instead of the PIN) is in the iOS repo; this is the server half. An
  older app keeps working on the PIN route.

## Acceptance

- Owner phone + valid Face ID: 201 with start-cell's body; the core runs once; audit row written.
- Member (MSP) phone: 403; team phone: 403; bearer: 403; core never runs.
- Bad signature: 401 `presence-invalid`. Replayed challenge: 401 `challenge-invalid`.
- A proof for account A cannot start account B, nor A on another machine.
- Malformed ids: 400 `bad-target` at challenge and route.
- E2E on the production AgentServer boot path: the route is allowlisted, mounted, wired to the real
  start-cell core, creates the pending login, and the PIN route still answers the same shape.

## Rollback

Revert the PR. The route disappears (an app that calls it gets 403 `device-not-allowed`, which it can
treat as "use the PIN"). No state, migration or config is involved.
