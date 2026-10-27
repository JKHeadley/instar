# Throwaway test agents can no longer become permanent jobs on your login

## What Changed

- `src/core/ThrowawayAgentGuard.ts` (new): an agent in a temporary folder, or created with a sandboxed `HOME`, is a throwaway.
- `src/commands/setup.ts` `installAutoStart`: the one function every auto-start installer uses now refuses a throwaway (`--force` overrides) and runs under a per-agent lock shared with teardown. `PostUpdateMigrator` no longer rewrites or reloads the machine-wide fleet watchdog from a throwaway.
- `src/commands/init.ts`: a non-interactive `init` records `autostart.autoInstall: false` (new `--autostart` flag lifts it); a throwaway gets `throwawayAgent.expiresAt` (24h; `--expires-in`, `--keep`).
- `src/commands/server.ts`, `src/lifeline/TelegramLifeline.ts`: an expired throwaway removes its own auto-start (only the unit whose working directory is this agent) and exits; the startup self-heals no longer install a missing unit when `autoInstall` is false; a temp-folder agent with no record gets a 24h expiry at boot.
- `src/scheduler/JobScheduler.ts`: a temp-folder or recorded throwaway refuses every scheduled job (skip reason `throwaway-agent`; override `scheduler.allowOnThrowawayAgent: true`).
- CLAUDE.md template + `migrateClaudeMd()`: "Throwaway test agents" section.

Why: on 2026-10-21 a release-check script made a test agent in a temporary folder with a sandboxed `HOME`. Its server's auto-start self-heal loaded a start-at-login job into the real user launchd, launchd then ran it with the real `HOME`, and for five days it ran scheduled jobs on the operator's Claude subscription (~2.9B tokens, about 12% of that week's Claude use).

## What to Tell Your User

If a test copy of me is ever made in a temporary folder, it can no longer install itself to start at login or run my scheduled jobs on your subscription, and it switches itself off after a day. Your normal agents are not affected.

## Summary of New Capabilities

- `instar init --expires-in 6h` / `--keep` / `--autostart`, and `instar autostart install --force`.
- `scheduler.allowOnThrowawayAgent: true` for a test that needs scheduled jobs.
- `.instar/state/throwaway-expired.json` records what an expired throwaway removed.

## Evidence

Live macOS reproduction (`scripts/livetest-test-agent-leak-guard.mjs`, real launchd): 14/14 — the incident shape loads no job and writes no plist in either home; a force-installed, expired throwaway restarted by launchd unloads itself and stays gone. Unit `tests/unit/ThrowawayAgentGuard.test.ts`, `tests/unit/JobScheduler-throwaway-guard.test.ts`, `tests/unit/Config-throwaway-scheduler.test.ts`; integration `tests/integration/test-agent-leak-guard.test.ts`; e2e `tests/e2e/test-agent-leak-guard-lifecycle.test.ts`.
