# Side effects review: native desktop continuous capture

**Tier:** 2, security-sensitive remote display path. **Source:** approved `docs/specs/blocker-handoff-across-machines-and-surfaces.md` and its quality plan. **Scope:** persistent Mac capture, bounded sender, tunnel wake recovery, target-authorized reconnect, browser viewer, tests and docs. Astra reviewed the capture and reconnect changes. Frames contain the full logged-in desktop.

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

The sender rechecks the grant after asynchronous capture and before queueing a frame. A revoke kills capture and input children, closes the stream and clears the browser. The native callback ignores data and close events from a child that is no longer current. A changed frame discarded for bandwidth remains eligible even if the screen stops changing; tests cover that path. A transport failure closes the stream and fences input; the bounded same-session recovery rules decide whether it can resume. A zero-length native reply reuses only the last frame within that same capture process, then the target digest suppresses retransmission when appropriate.

## 6. External and operator surfaces

The same full-screen dashboard viewer and PIN-only flow are used; there is no new operator action or extra setup. Screen bytes remain in volatile memory and are not logged. The capture helper's window may appear in the macOS screen-capture indicator while active. Native CPU and bandwidth load increase with visible motion. The viewer now blanks the screen and hides controls as soon as Stop is pressed, while the target revocation request completes. Late decrypted frames cannot refill the stopped view. A public phone-emulated touch and pointer burst check passed on this build.

## 6b. Operator-surface quality

The page leads with the selected machine, a plain description of full desktop control, the dashboard PIN, and **Open desktop**. The live view fills the phone viewport; **Stop** remains visible in the control bar and during reconnect because it is the immediate safety action, not an invitation to change files or settings. The page contains no grant IDs, cryptographic keys, transport reason codes, command syntax, or other raw internals as primary content. Status text says whether the desktop is live, reconnecting, stopped, or unavailable in ordinary language. At 390×844, the control surface fills the viewport, touch gestures do not scroll the page, and the trackpad instructions remain readable below the image; the live phone-emulated check confirms layout and touch behavior. A physical iPhone/Android usability pass is still required before claiming device parity.

## 7. Multi-machine posture

**Machine-local by design:** each target captures its own display under its own grant and OS permissions. Images, grant keys and control state are not replicated. No user-facing notices or durable grant state are added; restart closes the grant. The existing machine-named dashboard link reaches the target through its tunnel. Windows and Linux require separate native adapters under the same host contract before being advertised.

## 8. Rollback

Disable `remoteDesktop.enabled` and restart the target to revoke all access immediately. Revert the native capture and sender changes in a patch release; no schema or durable grant migration is needed. The installed preview overlay can be restored from its recorded backup if the live acceptance check fails.

## Evidence and independent review

Build and lint pass. Focused unit checks cover dropped-frame retry, transport-budget commitment, fragmented/invalid native replies, child exit, cancellation and timeout. The native helper returned a valid local JPEG and zero-length unchanged replies. A 12-second Core Animation motion check yielded 145 distinct native images from 213 requests at the 60 fps capture-source setting, with no capture errors; that is about 12.1 distinct images per second at the native boundary, not public-browser FPS. HTTP integration, production-boot, full-suite and public-browser checks are required before release. Astra's first pass found premature digest commitment and missing native-pipe boundary tests. Its second pass found an uncaught `EPIPE` when a helper closes stdin; the parent now listens for stdin errors across capture and input helpers. Revised tests send one valid frame or input reply, close helper stdin, then verify the second write rejects without crashing. Astra's final review concurred that the P1 is closed and identified no remaining concern in this path.

The live Mac production-boot check passed PIN, encrypted frame, input, and revoke. A public Chrome phone viewport received 193 images in 12.5 seconds, about 15.4 per second. The public touch and pointer burst passed, and the immediate Stop view was checked after the UI correction. A local phone-emulated viewer stayed connected for eight minutes with changed images at 13 of 16 checks; its target stop was audited, although the original viewer kept the image visible while the HTTP response was slow, which led to the immediate-blank correction. Long public-tunnel stability and the full suite remain open.

