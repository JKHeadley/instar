# Windows remote desktop bootstrap diagnostics

<!-- bump: patch -->

## What Changed

The Windows companion installer now records a fixed failure phase and code if WSL boot cannot prepare the interactive desktop target. The authenticated `GET /desktop/diagnostics` route reports that code while leaving capture and input off. Raw installer output, Windows paths, addresses, and companion secrets stay out of the API. A later successful boot replaces the failure status.
When a Mac's helper reports both a locked console and missing Screen Recording or Accessibility permission, the machine picker names both conditions instead of hiding the permission failure.

## What to Tell Your User

If Mama PC's desktop is unavailable, I can now identify which setup step failed without asking you to read Windows logs. The agent remains reachable while I repair it.
On a Mac, the picker will also show every reported permission issue alongside the helper's console state.

## Summary of New Capabilities

A safe Windows companion boot failure code in the existing desktop diagnostic endpoint.

## Evidence

Unit tests cover fixed vocabulary and safe persisted status. HTTP integration covers Bearer-only diagnostic delivery while the desktop route stays dark. Production boot desktop lifecycle tests cover the existing diagnostic wiring; live Windows validation remains required before this target is advertised as ready.
