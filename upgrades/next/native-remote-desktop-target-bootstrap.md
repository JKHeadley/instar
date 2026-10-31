# Remote desktop target diagnosis and Windows bridge

<!-- bump: patch -->

## What Changed

The Windows companion installer now distinguishes WSL's NAT and mirrored
networking. It binds to the Windows-owned private gateway under NAT and to
loopback under mirrored networking. Target machines expose a Bearer-only
desktop probe summary so an online Mac with a helper outside its graphical
session is not incorrectly described as a locked machine.

## What to Tell Your User

Keep using the same Desktop page and PIN. A machine is listed as ready only
after its real screen and controls pass a live check. An online agent can still
have an unavailable screen helper; the diagnostic now shows which part failed.

## Summary of New Capabilities

- WSL-to-Windows companion address selection for NAT and mirrored networking.
- Authenticated, read-only local desktop diagnostics without frame or input content.

## Evidence

The address selector has tests for both networking modes and redirect refusal.
The desktop diagnostics route has HTTP and production-boot wiring checks.
Live screen, click, drag, scroll, typing, Stop, and post-Stop refusal on each
target remain required before marking that target ready.
