# Wedge detection on a Mac sees a stuck app launch, and stops piling up stuck canaries

<!-- bump: patch -->

## What Changed

The Mac wedge check launches a tiny invisible app that quits at once. It used to count the launch as fine whenever the launcher said so, even when macOS had left the app frozen and never let it run, which is exactly the stuck state it is meant to catch. Now it looks two seconds later: a frozen canary counts as a sign of a wedge, and an unreadable process list counts as unknown, never as fine. Any canary left over from an earlier check is ended before the next one starts, so a wedged Mac no longer collects dozens of frozen copies. Wedge detection is still watch-only; nothing restarts.

## What to Tell Your User

- **Stuck-Mac detection**: "When a Mac stops opening apps properly, I now notice it reliably, and my check no longer leaves frozen leftovers behind. Nothing restarts on its own yet."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Frozen-launch detection on macOS | Automatic; read in Machine care status under the wedge reading |

## Evidence

- Mac Studio, 2026-11-16: the check logged "passed" at 09:29 PST while its canary sat frozen; 11 frozen canaries had piled up over 20 hours.
- Unit: `tests/unit/machine-wedge-mac-canary.test.ts`.
