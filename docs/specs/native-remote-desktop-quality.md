# Native remote desktop quality plan

Status: implementation in progress. Justin's 2026-10-28 phone test found 12–13 second sessions, a small scrolling viewer, and choppy pointer movement. This plan extends the approved remote desktop and blocker hand-off design. The operator flow remains: open Instar, enter the existing dashboard PIN, choose a machine, control it, Stop. No Telegram step or terminal task is introduced.

## Evidence and review

- The Mac prototype takes a ScreenCaptureKit screenshot in a fresh Swift process every frame and aims for a 500 ms gap between frames. Input and readiness also spawn a process per operation.
- The server encrypted frames before the bandwidth decision; the browser required exact sequence continuity. A deliberately dropped encrypted frame therefore caused the next frame to close the viewer. This is a deterministic code defect. The audit recorded two recent connected sessions ending after 12–13 seconds, but lacks a close reason, so it cannot prove that this defect caused those specific closures.
- The stream closed on more than eight queued inputs and on any capture error. Continuous phone movement can exercise both paths.
- The image already declared `touch-action: none`; the rest of the page remained scrollable and the image did not capture the pointer. Independent Astra, Claude Fable 5, and Gemini 4 Argon reviews all recommended a viewport-sized touch surface and a trackpad interaction model. Fable and Argon assumed the touch rule was absent; source inspection corrected that detail.

## Delivery steps

### 1. Reliability and phone control

1. Accept strictly increasing authenticated frame sequence numbers. A missing frame is normal under backpressure; a duplicate or older nonce is refused. Keep a fresh AES-GCM key for each grant.
2. Retry isolated capture failures with a small fixed bound. Grant revocation, expiry, permission loss, and invalid crypto still stop immediately. Capture errors never turn into unbounded retries.
3. Coalesce consecutive pointer moves and scroll deltas. Preserve every click and key action in order. Bound the queue; a discrete-command flood beyond the cap is refused.
4. Give the active viewer the entire dynamic phone viewport, including safe areas. Browser page scrolling cannot compete with remote gestures. Keep Stop visible.
5. Default touch to a relative trackpad: one finger moves, tap clicks, two fingers scroll, with a Direct mode for touch-to-target. Locally render the pointer between video updates. Mouse users retain direct control.
6. Distinguish deliberate Stop from an unexpected connection loss. A failed stream does not silently reopen or replay input. A future reconnect must use fresh keys and recheck the current grant.

Acceptance: real Mac capture/input/revoke proof; eight-minute active session with no unintended close under normal link; synthetic backpressure with frame drops and burst input; iPhone Safari and Android Chrome portrait/landscape checks; no document movement during gestures; Stop prevents any later input. The ten-minute grant and two-minute idle policy remain intact for this step.

### 2. Persistent native host and adaptive capture

The per-action Swift processes are replaced by one grant-owned capture helper and one input helper, each with bounded IPC and a self-exit when its control pipe closes. ScreenCaptureKit `SCStream` supplies continuous frames; the capture helper retains only the newest frame, while the sender skips unchanged images. Target a measured 10–15 fps at phone resolution with adaptive JPEG/WebP quality. Input and video run independently, with a cursor metadata path. A transport failure permits a bounded reconnect only after authority and identity checks, without replaying clicks or keystrokes.

Acceptance: at most one capture helper and one input helper per active grant; both exit on Stop, expiry, crash, and server restart; sustained 10–15 fps during motion on a documented connection; no unbounded frame queue; measured input and glass-to-glass latency; explicit offline/permission explanations.

### 3. Video quality across machines

Use native screen capture plus hardware H.264 encoding where available. The browser decodes through a capability-tested path with a still-frame fallback. Measure WebCodecs support on actual target browsers before choosing that path; no model review's compatibility claim is treated as proof. Keep the existing authenticated WebSocket first, then compare WebRTC as an optional transport if measured latency justifies its signaling/NAT cost. The protocol carries screen geometry, cursor, codec, keyframes, acknowledgements, and congestion feedback. Windows and Linux host adapters share the grant and browser protocol but use their own OS permission and capture/input boundaries.

