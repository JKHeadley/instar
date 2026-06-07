# Per-account email on the Subscription Pool

<!-- bump: patch -->

## What Changed

Each subscription account now carries an optional `email`, alongside its nickname,
so same-org accounts are distinguishable (e.g. "SageMind - Justin" vs
"SageMind - Adriana"). The email is **auto-populated from the account's own login
record** (`oauthAccount.emailAddress` in its config home) on each quota poll — so
the stored email always reflects which account actually authenticated, and a login
into the wrong account surfaces instead of hiding. Added: `email` on
`SubscriptionAccount` / add / update (additive-optional), a `readAccountEmail`
helper + poll-time auto-fill in `QuotaPoller`, pass-through on the POST/PATCH
`/subscription-pool` routes, and the email rendered under the nickname on the
dashboard Subscriptions tab. The email is a public identifier — never a token.

## What to Tell Your User

Your subscription accounts now show their email next to the nickname, so when you
have several on the same org you can tell them apart at a glance. I fill the email
in automatically from the real login, so it always matches the account that
actually signed in.

## Summary of New Capabilities

- **Account email** — each pool account stores its email (the disambiguator across
  same-org accounts), shown on the dashboard.
- **Auto-filled from reality** — the email comes from the account's own login
  record on each poll, so it reflects the truly-authenticated account (catches a
  wrong-account login rather than hiding it).
