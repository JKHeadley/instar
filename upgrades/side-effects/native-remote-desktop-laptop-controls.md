# Side-Effects Review — native desktop laptop controls

**Version / slug:** `native-remote-desktop-laptop-controls`
**Date:** 2026-10-30
**Author:** Echo
**Second-pass reviewer:** Astra — viewer and subsequent filesystem-scope correction

## Summary and decision points

The MacBook viewer now uses a black-stroked SVG pointer, sends browser wheel events as remote scroll, and hides the touch-only Direct/Trackpad switch on devices without touch input. The only new decision is the viewer's mechanical input mapping: an active wheel event on the desktop surface goes through the existing encrypted grant-bound input channel; a browser pinch-wheel event stays local. No admission, identity, PIN, controller-lock, expiry, or revoke authority changes.

## 1. Over-block

The viewer does not forward Ctrl-wheel because browsers use that shape for pinch zoom. An operator intentionally using Ctrl-wheel inside a remote app must use that app's other zoom controls. This affects only that combination; ordinary MacBook two-finger scroll is forwarded. The touch switch is hidden only when no coarse pointer is reported and reappears if actual touch is detected.

## 2. Under-block

Trackpad drivers may produce unusual wheel deltas. The client normalizes line and page units, batches events once per animation frame, and caps each forwarded axis at 200 pixels. A browser that never emits wheel events over the surface cannot be fixed by this mapping. No issue identified with the existing server-side action bounds.

## 3. Level-of-abstraction fit

Browser wheel and pointer-type events belong in the viewer. The existing `DesktopStreamManager`, grant, and `MacDesktopHost` already own encrypted transport and native scroll dispatch. The fix reuses those layers rather than adding another input channel.

## 4. Signal vs authority compliance

Per [signal vs authority](../../docs/signal-vs-authority.md), no new blocking authority is introduced. The viewer applies a deterministic browser-event mapping and the existing grant remains the sole input authority. There is no new static heuristic at a competing-signals decision point.

## 5. Interactions

Wheel events bubble from the desktop image to the surface, where default page scrolling is prevented only while input is enabled. Touch gestures still use pointer events and are unaffected. The client batches wheel deltas before sending; the server still coalesces adjacent scroll commands and enforces its finite queue. Stop and stream exit cancel pending wheel work so it cannot cross a grant boundary.

## 6. External surfaces

Operators see a visible pointer on white windows, a working two-finger MacBook scroll, and no irrelevant touch switch on mouse-only laptops. No other agent or external service receives a new message, and there is no new URL or persistent state. The existing dashboard PIN remains the only operator entry step.

## 6b. Operator-surface quality

The primary action remains opening the desktop with the existing PIN, then using the screen and Stop. The floating controls keep the screen primary; they expose no raw protocol or grant internals. Stop stays visible for safety but is visually separate from the small touch-mode control. On a phone, that control names the finger behavior in plain language; on a mouse-only laptop, it is absent. The pointer outline improves contrast without adding a toolbar or shrinking the remote image.

## 7. Multi-machine posture

The viewer assets are installed per machine. Each host still exposes only its own ready desktop adapter; this fix adds no cross-machine state. Windows remains a separate native host adapter task.

## 8. Rollback cost

Reverting the viewer files restores the prior pointer and input mapping. No migration or data repair is needed. The native Mac test fixture change is test-only.

## Evidence

The focused unit test checks wheel normalization, batching, and Ctrl-wheel handling. A public HTTPS MacBook-sized browser run received a real 1920 × 1080 H.264 frame, verified the pointer outline and touch-switch visibility, sent a wheel event, and confirmed Stop/revocation. The opt-in production-boot Mac test observed a scroll event in a real native window through the encrypted input path. The full unit tier passed 53,124 tests and the HTTP integration tier passed 4,942 tests; the lifecycle tier is the remaining release gate.

## Class-Closure Declaration

No agent-authored-artifact defect or self-triggered controller is added.
## Second-pass review

**Reviewer:** Astra
**Reviewed HEAD:** `8b34f40200f135f5c6dbd4c97e43b55890aebc02`
**Concurrence:** Yes.

Astra independently reviewed the exact PR head for user experience, security,
test harness, and protected-path effects. No remaining P1/P2 issue was found.
The review checked the same-tick IME duplicate guard, visual viewport handling,
bounded and encrypted wheel input, Stop cancellation, frame-size/publishing
fixes, native scroll direction, and the browser smoke and E2E fixture changes.
Physical iPhone keyboard behavior remains unverified by this source review.

The independent Mac M5 local verifier later found 22 failures in the native
capture test file. Its disposable checkout is a protected source tree, and the
test's generated helper cleanup needed the verifier's exact scoped carve-out.
The first test-only patch supplied that scope but missed that `safeUnlink` and
`safeUnlinkSync` did not forward it to the canonical path guard. The correction
forwards the scope in both wrappers and adds a regression test that admits
only files inside the verifier clone and still refuses a protected file
outside it. Astra independently reviewed this corrected patch, found no
P1/P2 issue, and ran `SafeFsExecutor.test.ts` with 23/23 passing. The M5
verifier must rerun on this commit before the release gate can be called green.

For this filesystem-funnel correction: **over-block** is limited to a helper
outside the explicitly named `.worktrees/.verify` root, which must remain
protected; **under-block** is bounded by the existing canonical realpath and
well-formed-root checks, including symlink escape refusal. The scope is
forwarded at the existing `SafeFsExecutor` authority boundary, with no new
parallel guard or heuristic block. It changes no operator UI, notices, URL,
or persistent state and is machine-local by design because each verifier
cleans only its own disposable checkout. Reverting the two wrapper arguments
and test cleanup restores the prior behavior without migration. Astra's
second pass concurs with this corrected review and found no P1/P2 issue.
