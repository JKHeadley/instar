# Upgrade Guide — app-context-name-collision

## What Changed

Repairs main. The app conversation context file used a clock-only name with an exclusive write, so two writes in one millisecond threw EEXIST (`tests/unit/app-dispatch-engine.test.ts`). The name now has a random suffix.

## What to Tell Your User

A message sent to me from the app at the exact moment a session was starting could fail. That no longer happens.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| App messages no longer clash with a session that is starting | Automatic |

## Evidence

`tests/unit/app-dispatch-engine.test.ts`: two writes with a fixed clock both succeed; with the suffix removed that test and the start-then-message test fail.
