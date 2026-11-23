# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- tracked: topic-143810 -->

## What Changed

Added internal lifecycle ownership for the selected-local-history private channel: live owner/device/issuer checks, capacity before handshake creation, absolute expiry, safe channel replacement, revocation and held-exchange disposal. This checkpoint constructs no production service and enables no route or app action. It supports the existing selected-history implementation contract.

## What to Tell Your User

No new action is available from this checkpoint. Bringing local conversations into the Mac app is still being connected and verified.

## Summary of New Capabilities

None exposed. The complete native import remains unavailable until authenticated ingress, operation storage, consent and installed-app acceptance pass.

## Evidence

The actual TypeScript build and 50 focused checks passed across handshake, channel records and lifecycle registry. Tests cover independent clock expiry, live key/profile/boot changes, resource retention, failed refresh without aborting existing work, reentrant callbacks and buffer clearing. Full frozen-revision verification, real signed HTTP ingress and complete app/server acceptance are not claimed. See `upgrades/side-effects/local-history-channel-lifecycle.md`.
