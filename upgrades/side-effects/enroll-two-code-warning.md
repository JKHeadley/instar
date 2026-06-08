# Side-effects review — enrollment two-code heads-up

## Change

Surfaces an operator-facing heads-up on a pending login about the Claude
url-code-paste flow's two-code sequence (email-verification code first, then the
sign-in code). Three pieces:
- `PendingLoginStore`: new optional `notice?: string` on `PendingLogin` +
  `IssueLoginInput`; `issue()` persists it when present (omitted otherwise).
- `EnrollmentWizard`: new `static flowNotice(kind)` returns the two-code warning
  for `url-code-paste` and `undefined` for `device-code`; `start()` attaches it.
- `dashboard/subscriptions.js`: `renderPendingLogins` shows a `sub-pending-notice`
  row (sanitized text) when a notice is present.

## Why

Live enrollment testing (topic 20905): enrolling a fresh Claude account makes
Anthropic ask for TWO codes in sequence — an email-verification code, then the
sign-in code — and the operator found the unexplained second prompt confusing. The
wizard now tells them what to expect up front.

## Side effects considered

- **Backward compatibility / persistence.** `notice` is optional and omitted when
  absent, so existing pending-login JSON records (written before this change) load
  unchanged — no migration. `issue()` only adds the key when a non-empty notice is
  passed, matching the file's existing `...(x ? {x} : {})` style.
- **Not a secret.** The notice is static guidance text — never a credential, code,
  or URL. It passes the store's `assertNoCredentialFields` (it's a fixed string set
  by the wizard, not derived from login input).
- **XSS / display safety.** Rendered through the existing `sanitizeForDisplay`
  (NFKC + control/bidi strip + grapheme cap) as inert text in a `div` — never an
  href or innerHTML. Covered by the render tests (notice present → shown; absent →
  element omitted) alongside the existing javascript:-URL inertness test.
- **device-code (Codex) flows are unchanged** — `flowNotice('device-code')` is
  undefined, so no notice is attached and the row renders exactly as before.
- **Reach to existing agents.** Server code (PendingLoginStore/EnrollmentWizard)
  and the dashboard asset ship with the instar package, so agents get this on the
  normal package update — no `.instar/`-copied file and no PostUpdateMigrator entry
  required.
- **Blast radius:** one optional field + one pure static method + one conditional
  render row. Reversible by dropping the field.
