---
title: Add a Claude or Codex account from the owner's phone with Face ID
slug: account-add-face-id
eli16-overview: account-add-face-id.eli16.md
status: converged
author: echo
created: 2026-11-09
tier: 2
parent-principle: "Mobile-Complete Operator Actions"
operator-request: "Justin, 2026-11-09 21:46: \"There should also be an easy way to add Claude or codex accounts\""
review-iterations: 1
review-convergence: "2026-11-09T22:40:00.000Z"
approved: true
approved-by: "echo under the standing grant (only constitution changes need Justin); independent review subagent concurred 2026-11-09; operator request Justin 2026-11-09 21:46"
---

# Add a Claude or Codex account from the owner's phone

## Problem

Adding a subscription account today means `POST /subscription-pool` with `id`, `nickname`,
`provider`, `framework` and `configHome`, and that route registers only a login folder that is
ALREADY signed in (`SubscriptionAccountEmailRegistrar.register` reads the slot's identity first and
refuses an unverifiable one). No phone user can supply a folder path or sign a folder in first.

## What already exists

- The follow-me sign-in chain: `follow-me/enroll/start` allocates the account's own login folder
  `~/<followMeConfigHomePrefix(framework)><id>` (`~/.claude-followme-<id>`, `~/.codex-followme-<id>`,
  the layout every current account uses) and starts the wizard with the operator-approved email
  (`expectedEmail`, S7). The phone's existing code and cancel routes finish it: `follow-me/submit-code`
  types the code into the login pane, then `completeFollowMe` checks that the signed-in account's email
  matches `expectedEmail` (a mismatch is HELD, never added) and `upsertValidatedAccount` adds a new
  account through `SubscriptionAccountEmailRegistrar.completeNewValidated` (the same verified-add core
  `POST /subscription-pool` registers through). A sign-in that completes without a code is finished by
  the wizard's completion sweep through the same gate.
- The owner-phone Face ID write gate (`writeGate` + `proven`), and start-cell's answer shape, which the
  app already parses (account-sign-in-face-id).
- Replication: an added account reaches the other machines through the existing pool meta projection
  (the peer views `GET /subscription-pool?scope=pool` and follow-me read). Nothing new.

## Design

`POST /mobile/accounts/add` with body `{provider: "claude" | "codex", nickname?: string, email: string,
challenge, presenceSig}`.

1. `writeGate(req, res)` (owner phone only; team/MSP phones, the bearer and browsers refused).
2. The body may hold only those five fields; any other (a token, password, `configHome`, `id`) is
   refused 400 `unexpected-field`, so no credential or path can be supplied. `provider` must be
   `claude` or `codex` (400 `bad-target`); `nickname` optional, plain, at most 60 characters
   (400 `bad-nickname`); `email` required, one `@`, at most 254 characters (400 `bad-email`). These
   run before Face ID so a bad form costs no tap.
3. Face ID action `account-add`, target the kind, signed line `account-add <provider>`. A Claude proof
   cannot add a Codex account (challenge or signature mismatch, 401). The whole body is also covered
   by the phone's device signature.
4. routes.ts `runAddAccountSignIn` (wired as the `addAccount` dep), in order:
   - the subscription-pool write barrier for `POST /subscription-pool` and start-cell's preconditions
     (feature on, wizard and pool present);
   - provider/framework from the kind (`anthropic/claude-code`, `openai/codex-cli`), checked with
     `isIdentityVerifiableSlot` (the rule `POST /subscription-pool` applies);
   - the email normalized with `normalizeSubscriptionEmail` (400 `bad-email`);
   - one account per (provider, email): an account already in the pool here or on another machine is
     refused 409 `account-already-added` with its `accountId` (sign it in from its row instead);
   - a second tap while that email's sign-in is still waiting hands back the same sign-in
     (`reused: true`, D5 single-attempt discipline, shared `reuseOrSupersedeLiveAttempt`);
   - a fresh id `[codex-]<slug of nickname or email local part>-<4 hex>` that no pool account, wizard
     login, peer account or existing login folder holds (`deriveNewAccountId`, up to 8 tries, else
     409 `account-id-unavailable`);
   - the sign-in started on THIS machine through `driveFollowMeLogin` (extracted from
     `follow-me/enroll/start`, which now calls it too), with the given email as `expectedEmail`.
5. The answer is start-cell's shape: `201 {verificationUrl, loginId, machineId, expectedEmail,
   ttlExpiresAt, notice, kind[, reused]}`; a drive failure is 502 `{error, retryable: true}`.

Nothing is written to the pool by this route. The account appears in the pool only when its sign-in
completes AND the signed-in email matches the one given.

### Decided: email is required

The operator brief said `email?`. It is required here because the only completion path that adds a new
account without an operator-typed folder is the S7 gate, which compares the signed-in account with the
expected email and holds anything it cannot match. Without an email every sign-in would be held, so the
account would never appear. Asking for the email is one field and protects against signing in the wrong
account (the hazard S7 exists for).

### Authorization

The Face ID proof is the operator's authority for this local start, as the PIN-gated mandate is for
start-cell. No account-follow-me mandate is issued, because nothing is delivered to another machine and
`driveFollowMeLogin` is called in-process (the mandate gates the cross-machine enroll/start route).

## Acceptance

- Owner + Face ID: 201 start-cell shape; pending login under the right folder layout with the email.
- Member 403, team 403, bearer 403, bad signature 401, replay 401, Claude proof for Codex 401.
- Credential-shaped or unknown fields 400, malformed kind/email/nickname 400, before Face ID.
- Id collisions: a taken id is stepped past; all taken gives null (409).
- Duplicate email in the pool: 409 naming the account. Second tap: same waiting sign-in.
- E2E on the production boot path: route alive, real core, pool untouched until completion.

## Rollback

Revert the PR. A pending login it started expires by its TTL; no pool row is written by this route.
