# Side effects review: native desktop continuous capture

**Tier:** 2, security-sensitive remote display path. **Source:** approved `docs/specs/blocker-handoff-across-machines-and-surfaces.md` and its quality plan. **Scope:** one Swift capture helper, its Node pipe and sender, digest commit, tests and docs. One review round with Astra; one commit gate attempt is planned. This is a narrow change within the approved Mac target, but frames contain the full logged-in desktop.

## Decision points

- `DirectDesktopAccess.captureEncrypted`: changes the decision to skip unchanged frames; it commits a digest only after the bounded transport queues a frame. Live grant, PIN session, lease, OS state and target identity admission remain in the existing authority.
- `DesktopStreamManager`: a changed frame still must fit the size, bandwidth and backpressure limits. Null frames do not terminate a session. A dropped frame is retried on the next tick.
- `MacDesktopHost`: a capture reply is accepted only with a bounded length and valid JPEG markers. The capture process stops with its grant and cannot listen on the network.

## 1. Over-block

A native capture process that briefly fails or emits an invalid frame can still end the grant after three failed capture ticks. A genuine session with an unusually complex 960×540 screen whose JPEG exceeds 600 KB may be refused. These are deliberate finite limits; live acceptance must reveal whether they are too strict.

## 2. Under-block

The first Mac target remains tied to an active logged-in desktop; there is no unattended login-screen path. Fixed 960×540 JPEG and a 10 Mbps sender do not establish adaptive resolution, sustained 10–15 fps, or AnyDesk-level latency. Physical Safari and Android behavior still needs device evidence. The capture helper has no independent network or grant authority; a compromised parent process remains a higher-trust boundary.

## 3. Level of abstraction

ScreenCaptureKit owns newest-frame capture; Node owns pipe framing and helper lifecycle; the target authority owns grant validity; the WebSocket sender owns bandwidth and delivery state. Digest commitment belongs after the sender's acceptance check, because capture alone cannot know whether the browser was offered the frame. No parallel operator-identity gate is introduced.

## 4. Signal vs authority

Per `docs/signal-vs-authority.md`, frame status, image equality and transport budget are transport signals, not proof of operator identity. They never mint or extend a grant. The deterministic size and framing checks deny malformed native data, while the existing target authority continues to decide access from the PIN-derived session, browser proof, target key, expiry and OS availability. No static heuristic is added at a competing-signals judgment point.

## 5. Interactions and races

The sender rechecks the grant after asynchronous capture and before queueing a frame. A revoke kills capture and input children, closes the stream and clears the browser. The native callback ignores data and close events from a child that is no longer current. A changed frame discarded for bandwidth remains eligible even if the screen stops changing; tests cover that path. `ws.send` callback errors close and revoke the session. A zero-length native reply reuses only the last frame within that same capture process, then the target digest suppresses retransmission when appropriate.

## 6. External and operator surfaces

The same full-screen dashboard viewer and PIN-only flow are used; there is no new operator action or extra setup. Screen bytes remain in volatile memory and are not logged. The capture helper's window may appear in the macOS screen-capture indicator while active. Native CPU and bandwidth load increase with visible motion. The public viewer's phone-emulated touch and pointer burst passed on the preceding reliability build; the continuous build must pass its own public-browser check before its performance can be claimed.

No dashboard markup or script changes are part of this slice, so the operator-surface quality section is not applicable.

## 7. Multi-machine posture

**Machine-local by design:** each target captures its own display under its own grant and OS permissions. Images, grant keys and control state are not replicated. No user-facing notices or durable grant state are added; restart closes the grant. The existing machine-named dashboard link reaches the target through its tunnel. Windows and Linux require separate native adapters under the same host contract before being advertised.

## 8. Rollback

Disable `remoteDesktop.enabled` and restart the target to revoke all access immediately. Revert the native capture and sender changes in a patch release; no schema or durable grant migration is needed. The installed preview overlay can be restored from its recorded backup if the live acceptance check fails.

## Evidence and independent review

Build and lint pass. Focused unit checks cover dropped-frame retry, transport-budget commitment, fragmented/invalid native replies, child exit, cancellation and timeout. The native helper returned a valid local JPEG and zero-length unchanged replies. A 12-second Core Animation motion check yielded 145 distinct native images from 213 requests at the 60 fps capture-source setting, with no capture errors; that is about 12.1 distinct images per second at the native boundary, not public-browser FPS. HTTP integration, production-boot, full-suite and public-browser checks are required before release. Astra's first pass found premature digest commitment and missing native-pipe boundary tests. Its second pass found an uncaught `EPIPE` when a helper closes stdin; the parent now listens for stdin errors across capture and input helpers. Revised tests send one valid frame or input reply, close helper stdin, then verify the second write rejects without crashing. Astra's final review concurred that the P1 is closed and identified no remaining concern in this path.

## Class-Closure Declaration

`unbounded-self-action`: **guard**. The native capture process reads one-byte frame requests and exits on pipe EOF; it has no timer that sends frames or input on its own. Revocation kills the capture and input children and closes the WebSocket. The native-pipe cancellation test proves an in-flight request rejects when Stop ends the grant. The bounded sender has a fixed 50 ms tick only while the grant remains active, and every tick rechecks authority before queueing a frame.
