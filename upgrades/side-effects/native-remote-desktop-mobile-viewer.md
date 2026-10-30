# Side-Effects Review — native desktop mobile viewer

**Version / slug:** `native-remote-desktop-mobile-viewer`
**Date:** 2026-10-29
**Author:** Echo
**Second-pass reviewer:** Astra

## Summary of the change

The change updates `dashboard/desktop.html`, `dashboard/desktop.css`, and `dashboard/desktop.js` so the live remote picture fills the browser viewport and controls float over it. It adds local pinch zoom and a button that focuses a mobile typing field. `scripts/desktop-public-browser-smoke.mjs` checks the public viewer in mobile emulation. It changes no target grant or host authority.

## Decision-point inventory

- Gesture classifier in `dashboard/desktop.js` — modified — decides whether two-finger motion is local zoom or an existing remote scroll action.
- Browser fullscreen support check — added — shows the fullscreen control only when the browser exposes it.
- Keyboard focus and text input — modified — sends text through the existing grant-bound input path.

## 1. Over-block

## Scope and decision points

Only the dashboard viewer layout and browser gestures change. The target adapter, encrypted stream, PIN check, scoped grant, controller lock, expiry, and revocation are unchanged. The viewer keeps Stop visible over the live surface. Browser fullscreen is requested only from a user tap and falls back to a fixed viewport layout.

The browser may refuse Fullscreen API, especially inside an iOS webview. The visual viewport layout still fills the available page; browser chrome remains under Safari or Telegram control. A two-finger gesture is classified as zoom when finger separation changes and as remote scroll when they move together at fit scale. Delaying classification until both fingers move avoids turning the first half of a scroll into zoom. A clearly changing separation can start zoom with one mostly stationary finger. An interrupted gesture clears local pointer state and cannot produce a trailing click.

## 2. Under-block

A diagonal two-finger motion near the zoom/scroll threshold may choose the wrong gesture; the action remains bounded to local zoom or a small scroll. Fit restores the view. Physical iOS keyboard behavior is still unverified, so a browser that refuses focus could leave the field visible without a software keyboard. The field remains available for hardware keyboards and is closable with Done.

## 3. Level-of-abstraction fit

The browser owns viewport layout, touch classification, and software keyboard focus. The target host still owns actual input execution, and the grant manager still owns authority. Reusing those layers avoids a parallel control path.

## 4. Signal vs authority compliance

This change has no new grant or block/allow authority. The gesture classifier selects a browser interaction; every remote action still passes through the existing stream, grant, and input validation. It adds no brittle detector with blocking authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals authority decision point. The touch threshold is a local gesture interpretation with a bounded reset action.

## 5. Interactions

The keyboard focus handler releases held remote controls before text entry. The input event clears its field after sending. IME composition holds text locally until commit and suppresses the composition commit key. Stop and stream exit clear gestures, focus, and zoom. Fullscreen exit is attempted on leave. Visual viewport resize and scroll update the viewer's top, left, width, and height so the keyboard panel and Stop follow the visible part of the page. No persistent feedback loop or second input channel is added.

## 6. External surfaces

The operator sees the new viewer on every installed machine once that machine's adapter is enabled. No external service, URL shape, saved state, or other agent message changes. The control remains complete from a phone: PIN, viewer, controls, and Stop are all in the browser.

## 6b. Operator-surface quality

The page leads with **Open desktop** after the PIN, then gives the live screen nearly all available space. Stop sits at the top right of the visible viewport; the floating dock keeps keyboard and advanced controls within a thumb's reach without taking a horizontal strip. The keyboard icon, Fit, and Done use short labels or accessible names. A 390 × 844 portrait and 844 × 390 landscape public browser run confirmed viewport fill, reachable tap targets, and no page scrolling. A synthetic keyboard shrink and viewport pan test confirmed the viewer follows visual viewport geometry and restores its original size. The live image remains readable in landscape, and zoom handles small details. The pre-PIN text still plainly says that clicks and typing affect the Mac's open apps.

## Input, privacy, and resource bounds

The keyboard field sends typed text through the existing encrypted, grant-bound input channel in at most 64-character actions. Enter and Backspace use the existing key path outside IME composition. Focus releases held remote controls. Stop and stream exit close the field, reset zoom, blank the frame, and retain the existing revoke behavior. Zoom is bounded to 1×–4× and changes only browser transforms; it does not increase capture resolution or transport bandwidth.

## 7. Multi-machine posture

Machine-local by design: each installed machine serves the same viewer assets but only exposes its own ready desktop adapter. The browser's zoom and keyboard state live only in that viewer tab. The change emits no user-facing notice, holds no durable state, and creates no new URL; the existing machine-specific dashboard link remains the entry point.

## 8. Rollback cost

Reverting this viewer commit restores the prior toolbar; no saved state or migration is needed. Windows and Linux adapters remain separate rollout steps.

## Conclusion

The layout and local touch behavior are reversible viewer changes. Astra's review caught IME commit-key interception and missing visual viewport handling; both were fixed and covered in focused tests. The remaining limit is the physical iOS keyboard check; no server or grant change is needed to back out the viewer if that device check finds a browser-specific issue.

## Second-pass review

**Reviewer:** Astra. **Independent read:** concern, then fixes applied. Astra found that IME Enter/Backspace could create unintended remote keys, that a phone keyboard could cover Done or Stop without visual viewport handling, and that a Send button falsely suggested text was buffered. The code now guards composition, follows visual viewport resize/scroll, and omits Send. Astra's initial review found no other P1/P2 issue; the post-fix physical device behavior remains unverified.

## Evidence pointers

Unit tests cover the gesture boundary, IME composition, visual viewport shrink/pan/restoration, and keyboard actions. The public HTTPS Chrome check exercises a live 1920 × 1080 H.264 stream in portrait and landscape mobile emulation, viewport geometry, pinch, keyboard focus, and Stop. That browser check does not prove the iOS operating system displays its software keyboard; a physical iPhone check is still needed for that final behavior.

## Class-Closure Declaration

No agent-authored-artifact defect or self-triggered controller — not applicable.
