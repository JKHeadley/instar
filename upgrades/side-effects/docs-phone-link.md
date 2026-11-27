# Side-Effects Review — a document link tapped on a phone opens the app, not a QR dead end

**Version / slug:** `docs-phone-link`
**Date:** `2026-11-15`
**Author:** `Echo`
**Second-pass reviewer:** `not required (no gate, sentinel, watchdog, messaging or session-lifecycle surface)`
**Tier:** 1 (3 code files + 1 site page + 1 site route + tests, about 120 lines; reversible by revert). Effort: 0 spec rounds, first commit attempt.

## Summary of the change

Feedback fb-54b4d850-0de: the operator tapped an Instar Documents link from Telegram on his iPhone and got "Link this computer to your phone" with a QR code and "Waiting for your phone…". That screen is for a computer; on the phone it is a dead end, since the phone that would scan the code is the one showing it.

- `dashboard/docs/doc-page-model.js`: two pure helpers. `appDocLink(origin, docId, commentKey)` builds `https://instar.sh/doc#v=1&o=<origin>&d=<id>[&c=<comment>]` (null for a non-https origin or a non-document id). `prefersAppOpen({inApp, coarsePointer, canHover})` is true only for a touch-first browser outside the app.
- `dashboard/docs/doc-page.js`: where the page had no usable key it called `showLinkComputer()`; it now calls `showNoKey()`, which on a touch-first browser shows "Open this document in the Instar app" (a plain link to the universal link) with a small "Link a computer" fallback, and everywhere else the unchanged QR flow.
- `dashboard/docs/doc-page.css`: styles for a link that looks like the primary button.
- `site/src/pages/.well-known/apple-app-site-association.ts`: adds `/doc` for the Instar app, so iOS hands those taps to the app.
- `site/src/pages/doc.astro`: the fallback page when the app is missing or the browser keeps the link: how to open it from the app, and an "Open on a computer" link back to the agent's document page (https origin and document id validated; fragment read client-side only, never inserted as HTML, no network).
- The iPhone app (its own local repo, apps/instar-ios, branch echo/docs-phone-link) parses the link, picks the paired agent at that address (or whose machine routes list it) and opens `DocumentScreen`; an unpaired address says so plainly.

## Decision-point inventory

None. The page chooses which of two screens to show; nothing is blocked or allowed. Document access is still decided by the server's existing device-signed `open` (the app's own key), unchanged.

## 1. Over-block

Nothing is rejected. A touch-first tablet user who wants the computer flow still has "Link a computer" on the same screen.

## 2. Under-block

The link carries no secret (agent address and document id, both already in the original link), so a link opened by someone else's phone gets the same refusal the app gives for any document that phone may not read ("This phone can't open this document."). Telegram's in-app browser may not hand a universal link to the app; then the instar.sh/doc page explains the in-app route.

## 3. Level-of-abstraction fit

Right layer: the document page already owns "no key here, what now". The universal-link domain and path follow the existing `/pair` pattern (same AASA, same app handler).

## 4. Signal vs authority compliance

No authority is added. Pure presentation choice; the server's signature check remains the only authority (docs/signal-vs-authority.md).

## 5. Interactions

`browserOpen()`'s two `showLinkComputer()` calls route through `showNoKey()`; the in-app WKWebView path (`IN_APP`) never reaches it (`prefersAppOpen` is false in the app). `showOpenInApp` bumps `linkRun`, so an earlier link-code poll stops itself. Android: assetlinks and the Android app's intent filter stay limited to `/pair`; on Android the button opens the instar.sh/doc fallback page, which explains the in-app route.

## 6. External surfaces

New public path `instar.sh/doc` and a new AASA component (deployed with the site on merge). Existing installed iPhone builds (67 and earlier) ignore `/doc` links in `handleIncoming` → they show the existing "can't read this kind of link" alert, which is why the app build ships alongside.

## 7. Multi-machine posture

Machine-local by design and machine-agnostic: the link carries the origin the page was served from; the app matches it against the paired address and every route the agent's machines advertise (RouteDirector), so a link from any of the agent's machines opens on the right agent.

## 8. Rollback cost

Revert the commit: the page goes back to the QR screen everywhere. The AASA entry is harmless to keep. No state, migration or config.

## Evidence

- Unit: `tests/unit/documents-page-model.test.ts` (3 new cases: link format, non-https / non-document refusal, touch-first decision incl. touch laptop and in-app) — 27/27 with `documents-link.test.ts` 15/15.
- iPhone app: 608 unit tests pass, including 3 new (link parsing, refusal of other links, paired-agent choice).
- Live, throwaway agent behind named tunnel docs-phone-1115.dawn-tunnel.dev running this branch's build, 2026-11-15 20:54–21:05 PST:
  1. Simulator Safari (iPhone 17 Pro, iOS 26.5) opening the document link shows "Open this document in the Instar app" — no QR.
  2. The exact link the page builds, fed to the app (seeded as the agent's owner phone), opens the document "Phone link proof" with its text and comments.
  3. A desktop Chrome at 1280x728 still shows "Link this computer to your phone" with the QR; an emulated iPhone 15 Pro shows the app button whose href is the universal link.
