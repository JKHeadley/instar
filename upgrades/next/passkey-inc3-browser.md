# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Third increment of the approved agent-held Google passkeys spec
(`docs/specs/agent-held-google-passkey.md` §3.5). The repair browser gains a passkey mode: it talks
to Chrome over a private pipe instead of a local network port, disables extensions and page
pre-loading, gives every tab and popup a virtual passkey device before that tab loads anything, and
pulls the key back out the instant a page tries to leave the sign-in site or load another Google
page in a frame. It can also report whether the site actually used the passkey, check the signed-in
identity on the page without exposing it, and export a freshly created passkey. Clicks on sign-in
pages are now real pointer clicks in every mode, because Google's account-choice list ignores
script clicks; form fills are read back before submitting so an empty submit never costs a failed
attempt. A small local stand-in for Google's sign-in pages ships with the package so the browser can
be tested end to end with real Chrome and no account.

Nothing turns passkey mode on yet; the repair flow still launches the browser as before.

## What to Tell Your User

Nothing changes for you in this update. It's groundwork: the browser your agent uses to sign back in
can now hold a passkey safely, and it clicks the way a person does.

## Summary of New Capabilities

- The repair browser can hold a passkey, and only while it's on the sign-in page.
- Popups and frames are covered from the moment they open.
- Real clicks on sign-in pages, so account lists respond.
- A built-in local test stand-in for Google sign-in, used by the test suite.

## Evidence

- `tests/integration/passkey-browser-fixture.test.ts`: 11 tests with real headless Chrome against
  the local stand-in — mint, export, re-inject in a fresh browser and use; key removed before a move
  to another site, on a redirect, and when a frame loads another Google-family page; an unrelated
  frame does not remove it; a popup gets its own loaded device; a popup that moved to another Google
  page blocks re-adding the key until it comes back; identity read; real clicks. Each protection was
  also checked by disabling it and watching its test fail.
- `tests/unit/chrome-cdp-passkey-credential-race.test.ts`: 7 tests (no browser) for the two gaps the
  independent review found — a removal racing a popup that is still being set up, and a re-add while
  a popup sits on another Google page — plus the stricter handling of an unknown frame.
- `tests/unit/passkey-browser-policy.test.ts`: 20 tests on the where-may-the-key-live rules.
- The existing browser and driver tests pass unchanged.
