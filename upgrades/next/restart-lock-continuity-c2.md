# After an unlock, the screen check runs again at once

<!-- bump: patch -->

## What Changed

On a Mac where machine self-maintenance watches for a stuck screen, an unlock now triggers the screen-access check again right away instead of at its next scheduled time. This applies only if that check hasn't passed since the Mac started. For the next 30 minutes, each result is written to the maintenance log, so a screen that stays stuck after an unlock can be diagnosed. Nothing else changes.

## What to Tell Your User

- **Screen checks after an unlock**: "When a Mac I watch is unlocked, I now check right away whether its screen works, and keep notes for half an hour, so a stuck screen after an unlock is easier to diagnose."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Post-unlock screen check notes | `post-unlock-canary` rows in the machine maintenance log |
