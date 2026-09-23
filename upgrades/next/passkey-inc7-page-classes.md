# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Seventh increment of the approved agent-held Google passkeys spec
(`docs/specs/agent-held-google-passkey.md` §3.6). The sign-in repair browser now recognises the twelve
Google pages the passkey work can meet — the account identifier, the passkey prompt and its
not-recognised / throttled states, authenticator-code and backup-code entry, the enrollment speedbump
and its confirm, CAPTCHA / risk review, and the passkey settings page's list / create / confirm /
already-enrolled / Workspace-refusal shapes — by structure (exact origin, sign-in route, stable ids,
roles, exact control labels), before its older text-based chain runs. Each page carries a fixed
outcome (`ready` only with an observed assertion, one credential and an identity match; rejected
only from the not-recognised page; uncertain is `unknown`) and a fixed list of actions the supervisor
may pick from. A credential-creating control enters that list only on its exact page and only in an
enrollment drive; a sign-in can decline the speedbump but never mint.

Still dark: nothing enrolls, proves, or uses a passkey yet, and these pages are only ever exercised
against the local fixture.

## What to Tell Your User

Nothing changes for you in this update. It's groundwork: your agent's sign-in repair now knows exactly
which Google passkey screens exist and what it is allowed to do on each, so the enrollment step that
comes next can be careful by construction.

## Summary of New Capabilities

- Structural recognition of the closed set of Google passkey pages, evaluated before text matching.
- A fixed outcome mapping and a structural floor on credential-creating actions in the repair driver.

## Evidence

- `tests/unit/google-passkey-page-classes.test.ts`, `tests/unit/anthropic-relogin-driver-page-classes.test.ts`;
  `tests/integration/passkey-page-classes-fixture.test.ts` (real Chrome against the local fixture:
  structure wins over prose on every page, unmatched pages fall through, new controls click by exact label).
