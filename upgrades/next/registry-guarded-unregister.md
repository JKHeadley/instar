---
bump: patch
---

## What Changed

Fixed the shared agent-registry lost-update race: during back-to-back update restarts, an old server generation's late shutdown removed the registry entry by path and deleted the successor's fresh registration, and the heartbeat silently no-oped on the missing entry forever. Server and lifeline shutdowns now pass their own pid and the registry only removes a matching-pid entry; the periodic heartbeat reports a missing entry and re-registers it via a callback. Operator/CLI removal stays unconditional.

## What to Tell Your User

Nothing user-visible day to day — this closes a race where an agent could silently vanish from the machine-wide agent registry after an update restart, which then made registry-dependent tooling (like worktree creation) refuse the agent until the next full restart. Agents now stay registered across rapid restarts, and if a registration is ever lost they re-add themselves within a minute.

## Summary of New Capabilities

- unregisterAgent accepts an onlyIfPid guard; server and lifeline shutdown only remove their own generation's entry.
- heartbeat returns whether the entry was found; startHeartbeat accepts a reRegister callback that resurrects a missing registration (initial beat included).

## Evidence

Live trace (2026-06-05, echo): server log showed "Registered agent \"echo\" on port 4042" at 13:11 AND 13:18 (two restart generations), registry.json had no echo entry at 13:21+ while echo-lifeline remained — and `instar worktree create` refused the agent home with "agent echo is not present in the instar registry". Root: src/commands/server.ts shutdown called unregisterAgent(config.projectDir) unconditionally (removal by path), and AgentRegistry.heartbeat() was an if-found no-op. Pinned by 7 new race-shape unit tests in tests/unit/agent-registry.test.ts (guarded skip vs matching-pid removal vs unguarded back-compat, heartbeat found-flag both sides, resurrect via callback, throwing-callback containment, full register-old/register-new/old-shutdown sequence).
