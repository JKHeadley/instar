## What Changed

- Built remote desktop through the ordinary Mac lock screen, switched off on every machine. No Mac can turn it on until its macOS version has passed the real crash and Stop tests on hardware; the proven list ships empty.
- New `GET /desktop/locked/status`, `POST /desktop/locked/settings` (dashboard PIN) and `POST /desktop/locked/disable`. A new encrypted control channel reaches only viewers that ask for it.
- The owner types the password live, sealed for the Mac helper alone. No route, config key or job can originate one. The Mac relocks at the end and is watched for 2 minutes.

## What to Tell Your User

Nothing changes yet. Opening a locked Mac from your phone is built but stays off everywhere until it has passed real tests on a real Mac.

## Evidence

- Unit tests cover the lock reading, the relock duty, the input rules, the control channel and the assertion. The real helper's state verbs and its zombie-process check ran on this Mac.
- Integration tests drive the routes. An e2e test boots the production server and confirms the enable is refused.
- The relock itself has never run, by design: P12 and P15 cover it on proof hardware before any Mac can enable.

## Summary of New Capabilities

- `GET /desktop/locked/status` reports whether locked-screen access is on, and why not, with `?scope=pool` across machines.
