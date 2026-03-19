# v0.23.10 — Self-Recovery & ESM Compatibility

## What Changed

Two stability improvements that make agents more resilient:

**Zombie session detection**: Sessions that finish their work but sit idle at the Claude prompt now get automatically killed after 15 minutes. Previously, these zombie sessions would accumulate until the max session limit was reached, blocking health checks, server restarts, and eventually crashing the lifeline process entirely.

**ESM project compatibility**: The boot wrapper now correctly uses `.cjs` extension for projects with `"type": "module"` in their package.json. Previously, the boot wrapper was always generated as `.js`, which Node treated as ESM in module-type projects, causing `require is not defined` crashes. The plist self-heal also now recognizes `.cjs` boot wrappers as valid, preventing unnecessary regeneration.

## What to Tell Your User

Your agent is now better at recovering from stuck states on its own. If sessions were piling up and causing your agent to become unresponsive, that should stop happening. If you had trouble with the agent crashing on startup in a project that uses ES modules, that's also fixed now.

## Summary of New Capabilities

- Idle prompt detection kills zombie Claude sessions after 15 minutes of inactivity
- Boot wrapper uses .cjs extension for ESM-compatible projects
- Plist self-heal accepts both .js and .cjs boot wrappers
