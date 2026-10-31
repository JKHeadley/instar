# Windows desktop loopback companion

## What Changed

On an opted-in Windows machine, the companion now listens only on Windows loopback. WSL sends the same signed desktop requests through its bounded Windows-local transport. This prevents the Windows Firewall permission dialog caused by listening on the WSL gateway.

## What to Tell Your User

Mama PC uses the same Studio dashboard and PIN. Its Windows desktop connection no longer asks to allow the companion through Windows Firewall. The remote input and Stop checks still determine whether its card is ready.

## Summary of New Capabilities

Windows-local loopback admission replaces the companion's WSL gateway listener. Existing companions can be updated through their old Windows-owned address, then move to loopback without changing the browser or operator grant.

## Evidence

The Mama PC public-browser test captured a live Windows frame, cursor movement, and Stop/post-Stop refusal, but exposed a Windows Firewall permission dialog that remote input could not dismiss. Unit tests cover loopback, legacy gateway migration, and address refusal. The Windows package probe and full suite remain release gates; a live Mama PC control test follows deployment.
