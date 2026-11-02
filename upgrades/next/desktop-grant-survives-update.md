## What Changed

- **One kept Mac desktop helper per Mac.** Instar now runs the Mac helper from `~/.instar/desktop-helper/instar-desktop-host`, shared by every agent on that Mac. It is replaced only when the helper's source changes, so an update that leaves the helper alone, including a rebuild on a newer compiler, keeps macOS's Screen Recording and Accessibility permission. A permission the installed copy still holds keeps working until the kept copy has its own.
- **A lost permission is now explained.** When the helper's source really does change, macOS drops the permission and a person must allow it again at that Mac. The Mac now says that, with the steps, instead of only reading not ready, and raises one Attention item that closes itself when the permission returns.
- `remoteDesktop.retainedHelper: false` returns to the installed copy.

## What to Tell Your User

Remote Desktop on a Mac no longer loses its permission on updates that don't change the part that controls the screen. Each Mac may need you to allow it one more time for the new permanent copy. When an update really does change that part, the Mac now tells you plainly that it needs you, and exactly what to do. A real Apple certificate would end those requests, and that is a separate step.

## Evidence

- Published helpers from 1.3.1575 to 1.3.1579 are byte-identical; 1.3.1580 differs and its Swift source changed.
- Unit tests cover unchanged source with new bytes, source change, older agents, development builds, tampering, unsafe files, the off switch, fallback to a working installed grant, and the notice on both sides of each boundary.
- An integration test drives the plain reason through `/desktop/availability`.
- An e2e test walks a real signed helper through unchanged-source and changed-source updates; another checks the production diagnostics route.

## Summary of New Capabilities

- `/desktop/diagnostics` reports `helperSource`, `helperFallback` and `helperChange`, with the steps when a person is needed.
