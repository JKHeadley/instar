<!-- bump: patch -->

## What Changed

The accounts screens on the dashboard and the phone now say "needs you" only when there is something for the operator to do. A sign-in that nothing has confirmed as dead, or whose automatic repair is blocked by something the agent owns, is shown with its own wording and a Sign in button, and is left out of the count on Home. A device-limit stop still counts, because that decision is the operator's.

A slot holding another account's login used to read as healthy. It now shows as waiting for its first day, while it may still correct itself, then as needs-you with a Sign in button. A login that is gone from the machine always counts. The phone read now uses the same repair blocker list as the dashboard, and if that list can't be read, cells keep their previous state.

## What to Tell Your User

Your accounts screen should stop saying a sign-in needs you when it doesn't. If I'm still checking a sign-in, or automatic repair can't start yet, it says so and tells you there's nothing to do. It also now warns you when an account on a machine is holding the wrong login, which it used to show as fine. Nothing for you to do.

## Summary of New Capabilities

None. The accounts screens report sign-in state more accurately.

## Evidence

On 2026-11-05 the dashboard said a sign-in needed the operator for adriana@sagemindai.io on the Laptop, with no repair open and no action only they could take. On 2026-11-06 the same screen reported nothing needing sign-in while the Laptop slot for justin@sagemindai.io had held echo@sagemindai.io since 2026-10-27. Unit tests and a route test through the phone read cover both cases. Not yet seen on a live screen; that check follows the release.
