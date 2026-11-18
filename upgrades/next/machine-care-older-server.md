# Machine care offers only what each machine can do

<!-- bump: patch -->

## What Changed

The Machine care page no longer offers Skip or Change hours on a machine running an older version that can't save them. Buttons now follow what that machine's server actually supports, and a control an older machine lacks says so in plain words.

## What to Tell Your User

- **Machine care buttons**: "On a machine that hasn't updated yet, Machine care no longer shows buttons that couldn't work there."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Machine care hides controls an older machine can't run | Automatic on the Machine care page |

## Evidence

- Unit: `tests/unit/console-machine-care.test.ts` (older-server fixtures).