## Wake recovery

The public tunnel interruption was traced to wake recovery restarting Cloudflare while a desktop WebSocket was active. Before wake-time `forceStop`, the server now probes the current public URL's authenticated `/whoami` route with a fresh bounded request and verifies the expected agent ID and port. A reachable tunnel is preserved; a failed, timed-out, malformed, or wrong-identity result triggers the existing restart, independent of whether a desktop socket exists. A connection-generation check discards stale probe results after a replacement, including same-URL replacement. A singleflight guard stays held until the actual restart task settles, even if the 15-second reporting window expires. Unit checks cover reachable and failed probes, active and inactive sockets, same-URL generations, and overlapping wakes with a delayed restart. A successful HTTP probe proves public reachability, while the live desktop soak separately checks WebSocket continuity. Long public-link validation is still required.

## Unexpected disconnect recovery

A later public session ran for nearly seven minutes before an abnormal WebSocket close reached both browser and target; Echo's HTTP route remained available, so the exact transport cause is not established. The stream manager records only one closure reason code per session, with no grant, operator, screen, or input value. On an unexpected close the browser immediately disables input and blanks the frame. The first browser-only retry was removed from the live preview after Astra found that it could create new grants after deliberate revocation or expiry. The revised path keeps one logical request and its original deadlines. The target permits resume only after an unprompted transport loss, stops the old input helper, invalidates its ticket and key, and allows at most three fresh-key replacements. The browser checks the target's interrupted state before requesting one idempotent replacement, verifies the target identity again, and fences old socket events. Stop stays visible during reconnect and revokes the stable request identity. Explicit Stop, revocation, expiry, authority, and protocol failures remain terminal. This revised path requires fresh live and full-suite validation.

The initial browser-only retry deliberately closed its first WebSocket after ten seconds and resumed, then ran 90 seconds before Stop. That result does not validate the revised target-authorized resume. A separate eight-minute run on the unsafe retry was stopped when Astra's finding arrived. The revised path then passed a controlled local test: a proxy destroyed only the viewer WebSocket, producing code 1006; HTTP stayed available, and the QA browser simulated a lost ticket response after the target issued it. The target marked the original request interrupted, the browser reused an idempotent ticket for the same fresh browser proof, and a second encrypted stream opened about 1.1 seconds later. Stop immediately blanked the viewer and revoked the stable request.

The next public run showed a different failure at roughly 150 seconds: the browser lost the stream while the target kept the old grant connected. Recovery now also permits the same browser to replace that half-open transport using a signature from its current Ed25519 key over the current connection nonce, attempt ID and all replacement keys. The target requires the same PIN session, original deadlines and three-replacement cap, stops input and closes the old grant before approving fresh keys. A changed payload with the same attempt is refused. Admission waits for any pending local indicator startup before takeover; a stale admission cannot revoke or bind itself to the replacement. The browser advances its verified key/nonce generation before trying the replacement WebSocket, so a failed upgrade cannot strand the next resume. Unit tests cover the half-open takeover, wrong proof, old-generation replay, changed-payload reuse, pending admission, Stop and expiry during probe, old-stream fencing, parser-error terminality and ticket idempotency. Astra reviewed these two races and found no remaining P1/P2 in the fixes. A controlled proxy then cut only the browser side of a live WebSocket while leaving the target connected; the viewer opened a new encrypted stream about 1.1 seconds later, and Stop blanked and revoked it. The eight-minute real public-tunnel run and full suite remain release gates.

## Class-Closure Declaration

`unbounded-self-action`: **guard**. The native capture process reads one-byte frame requests and exits on pipe EOF; it has no timer that sends frames or input on its own. Revocation kills the capture and input children and closes the WebSocket. The native-pipe cancellation test proves an in-flight request rejects when Stop ends the grant. The bounded sender has a fixed 50 ms tick only while the grant remains active, and every tick rechecks authority before queueing a frame.
