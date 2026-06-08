# Enrollment two-code heads-up (Claude login)

<!-- bump: patch -->

## What Changed

The enrollment wizard now attaches an operator-facing heads-up to a pending Claude
login, warning that a brand-new Claude account login asks for TWO codes in sequence
— an email-verification code first, then the sign-in code. `PendingLogin` gains an
optional `notice` field; `EnrollmentWizard.flowNotice(kind)` produces the warning
for the `url-code-paste` (Claude) flow and nothing for `device-code` (Codex); the
dashboard's Pending Logins panel renders it above the code. Codex enrollment is
unchanged.

## Evidence

Found during live enrollment (topic 20905): enrolling a fresh Claude account, the
operator was asked for an email-verification code first and then a separate sign-in
code, with nothing explaining the second prompt — reported as confusing.

Reproduction / before-after:
- **Before:** starting a `url-code-paste` enrollment produced a pending login with
  only a code + URL; the two-code sequence was undocumented, so the operator hit an
  unexplained second code prompt.
- **After:** the same enrollment produces a pending login whose `notice` reads
  "a brand-new Claude login often asks for TWO codes in order — first an
  email-verification code … then the sign-in code …", shown on the dashboard card.
  A `device-code` (Codex) enrollment still carries no notice.

Locked in by new `enrollment-wizard.test.ts`, `pending-login-store.test.ts`, and
`subscriptions-render.test.ts` cases (notice present for Claude / absent for Codex;
rendered when present / element omitted when not).

## What to Tell Your User

When I set up a new Claude account for you, the login card now warns you up front
that Claude will ask for two codes in a row — the email-verification code first,
then the sign-in code. No more being surprised by the second prompt.

## Summary of New Capabilities

- **Two-code heads-up on Claude enrollment** — the pending-login card explains the
  email-code-then-sign-in-code sequence before you start.
- **`PendingLogin.notice`** — an optional, sanitized, operator-facing flow heads-up
  (extensible to other flow quirks later); Codex/device-code flows carry none.
- Ships with the normal instar update (server + dashboard); no migration needed.
