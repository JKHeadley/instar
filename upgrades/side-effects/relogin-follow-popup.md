# Side-Effects Review — assisted re-login follows the provider popup

**Version / slug:** `relogin-follow-popup`
**Date:** `2026-09-23`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (browser-drive path) — see below`

## Summary of the change

`src/core/ChromeCdpReloginBrowser.ts`. TCP mode: remember the debugging port, the main target and the target ids present at `open()`; before every port operation (`snapshot`, `chooseExpectedAccount`, `fillPublic`, `fillSecret`, `click`, `readPasteCode`) list page targets and move the single page-level socket to the newest page that appeared after open (a popup) or back to the main page when none is left (`followNewestPage`); `navigateTo`/`clearBrowsingData` first return to the main page (`followMainPage`); a switch rejects in-flight CDP calls with `cdp-target-switched` and re-enables `Page`/`Runtime`. Pipe mode: track page sessions in attach order and read/click on `activeSessionId()` (newest live page session, else main). Test: +1 real-Chrome integration test. No driver, policy or store change.

## Decision-point inventory

- Which page the drive observes and acts on — modify — newest popup, else main. The driver's origin allow-list and page-class logic then run on that page's snapshot exactly as before.
- Passkey origin policy (`mayAddCredential` loop over page sessions, main vs secondary) — pass-through, unchanged; it still keys on `mainSessionId`.

## 1. Over-block

None. No new refusal is introduced.

## 2. Under-block / new reach

- **A popup on an unexpected origin.** Its snapshot carries its own `origin`, and the driver refuses `unexpected-origin` before any action, as it already did for a redirected main page. This is the safety property that matters, and it is preserved because the origin check runs on whatever page is active.
- **Two popups at once.** The newest wins (first in `/json/list`, which Chrome orders newest first). Sign-in flows open one at a time; a second popup would be read instead of the first, and the first is picked up again when the second closes.
- **A popup that never closes.** Snapshots keep addressing it; the drive fails on its normal step budget. Same terminal shape as before.
- **Stale `/json/list` race.** A popup that closes between listing and connecting makes `connectWs` fail; the port operation throws, the driver maps it to `provider-transient`, and the next attempt re-syncs. Not a hang, not a wrong action.

## 3. Level-of-abstraction fit

Target selection is a browser-transport concern, so it lives in the browser class behind the unchanged `ReloginBrowserPort`. The driver keeps deciding what to do on the page it is shown.

## 4. Signal vs authority compliance

No new authority. The change only alters which page's DOM the existing, supervised actions see.

## 4b. Judgment-point check

No heuristic: "newest page target not present at open" is a structural rule.

## 5. Interactions

- **In-flight calls on a switch:** rejected with `cdp-target-switched` (never left pending). Port operations are sequential in the driver, so this only affects a call racing a switch.
- **The old socket's asynchronous close (second-pass finding):** `ws` emits `close` after `close()` returns, so the replaced socket's `onClose` could have rejected the NEW socket's `Page.enable`/`Runtime.enable` with `cdp-closed` and failed the attempt at the popup moment. Both transport handlers now return early when `this.transport` is no longer that transport, so a retired socket can't touch the shared pending map.
- **Pipe-mode `navigateTo`:** it navigates the main session, so its readiness poll now evaluates on the main session explicitly rather than on a live popup.
- **`--remote-allow-origins`:** the popup's WebSocket connects with the same `origin: http://127.0.0.1` header the main socket uses.
- **Interstitial (#2057) and reissue (#2055) fixes:** orthogonal; an interstitial in a popup is classified from the popup snapshot and waited out the same way.
- **Cost:** one local `/json/list` HTTP call per port operation (a few ms).

## 6. External surfaces

None beyond the browser now completing the provider step it previously stalled on. No routes, config or on-disk change.

## 6b. Operator-surface quality

Not applicable — no dashboard or approval-surface file changed.

## 7. Multi-machine posture

Machine-local by design. Each machine drives its own Chrome.

## 8. Rollback cost

Revert the single-file hunk and patch release. No state to migrate.

## Conclusion

Closes the fourth and last gap between the hand-driven sign-ins and the shipped repair: the engine now follows the provider popup, so the Google step can complete unattended.

## Second-pass review (if required)

**Reviewer:** independent subagent
**Independent read of the artifact:** First pass: "Concern raised" — the replaced TCP socket's asynchronous `onClose` could reject the new socket's enable calls (a timing-dependent spurious `provider-transient`), and pipe-mode `navigateTo` polled readiness on the active page. Both fixed (transport-identity guards in `attachTransport`; explicit main-session evaluate in `navigateTo`) and recorded in section 5. Origin safety, pending-map hygiene and the passkey policy were confirmed intact. Second pass: "Concur with the review" — the transport-identity guard closes the race (the switch nulls `this.transport` before closing the old socket), a live transport's genuine close still rejects pending, and `navigateTo` polls the main session.

## Evidence pointers

- Live: `justin-gmail` episode, Studio, 17:05–17:10 PDT, three `browser-driving → approved transient-retry-scheduled` transitions with the tab list showing `Sign in - Google Accounts` open the whole time; a direct engine-class run logged `class=provider-choice … google=true` with the popup open.
- Test: the new popup test fails pre-fix (`provider-choice` for 5 s), passes post-fix; all relogin files green; `tsc` clean.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action` (this changes what a self-triggered browser drive acts on each step).
- **`closure`**: `guard`
- **`guardEvidence`**: `{enforcementType: ratchet, citation: tests/integration/chrome-cdp-relogin-browser.test.ts "follows a provider popup", howCaught: control-loop edge = a socket switch happens only when the newest-live-page verdict changes; steady-state bound = at most one switch per port operation and the driver's unchanged step/attempt/wall-clock budgets; settling brake = when no popup remains the socket returns to the main page and stays there. The test asserts popup read → popup fill → fall back to main.}`