Acceptance: repeated user tasks (small-target click, window drag, long-page scroll, Unicode typing, modifiers), 30 fps under active motion on supported hosts, measured p95 visual latency under documented LAN and tunnel conditions, recovery from link interruption, and live proof on each advertised platform. PIN-only operator UX and immediate revocation are invariants throughout.

## Rollout and durability

The current Mac preview is an overlay on Echo's installed package and can be replaced by an Instar update. The feature must land in the release/update path before it is presented as durable. Each stage needs unit, HTTP integration, production boot, and real browser/host checks. An emulated phone viewport does not substitute for a physical phone run. Screen images and input content stay out of logs; diagnostics record only reason codes and timing.

## First pass measurements, 2026-10-28

The public HTTPS viewer ran in a Chrome phone emulation at 390×844 for eight active minutes. The image filled the dynamic viewport, the surface reported `touch-action: none`, a touch gesture caused neither page scroll nor `pointercancel`, and Stop removed the frame. The browser observed a changed encrypted frame at all sixteen 30-second checks. A separate ten-second count saw 24 loaded images, about 2.4 fps. This proves the earlier few-second disconnect is absent in this path, but it also confirms the screenshot process is well short of smooth video. Physical Safari and Android checks and the continuous capture stage remain acceptance work.

## Continuous capture implementation status

The next branch replaces per-frame screenshot launches with a ScreenCaptureKit stream in a single native capture process. Its pipe carries length-prefixed JPEGs, including a zero-length reply when the desktop did not change. The Node wrapper retains only the last frame; the target skips encryption and transport for identical frames. The process exits when the grant ends or its pipe closes. The capture source requests up to 60 fps, while the bounded WebSocket sender requests at up to 20 fps and caps video at 10 Mbps. The grant checks still run at every operation; the slower native readiness probe is shared for at most 500 ms because the native capture and input helpers independently check the OS session on every request.

A live local helper read produced a valid JPEG, then two zero-length unchanged replies. A ten-second animated-window probe was limited by the test window itself (about five UI updates per second under elevated machine load), so it is not valid evidence for the 10–15 fps acceptance target. Production-boot, public-browser, device and latency measurements remain required before calling this step complete.

Astra's follow-up review found that a changed frame discarded by the sender's bandwidth gate could be incorrectly marked as delivered. The sender now commits the image digest only after `ws.send` queues that record. A unit regression covers the unchanged-screen retry, and native pipe tests exercise fragmented replies, malformed lengths, premature exit, cancellation, and timeout. Its final pass also found that a native helper closing its stdin could crash the parent on an uncaught `EPIPE`; stdin errors now close the affected helper through the same generation-guarded failure path. Tests send a valid capture or input reply, close helper stdin, then verify the next request fails without crashing. The public phone-emulated viewer also survived a rapid pointer burst without scrolling or closing.

A local Core Animation motion check with a 30 fps ScreenCaptureKit minimum interval requested 208 native frames in 12 seconds and observed 93 distinct images, about 7.8 distinct images per second, with no capture errors. Raising the capture source interval to 60 fps and repeating the same check yielded 213 requests and 145 distinct images in 12 seconds, about 12.1 distinct images per second, with no capture errors. The sender still requests at most 20 times per second and enforces its 10 Mbps limit. This meets the interim native-boundary motion target in one local run; public-browser throughput, sustained load and physical-device targets remain open.

The continuous build then delivered 193 images in a 12.5-second public HTTPS Chrome phone viewport, about 15.4 per second, while the active viewer remained connected. The live Mac production-boot check passed PIN unlock, encrypted frame, mouse movement and revoke. A local phone-emulated viewer remained connected for eight minutes and saw changed images at 13 of 16 thirty-second checks. The original Stop UI waited for the HTTP revoke response before clearing the image; under heavy server load that took longer than 700 ms even though the stop audit landed. The viewer now blanks and disables controls immediately, ignores late frames, and continues the target revoke request. A public phone-emulated pointer burst and immediate-blank check passed.

Two long public-tunnel checks were interrupted by Echo server replacement and an intermittent tunnel 502 during concurrent repository verification. These are observed deployment and transport limits, not evidence of a continuous-capture failure. Long public-tunnel stability, physical phone behavior, glass-to-glass latency and the full test suite remain open before this stage is called complete.
