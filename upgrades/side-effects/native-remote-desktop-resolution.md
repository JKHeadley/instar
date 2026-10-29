# Side-Effects Review — native desktop resolution

**Version / slug:** `native-remote-desktop-resolution`
**Date:** 2026-10-29
**Author:** Echo

## Scope and decision points

The 960 × 540 capture ceiling made Echo's 1920 × 1080 display look soft on a laptop. The Mac capture helper, signed video contract, browser decoder, JPEG fallback, and bounded sender now allow up to 1920 × 1080. Grant admission, PIN validation, controller lock, expiry, revocation, and native input are unchanged.

## Over-block

A browser unable to decode AVC Baseline level 4.0 selects the JPEG path. A browser that advertises support but presents no first frame within 2.5 seconds requests the same authenticated JPEG fallback. A complex frame exceeding 1.25 MB may be refused by the native helper; three consecutive capture errors close the grant. Those bounds remain finite and visible through the existing stream failure path.

## Under-block and performance

The encoder target is 5 Mbps and the transport budget is 10 Mbps, but this does not prove all networks sustain 1080p at 15 fps. JPEG fallback can use more bandwidth than H.264. The browser canvas draws full-resolution frames and may cost more CPU on older devices. The helper still keeps only the latest captured image, the sender drops under backpressure, and a dropped H.264 dependency forces a keyframe. Live browser and device measurements remain acceptance evidence.

## Layer, authority, and interactions

The maximum geometry is part of the signed H.264 contract, so an untrusted stream cannot silently enlarge decoded dimensions. The browser checks the native frame header and decoded frame size. Native and transport byte caps prevent unbounded memory growth. A decoder mismatch goes through the existing authenticated JPEG fallback; it does not create a fresh grant. Stop and revoke still release the capture helper and blank the viewer.

## 6b. Operator-surface quality

The page still leads with the dashboard PIN and **Open desktop**, then gives the live screen most of the viewing area. Video profile, frame size, and decoder state stay out of the primary UI; the only fallback notice says the video switched to compatibility mode. Stop remains visible because it is the operator's immediate way to end access, and this change adds no destructive action. The PIN instruction and controls remain in plain language and fit phone width; the full-resolution stream is scaled to the available window rather than creating page overflow. The public browser check must confirm that the resulting image is readable on a laptop, since geometry alone does not prove perceived quality.

## Multi-machine and rollback

This change affects the Mac adapter only. Windows and Linux hosts remain separate work. Reverting the resolution commit restores the prior capture bounds; existing grants have finite lifetimes and no persistent video state requires migration.

## Class-Closure Declaration

`unbounded-self-action`: closure `n/a`. This commit changes capture geometry and byte budget constants in an existing bounded, grant-owned frame loop. Its new decoder startup timer fires once for a user-opened stream and never schedules another attempt. The existing grant expiry, idle limit, frame-rate ceiling, queue ceiling, and drop behavior keep the stream finite under sustained pressure.
