# Side-Effects Review — "Link this computer to your phone" page, rewritten

**Date:** 2026-11-18
**Author:** Echo
**Tier:** 1. Static document-page assets (`dashboard/docs/doc-page.js`, `doc-page-model.js`, `doc-page.css`) plus one unit test file. A revert fully undoes it. Size: 3 source files, about 110 added lines, 1 new test file. Effort: no spec rounds (Tier 1), one commit attempt planned.
**Why:** Justin, 2026-11-18 20:09 PST: the page is out of date and should be more explicit and easier to follow. The iPhone app now has the button (build 112, People → "Link a computer", apps/instar-ios commit 94b2910).

## What changed

The link screen a computer sees when it opens a document without a linked key now says, up front, what linking lets this computer do ("open your documents, read them and comment, for 30 days, without signing in again") and its limits (only documents you can see; remove it any time under People → Linked computers). Then five numbered steps with the app's exact button words shown as button chips: 1 Open Instar on your iPhone, 2 Tap "People", 3 Tap "Link a computer", 4 Scan the code on this screen, 5 Check that the code on your phone matches the one here, tap "Link for 30 days", then confirm with Face ID. The fallback for a phone without the button: open any document in the app and tap "Open on a computer". The QR sits large and centred in its own card with the check code under it, a hint that the phone shows the same code, and a pulsing "Waiting for your phone…". Two columns from 860 px (steps | code); stacked on a narrow window. The words are constants in `doc-page-model.js` (`LINK_WORDS`, `linkStepText`).

The button words were taken from the iOS source: `ComputerLinkEntry.buttonTitle = "Link a computer"` (InstarApp/DocsData.swift), `Button("Link for 30 days")` and the Face ID confirm in `ComputerLinkSheet`, and `"Open on a computer"` on a document (InstarApp/DocsViews.swift). 30 days is the server's `LINK_MAX_DAYS` (src/server/documentLinkRoutes.ts); a test pins the two together.

## Decision-point inventory
None. The key, nonce, QR payload, polling, expiry, and linking flow are untouched; only the screen's words and layout changed.

## 1. Over-block
No issue identified. Nothing is refused.

## 2. Under-block
A phone on an app older than build 112 has no People button; the fallback line covers it ("Update the app, or open any document in the app and tap “Open on a computer”"). The Android app's wording was not checked here; the steps say iPhone, matching the request.

## 3. Level-of-abstraction fit
Words in the page's model file (tested), layout in its own CSS; doc-page.js only places them.

## 4. Signal vs authority compliance
No authority. docs/signal-vs-authority.md applies unchanged.

## 5. Interactions
The failure screen and the phone "Open in the Instar app" screen are unchanged and keep their `.scope` style. The QR keeps its white background and quiet zone in dark mode, so phones can read it; it is shown at up to 340 px (264 px in the two-column layout so the whole screen fits at 1280x728).

## 6. External surfaces
The document page's link screen only. The iOS app's own test comment quotes the old sentence; that is a comment in the app repo, not a test of this text.

## 7. Multi-machine posture
Machine-local by design: static assets served by the machine the browser talks to.

## 8. Rollback cost
Revert the commit. No data, config or migration.

## Operator-surface quality

Answering the Operator-Surface Quality question: is it good when the operator uses it?
- **What it does comes first:** the lead line says what linking lets this computer do and for how long, before any instruction.
- **Explicit steps:** five numbered steps, each naming the exact button as the app shows it.
- **Taps, not text:** nothing to type; scan, compare, tap, Face ID.
- **The code is big and centred:** in its own card, with the check code large under it.
- **Fits:** at 1280x728 the whole screen (title to "Waiting for your phone…") is visible without scrolling; at 390x844 it stacks with no horizontal scroll (scrollWidth 390).
- **Themes:** light and dark from the page's existing tokens; checked in both.

## Verification

- `tests/unit/documents-link-words.test.ts` (new, 6 cases): the lead and limits, the five steps in order with the exact button words, the fallback, 30 days equal to the server's `LINK_MAX_DAYS`, odd input, and the page drawing these words instead of the old sentence.
- Also run green: documents-page-model, documents-link, documents-qr, operator-surface-gate, html-site-ratchet, dashboard-assets-resolve.
- Headless Chromium against a local mock (static page assets plus a mock nonce/status route; not the live dashboard), 1280x728 and 390x844, dark and light, before and after: `/Users/dabombstudio/.instar/proof-rigs/link-computer-page/shots/` (before-*.png, after-*.png, before-light-*.png, after-light-*.png; `*-full.png` are full-page). No page errors.
