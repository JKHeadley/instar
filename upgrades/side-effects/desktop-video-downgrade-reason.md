# Side-Effects Review — Remote Desktop: say why a session left H.264

**Version / slug:** `desktop-video-downgrade-reason`
**Date:** `2026-11-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent review, 2026-11-27 16:49 PT — concur`
**Reviewer:** independent second-pass subagent (fresh context, given the code not the author's conclusion); verdict concur, no blocking defect

## Summary of the change

Tier 1: 1 source file and 1 test file, about 20 lines. A live reading on the Mac Studio (2026-11-27 15:23 PT) asked for H.264, the browser said it could decode H.264, and the session still fell to JPEG at about 0.6 pictures a second or less. The viewer shows the same "Video switched to compatibility mode" line for three different causes, and the server records none of them. `DirectDesktopAccess` now keeps the first reason a session left H.264 on the request row, and returns it in the existing status read as `videoDowngrade`. It is one of: `capture-<fixed word from the host error>`, through `auditReason`, so anything that is not a fixed word reads `capture-other`; `host-no-h264`; or `viewer-fallback`. It changes no video behaviour.

## Decision-point inventory

None. It is a recorded fact, read by status; nothing branches on it.

## 1. Over-block / 2. Under-block

No block or allow surface.

## 3. Level-of-abstraction fit

The reason is recorded where the downgrade happens, in the session's capture closure and its viewer-fallback hook. It is reported through the status read the viewer and the reading driver already make.

## 4. Signal vs authority compliance

A signal only.

## 5. Interactions

The status reply for an approved request gains an optional field. Clients that ignore unknown fields, which is every current one, are unaffected. The field is set once (`??=`) and never cleared for the life of the logical request, across resumes, so a later JPEG frame or a resumed stream cannot hide the first cause. A stream resumed on H.264 after an earlier downgrade still shows the earlier reason, so read it as the first downgrade of the request, not of the current stream.

## 6. External surfaces

The `GET /desktop/requests/:id` status reply and the `POST /desktop/requests/:id/resume` reply (which returns status) carry the new optional field, only to the request's own verified viewer, as the rest of that reply already is. No free text from errors crosses: `auditReason` reduces it to a fixed word.

## 7. Multi-machine posture

Per target machine, carried in the existing status reply, including when relayed by the designated front.

## 8. Rollback cost

A git revert.

## Class-Closure Declaration

unbounded-self-action: closure n/a (negative declaration). Records one reason string on a request row, set once per session (`??=`). No action, loop or retry is added.

## Second-pass review

An independent reviewer found no blocking defect. Only fixed words cross, only the request's viewer reads it, the relay passes it untouched, all three downgrade sites are covered, and no test pins the exact reply shape. Taken from review: the field is documented as the first downgrade of the request across resumes (sections 5 and 6), and the resume reply is named as a carrier.

## Follow-up (2026-11-27 21:03 PT)

The release note said "a short fixed reason", which the release-note validator reads as a bug-fix claim, so Repo Invariants asked for an Evidence section. It is a diagnostic field, so the note now says "set reason". No code change.
