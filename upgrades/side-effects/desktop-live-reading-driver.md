# Remote Desktop live-reading driver

Tier 1. One new operator script, `scripts/desktop-live-reading.mjs`. Nothing imports it, and nothing runs it automatically. It is a live-proof tool for CMT-033, the measured phone-to-machine reading.

## Decision and operator impact

The driver is adapted from `scripts/desktop-public-browser-smoke.mjs`. It reads the dashboard PIN from stdin, opens `/dashboard/desktop.html?machineId=<id>` in a temporary headless Chrome profile, and measures:
- the time from PIN entry to the first picture;
- the idle picture rate over 10 s;
- the delay from each of 20 single scroll steps to the next picture, alternating down and up so the remote page ends where it began;
- the picture rate and longest gaps during a 3 s scroll burst;
- any status changes, and whether Stop blanked the session.

It prints only numbers and always presses Stop. `--view-only` sends no input. The PIN is never printed or logged.

## Verification and rollback

`node --check` passes. A dry run against a locked M5 reached the Studio viewer and was refused with "Incorrect PIN", because the M5 PIN is not the Studio's. That showed the page address, the sign-in path and the failure output work. Delete the file to roll back.

## Follow-up (2026-11-27 evening): which side left H.264

The 15:23 Studio reading asked for H.264, the browser said it could decode it, and both sessions still fell to JPEG. The viewer shows one status line for three different causes, so the reading could not tell them apart. The script now also records:
- whether the browser reports H.264 support and whether the page asked for it;
- counts from the page's own video decoder: created, configured, frames decoded, frames shown, errors. It wraps the page's `VideoDecoder` and only counts, so the page behaves the same;
- before pressing Stop, the server's own status for the session: the codec and, when the server change ships, the reason it left H.264.
An `agreed` field in an uncommitted draft is gone: the session-request reply carries only the request id, so it could never be filled. The server's `videoCodec` is set only when the session starts or resumes, so after a viewer fallback mid-session it still reads `h264`. On its own it does not prove the stream stayed H.264; the decoder counts and `videoDowngrade` do. The script still prints only numbers and fixed words. It never prints the PIN or anything on the screen, and it still presses Stop at the end. It is still a standalone script that nothing imports.

## Second-pass review

**Reviewer:** not reviewed. It is a standalone operator script with no importer; it goes through review before it is published.

Follow-up (2026-11-27 18:34 PT): **Reviewer:** an independent second-pass reviewer concurred with the decoder-count follow-up. Its nits were all taken: a guard for a missing `VideoDecoder.isConfigSupported`, a guard so a missing `window.__video` cannot lose the reading, and the doc's `agreed` and `videoCodec` wording.

## Class-Closure Declaration

The defect class is claim-vs-evidence: a speed figure must come from pictures the browser drew, timed from the input event's own timestamp.

unbounded-self-action: closure n/a (negative declaration). A one-shot, operator-run measurement that ends with Stop; it is not a self-triggered loop.

## 6b. Operator-surface quality

ELI16: docs/specs/desktop-live-reading.eli16.md.

No user-facing surface changes.
