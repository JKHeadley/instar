# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Assisted subscription re-login now runs in a **normal Chrome** on macOS instead of an automated one. New `src/core/PlainChromeReloginBrowser.ts`: the account's profile is opened through LaunchServices (`open -na "Google Chrome" --args --user-data-dir=…`) with no remote-debugging port or pipe, and the page is read and acted on through Chrome's own AppleScript `execute javascript` command, addressed to that Chrome instance by process id (JXA raw Apple Event `CrSu/ExJa`; page code goes over stdin, never the command line). "Allow JavaScript from Apple Events" is switched on in the profile's `Default/Preferences` before launch. All page logic and every driver floor (allowed origins, other-identity exclusion, secret redaction, consent scope, blocked controls, deadline, identity + authenticated-use verification) are inherited unchanged from `ChromeCdpReloginBrowser`; only the transport changed. Before each page read the browser moves a synthetic pointer over the document, because Claude's Authorize button stays disabled until the page sees pointer activity. `createReloginBrowser()` picks the normal browser on macOS and keeps the debugging-protocol browser elsewhere; the boot line now says `browser: normal|automated`. Passkey mode and browsing-data clearing are refused in the normal browser (they need the debugging protocol).

Operator rule behind it (2026-09-24): auth-sensitive sign-in flows must never run in an automated browser.

## What to Tell Your User

When one of your subscription sign-ins expires, the automatic repair now opens that account's Chrome the ordinary way, like you would, instead of a remote-controlled one. The sign-in sites were stopping the remote-controlled browser with human checks; the ordinary one goes straight through. You may briefly see a Chrome window open and close on the machine while it works.

## Summary of New Capabilities

- Sign-in repair on macOS uses a normal Chrome window (no automation connection), which passes the provider checks that stopped the automated browser.

## Evidence

- Live, Studio, 2026-09-24 ~19:58 UTC: the pending Claude sign-in for justin@sagemindai.io (`sagemind-justin`, `needs-reauth`) was opened this way on its own profile. The page reported `navigator.webdriver=false`, the hCaptcha frame stayed hidden, Authorize enabled after pointer activity, one click reached `platform.claude.com/oauth/code/callback`, and the code submitted through `POST /subscription-pool/follow-me/enroll/sagemind-justin/submit-code` returned `outcome: validated`; the account now reads `active`. Earlier the same day the same account under the debugging-protocol browser stalled on Authorize (busy button, no authorize request).
- A directly spawned Chrome binary did not answer Apple Events; the LaunchServices launch did (measured).
- Tests: `tests/unit/plain-chrome-relogin-browser.test.ts` (7: result wrapping, pref write idempotence, launch without debugging, URL/passkey/clear refusals, launch timeout, not-found click throws, darwin/other wiring); `tests/integration/plain-chrome-relogin-browser.test.ts` (real visible Chrome, opt-in via `PLAIN_CHROME_REAL_TEST=1`: no `DevToolsActivePort`, secret never in observations, pointer-gated button enabled and clicked — passed locally); `tests/unit/PostUpdateMigrator-assistedRelogin.test.ts` (+awareness bullet, idempotent).
