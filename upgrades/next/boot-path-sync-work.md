# Server start does less waiting

<!-- bump: patch -->

## What Changed

- The code map rebuilt at start-up rewrites only files whose contents changed.
- The start-up check of which installed Node program to use runs its tests in the background, at most four at once, and stops a test that hangs after 10 seconds.

## What to Tell Your User

- **Faster start-up**: "I trimmed some work my server did while starting, so I'm responsive sooner after a restart."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Quicker, quieter server start | Automatic |

## Evidence

- Unit: `tests/unit/cartographer-scaffold-incremental.test.ts`, `tests/unit/node-symlink-async-probe.test.ts`.
