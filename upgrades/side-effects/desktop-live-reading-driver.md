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

**Reviewer:** an independent second-pass subagent (Claude, fresh context, given the whole script at b15977243 and the page it drives, not the author's conclusion) read it on 2026-11-28 00:23 PT. Verdict at first: do not concur, for two real defects, both fixed in this commit and listed below. On the fixed working tree the same reviewer re-read the whole script and concurred, with no blocking defect. The PIN path and view-only were checked and found sound.

The first version of this script went out unreviewed, as this section used to say.

Fixed after the 2026-11-28 review:
- Stop and cleanup were skipped on SIGINT, SIGTERM, a hung Chrome or a crashed Chrome. Now one cleanup runs on every exit: signal handlers call it, every browser call has a 60 s deadline, pending calls fail when the socket closes, and the Stop click in cleanup waits at most 5 s, then 1.5 s for the revoke.
- The output carried free text: the machine name, raw status lines, decoder error messages, the server's downgrade word unfiltered, and page text on the error paths. The machine name is gone; status lines map to a fixed word list; decoder errors keep only the error name; server words pass only when they are short lowercase words, otherwise "other"; error paths print fixed words only.
- Nits taken: Chrome runs in its own process group, so Ctrl-C reaches only the script, which then presses Stop; the startup page lookup and browser connection have deadlines; a failed Stop exits with code 2; a missing Chrome no longer throws an unhandled error; unused flags removed; the header no longer claims a drop count. Not changed: the scroll delay is the time to the next picture of any kind, so it is read next to the idle rate, which the output prints; the burst window runs about 3.5 s and the printed seconds say so; the idle count starts right after the first picture, so start-up pictures can raise it a little; a Stop call that itself times out is not retried, and the run exits with code 2.

Follow-up (2026-11-27 18:34 PT): **Reviewer:** an independent second-pass reviewer concurred with the decoder-count follow-up. Its nits were all taken: a guard for a missing `VideoDecoder.isConfigSupported`, a guard so a missing `window.__video` cannot lose the reading, and the doc's `agreed` and `videoCodec` wording.

## Class-Closure Declaration

The defect class is claim-vs-evidence: a speed figure must come from pictures the browser drew, timed from the input event's own timestamp.

unbounded-self-action: closure n/a (negative declaration). A one-shot, operator-run measurement that ends with Stop; it is not a self-triggered loop.

## 6b. Operator-surface quality

ELI16: docs/specs/desktop-live-reading.eli16.md.

No user-facing surface changes.
