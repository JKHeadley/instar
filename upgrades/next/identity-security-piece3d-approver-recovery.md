# A way back if you lose every phone that can approve

<!-- bump: patch -->

## What Changed

If you lose every device that can approve changes, you can now get back in. On your new phone, ask to approve. It shows a six-digit code. Send `/approver_reset` with that code in your private chat with the agent, and tap Start. Nothing happens for 72 hours. You get three messages and a push on your other devices, and any device that can still approve stops it just by approving something. After the wait, tap Finish on the new phone and type the fresh code from the chat. Every one of your computers checks the wait for itself, and the new phone can approve only once all of them agree. The lost devices are then removed.

## What to Tell Your User

- **Lost every approving phone**: "On your new phone, open Approve changes and tap Ask to approve. Then send me /approver_reset with the code it shows, in our private chat. It takes 72 hours, and any of your devices that can still approve can stop it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Recovery | `/approver_reset <code>` in the private chat; the app's Finish |
| Stop a recovery | Approve anything on a device that can, or tap Stop it on a notice |

## Evidence

- Unit: `tests/unit/identity-piece3d-recovered-key.test.ts`, `identity-piece3d-recovery-core.test.ts`, `identity-piece3d-recovery-flow.test.ts`.

- Current prerequisite readiness:134unit,47HTTP and10production lifecycle/wiring checks passed (191total), along with TypeScript and independent source review. The maintenance refresh preserves recovery timing, stop and settlement safeguards. Prerequisite, private-chat, security-key, app and real-phone release holds remain in place.
