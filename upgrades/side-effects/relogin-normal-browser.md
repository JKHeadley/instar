# Side-Effects Review — sign-in repair runs in a normal browser (macOS)

**Version / slug:** `relogin-normal-browser`
**Date:** 2026-09-24
**Author:** Echo
**Second-pass reviewer:** subagent (see below)

## Summary of the change

Adds `PlainChromeReloginBrowser` (subclass of `ChromeCdpReloginBrowser`) and `createReloginBrowser()`; `server.ts` builds the assisted re-login browser through it. On macOS the account profile's Chrome is opened with `open -na` (no `--remote-debugging-*`), and page reads/actions go through a pid-addressed Apple Event (`CrSu/ExJa`, Chrome's `execute javascript`). Six base-class members change from `private` to `protected` (`chromePath`, `userDataDir`, `operationTimeoutMs`, `evaluate`, `clickReal`, `waitForChildExit`; `followNewestPage`/`followMainPage` were already overridable) — no behaviour change for the base class. The profile's `Default/Preferences` gains `browser.allow_javascript_apple_events: true`. Before each snapshot/observation a synthetic pointer movement is dispatched in the page. Passkey operations and browsing-data clearing throw in the normal browser. Awareness bullet + idempotent `PostUpdateMigrator` patch.

## Decision-point inventory

- Which browser transport the repair uses — `invariant` (platform switch: darwin ⇒ normal browser, by operator rule; no judgment involved).
- No new gate, filter, or block/allow decision. Every floor (origin allow-list, other-identity exclusion, redaction, consent scope, blocked controls, drive deadline, final identity + authenticated-use verification) stays in `AnthropicReloginBrowserDriver` and is transport-agnostic.

## 1. Over-block

A profile whose Chrome is already open (for example a person finishing a sign-in by hand in it) is refused up front with `relogin-profile-in-use`: `open -na` would otherwise hand the URL to that live Chrome and the repair would drive and then close a window it did not start (caught in second-pass review; fixed, with a real-Chrome test). The drive fails transiently and retries later. Passkey-mode accounts cannot use this browser (refused loudly with `plain-browser-no-passkey`); the passkey path is dark and not constructed through `createReloginBrowser`.

## 2. Under-block

A synthetic click (`isTrusted=false`) could be ignored by some provider page; the driver then sees no progress and ends through its existing deadline/stuck handling — no false success is possible because success is still decided by identity + authenticated-use verification. Popups: the Apple Event addresses the front window's active tab; a provider popup opening behind the main window would not be addressed — the drive would time out rather than act on a wrong page, and origin checks still apply to whatever page is read.

## 3. Level-of-abstraction fit

Right layer: the `ReloginBrowserPort` transport. The driver and runtime are unchanged; the new class only replaces how JavaScript reaches the page and how Chrome is launched. Reusing the base class's page logic avoids a second copy of the snapshot/control code.

## 4. Signal vs authority compliance

No new authority. The pointer movement and transport produce no decisions; the driver's floors and the verification step remain the only authorities.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new judgment point. The agent-navigation judgment (already converged and approved in `docs/specs/agent-driven-relogin.md`) is unchanged and still runs within the same floors.

## 5. Interactions

- `warmUpPlain` (merged in #2066) is overridden as a no-op on this class — the browser is already plain. #2066's stuck-consent handoff still applies unchanged: a consent click that leaves the page on authorize past 15 s ends operator-only.
- `osascript` is spawned per page operation (~50–150 ms each); drives are bounded by the existing 8-minute deadline and one-repair-at-a-time lease.
- The operator's own default Chrome is never addressed: events are targeted by pid, not by application name (name targeting reaches the default instance — measured).
- Apple Events require the macOS Automation permission for the calling process → Chrome; on the Studio it is already granted. Where it is not, every read returns `plain-browser-apple-event-*` and the drive fails transiently (no silent success).

## 6. External surfaces

Providers now see an ordinary Chrome (measured `navigator.webdriver=false`, no debugging port). A Chrome window appears on the machine's screen during a repair. The profile preference `allow_javascript_apple_events` stays on for the relogin profiles only (dedicated, agent-owned profiles, not the operator's browser). It means any local process that holds macOS Automation permission for Chrome can run JavaScript in those signed-in profiles while they are open — the same local trust boundary the agent itself runs within; the profiles are only open during a repair. If the pid scan times out after Chrome started, that Chrome is left running (never killed blind); the next launch refuses the in-use profile until it is closed.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator surface. Boot line gains `browser: normal|automated`; the existing Subscriptions grid and episode events are unchanged.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine drives the Chrome profile on its own disk (`machine-local-justification: physical-credential-locality` — browser cookies are encrypted with a per-machine keychain key). Each Mac picks the normal browser independently via `process.platform`; no replicated state added.

## 8. Rollback cost

Revert the PR (patch release). No data migration; the added profile preference is harmless under the old browser.

## Conclusion

Transport swap only, driven by the operator's standing rule and proven on a real expiry. Safe to ship.

## Second-pass review (if required)

Reviewer (subagent, 2026-09-24): **Concern raised** — (1) no CDP-only path reachable in the non-passkey flow; (2) secret handling OK (stdin only, fixed error strings); (3) an already-open profile would be driven and SIGTERMed; sibling-dir pid match; (4) runner + wrap/decode correct (no awaitPromise — all expressions synchronous); (5) artifact member count and §1 wrong, §6 missing the Apple-Events-JS exposure note.
Resolution: (3) fixed — `relogin-profile-in-use` refusal before launch + exact-profile match (`--user-data-dir=<dir> --` or end of line), real-Chrome test added; (5) artifact corrected above. Concerns resolved; concur.

## Evidence pointers

`upgrades/next/relogin-normal-browser.md` (Evidence section); `tests/unit/plain-chrome-relogin-browser.test.ts`; `tests/integration/plain-chrome-relogin-browser.test.ts`.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "no new self-triggered action; transport swap inside the existing bounded, leased, deadline-limited repair"}`
