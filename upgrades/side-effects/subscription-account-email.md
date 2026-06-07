# Side-Effects Review — per-account email on the Subscription Pool

## Scope of change

- `src/core/SubscriptionPool.ts` — add optional `email` to `SubscriptionAccount`,
  `AddAccountInput`, `UpdateAccountInput`; `add()`/`update()` store/patch it.
- `src/core/QuotaPoller.ts` — new exported `readAccountEmail(configHome)` (reads the
  PUBLIC `oauthAccount.emailAddress` from the config home's `.claude.json`); `pollAll()`
  auto-populates `account.email` from it on each poll.
- `src/server/routes.ts` — POST/PATCH `/subscription-pool` pass `email` through.
- `dashboard/subscriptions.js` + `dashboard/index.html` — render the email under the
  account nickname. Tests (unit + render assertion).

## Why

Operator requirement (Justin, topic 20905): accounts must be identified by nickname
AND email — e.g. "SageMind - Justin" vs "SageMind - Adriana" vs "SageMind - Dawn"
are the same org, so the email is the disambiguator. The pool previously stored only
nickname + login location.

## The safety property (load-bearing)

The email is **auto-populated from the account's own login record** (`oauthAccount.
emailAddress` in the config home), not just operator-typed. So the stored email
always reflects WHICH account actually authenticated under that config home — a
login into the wrong account *surfaces* (the email won't match the nickname's intent)
instead of hiding. This directly serves the operator's stated worry about mislabeling
accounts. The email is a PUBLIC identifier — never a token/secret.

## What does NOT change

- Additive-optional everywhere: `email` is optional; existing accounts and existing
  add/update calls (no email) behave exactly as before (`email` stays undefined).
- No new route, no new authority, no behavior change to selection/swap/poll beyond
  writing one extra public field. The credential-field guard is unaffected (`email`
  is not a forbidden field name).

## Framework generality

`readAccountEmail` reads claude-code's `oauthAccount.emailAddress` (the Claude config
layout), matching the standard's Claude-first scope. The `email` field itself is
framework-agnostic (any provider's account can carry one); only the auto-populate
reader is claude-code-specific today. A non-claude account simply gets no auto-filled
email (operators can still set one via the route) — no behavior regression, and the
reader extends per-framework when those logins are wired.

## Failure modes considered

- Config home has no `.claude.json` / no `oauthAccount` → `readAccountEmail` returns
  null → poll leaves `email` unchanged (no throw).
- Operator passes `email` at add time → stored as-is; a later poll overwrites it with
  the real logged-in email (reality wins — the safety property).
- `update({ email: '' })` clears the email (explicit unset).

## Migration / parity

Additive-optional field on an existing store — no migration needed (old records load
with `email` undefined; the next poll fills it). Ships via dist.
