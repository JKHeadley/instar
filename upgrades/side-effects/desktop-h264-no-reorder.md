# Side-Effects Review — Remote Desktop: the Mac H.264 stream says frames are never reordered

**Version / slug:** `desktop-h264-no-reorder`
**Date:** `2026-11-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent review, 2026-11-27 21:25 PT — concur`
**Reviewer:** independent second-pass subagent (fresh context, given the code and the measured symptom, not the author's conclusion); verdict concur, no blocking defect

## Summary of the change

Tier 1: 1 dashboard file (`dashboard/desktop.js`) and 1 test file. A live reading on the Mac Studio (2026-11-27 21:13 PT) asked for H.264. The decoder took 10 frames and gave 0 pictures with no error, and the viewer fell to JPEG after its 2.5 s start-up wait. The Mac helper's VTCompressionSession (Baseline 4.0, AllowFrameReordering false) writes an SPS with picture order count type 0 and no VUI. With no `bitstream_restriction`, a decoder must assume reordering up to MaxDpbFrames: 12 at 608x1080 and 4 at 1920x1080. Chrome on a Mac holds that many frames before the first output. The viewer now rewrites the SPS of each keyframe before decoding (`spsWithNoReorder`, `withNoReorderSps`). It appends a VUI whose only content is `bitstream_restriction_flag` 1, with the spec's default size limits, `max_num_reorder_frames` 0 and `max_dec_frame_buffering` max(1, max_num_ref_frames). Emulation prevention is redone. Only the exact shape the encoder writes is changed: Baseline profile 66 (which has no B-frames), POC type 0 or 2, and no VUI. Any other SPS, any read error, or an SPS over 64 bytes passes through untouched. No helper, server, protocol or route change. Both H.264 senders, Mac and Windows, are Baseline, so both can be affected.

## Decision-point inventory

One: whether a keyframe's SPS is rewritten. It is a pure function of the SPS bytes. A failure in parsing means no change.

## 1. Over-block

None. Nothing is refused that was accepted before. A frame the rewrite cannot read passes through as before.

## 2. Under-block

An encoder that really reordered frames while writing this SPS shape would have its pictures shown out of order. The rewrite is limited to Baseline profile, which has no B-frames, and the Mac helper also sets AllowFrameReordering false. Main and High profile streams, which may carry B-frames, pass through untouched. The Windows companion also sends H.264, from Media Foundation at Baseline profile 66, level 4.0, with B-pictures set to 0 (InstarDesktopCompanion.cs around line 1135), so its keyframes are rewritten too when their SPS has no VUI. That is equally safe, because a Baseline stream has no B-frames. Chrome on a Windows target may gain the same start-up fix, but no reading has measured it.

## 3. Level-of-abstraction fit

The fix sits where the decoder is fed. The native helper is the deeper place, but any edit to InstarDesktopHost.swift forces a manual macOS permission grant on every Mac. The viewer already parses the access unit, rejects malformed ones, and owns the decoder settings (`optimizeForLatency`).

## 4. Signal vs authority compliance

Not a gate. It changes the decoder's input metadata only.

## 5. Interactions

The keyframe check (SPS, PPS and IDR present) runs on the original bytes, before the rewrite. The geometry check on output, the start-up timer, the queue-size reset and the JPEG fallback are unchanged. The cost is one copy of a keyframe access unit, about once every 60 frames, plus parsing up to 64 bytes.

## 6. External surfaces

None. The stream on the wire, the server and the status read are unchanged.

## 6b. Operator-surface quality

ELI16: docs/specs/desktop-h264-no-reorder.eli16.md. The change adds no visible element: no text, button or layout. (1) The primary action is unchanged: the remote screen itself, which now shows smooth video sooner instead of dropping to compatibility mode. (2) No raw internals are shown; the rewrite is invisible. (3) No destructive action is touched. (4) No wording changes, so phone-width reading is as before. The person sees one difference: "Video switched to compatibility mode." should no longer appear on a Mac target in Chrome.

## 6c. Delight the user

The touched screen is the Remote Desktop viewer, on every surface that embeds the dashboard (Mac, iPhone, Android, the dashboard itself). Nothing in its layout, wording or controls changes. What the person sees changes like this. Before: on a Mac target in Chrome, the video area stayed black and the status line said "Video switched to compatibility mode." The 21:13 PT live reading on the Studio measured the JPEG mode that followed at about 1.8 to 2.4 pictures a second. After: the picture appears with the first decoded frame, and the status says "Remote desktop is live." (1) The hierarchy is unchanged: the remote screen is first. (2) The one next action, using the remote screen, is available sooner. (3) Spacing and type are unchanged. (4) No internal ids appear; the rewrite is invisible. (5) Every surface gets it together, because each one loads this same dashboard file.

The pictures are real Chrome 158 on a Mac, both 390 x 844 (phone width) and in the same state. 10 VideoToolbox encodes of a synthetic gradient test pattern, made with the helper's settings, are fed one every 250 ms to a stand-in for the viewer's video area, using the viewer's own rewrite function. They show that video area and its status line under a neutral "Mac · Remote Desktop" label, not a real desktop or a full live session.
- Before: docs/specs/images/desktop-h264-no-reorder-before.png
- After: docs/specs/images/desktop-h264-no-reorder-after.png

## 7. Multi-machine posture

Viewer-side: every front and target gets it with the dashboard. A target with an older dashboard is unaffected, because the viewer that decodes is the one that changed.

## 8. Rollback cost

A git revert. No state.

## Class-Closure Declaration

unbounded-self-action: closure n/a (negative declaration). A pure byte rewrite per keyframe. It adds no action, loop or retry.

## Second-pass review

An independent reviewer decoded all four test SPS values with its own parser. Every original field is kept, and the VUI order and defaults match E.1.1 and E.2.1. max_dec_frame_buffering of 1 lies between max_num_ref_frames and MaxDpbFrames. Emulation prevention is handled correctly, and nothing can throw out of receiveH264. The viewer tests passed 19 of 19. Taken from review: the Windows companion also sends Baseline H.264, so this artifact now says its keyframes are rewritten too (safe, because it has no B-frames). Noted and accepted: a second scan and one copy per keyframe, about one in 60 frames. 3-byte start codes would merge NALs, but neither helper emits them.

**Reviewer:** the same independent reviewer looked at both pictures, desktop-h264-no-reorder-before.png (a black video area with "Video switched to compatibility mode.") and desktop-h264-no-reorder-after.png (decoded test-pattern frames with "Remote desktop is live."). It concurred, and found no secrets or internal ids. Taken from it: say the frames are a synthetic test pattern, tie the JPEG rate to the live reading, state the true picture size, and use a neutral machine label instead of a person's name (the pictures were retaken at 390 x 844 with that label).
