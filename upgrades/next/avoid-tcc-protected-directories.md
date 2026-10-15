# Agents refuse to live under ~/Documents on macOS (TCC-protected path guard)

## What Changed

- New constitutional standard *Avoid TCC-Protected Directories — No Agent State Under ~/Documents on macOS* (`docs/STANDARDS-REGISTRY.md`): no agent home, project directory, worktree, state directory, vault, database or log may live under `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive on macOS. Operator mandate 2026-10-14 after a TCC grant withdrawal killed two agents in the same second.
- `instar init` (fresh, existing-directory, standalone) now REFUSES a protected target on macOS before writing anything, with the reason, the safe alternatives and the runbook. No override. Linux is unaffected (the check is platform-gated and never fires there).
- At server boot a new always-on guard (`src/core/TccProtectedPathGuard.ts`, manifest row `monitoring.tccProtectedPathGuard`, load-bearing) classifies the project + state directories, prints one loud `TCC-PROTECTED PATH` line when they are inside a protected folder, raises ONE deduped HIGH attention item naming the path and the runbook (JSONL fallback at `<stateDir>/audit/tcc-protected-path.jsonl` without Telegram), and reports on `GET /guards`. It never moves or deletes anything.
- `instar doctor` gains a `Project location` check (fail + runbook pointer when protected).
- Migration parity: `PostUpdateMigrator.migrateTccProtectedPath` re-surfaces the condition in the migration summary on every update until the agent is moved; the CLAUDE.md awareness section (`TCC-protected path guard`) reaches new and existing agents.
- Runbook `docs/runbooks/move-agent-out-of-documents.md`: the operator-proven move (rename on the same disk, symlink at the old path, launchd plist update, reload, verify).

## What to Tell Your User

On a Mac, the Documents, Desktop, Downloads and iCloud Drive folders are guarded by the system's privacy controls, and the system can revoke access to them for every running agent at once — that is what took two agents down on 14 October. From now on I will not set up a new agent inside those folders, and I will tell you clearly (at startup, in the doctor health check, and on each update) if an existing agent still lives there, with a short runbook for moving it. I never move anything myself. Agents on Linux are not affected.

## Summary of New Capabilities

- `instar init` refuses TCC-protected project directories on macOS (absolute; the message names the alternatives and the runbook).
- `GET /guards` → row `monitoring.tccProtectedPathGuard` (always on; `verdictUnknown` if the boot check failed).
- `instar doctor` → `Project location` check.
- Attention item category `tcc-protected-path` (HIGH, one per finding set), JSONL fallback `<stateDir>/audit/tcc-protected-path.jsonl`.
- Runbook `docs/runbooks/move-agent-out-of-documents.md`.

## Evidence

- Incident 2026-10-14 16:00:05 PDT (operator's laptop): 28,382 EPERM denials in 22 minutes after TCC withdrew `~/Documents` from the shared tmux server; agents `inspec` (`~/Documents/Projects/monroe-workspace`) and `instar-codey` (`~/Documents/Projects/instar-codey`) died in the same second; access returned ~16:14; `ai-guy` survived because it had been moved out on 2026-10-13.
- Tests: 31 unit (guard: refusal refuses, Linux untouched, symlink both directions, one aggregated item, 24h JSONL dedupe, guards getter), 6 unit (init exits before writing on all three paths; Linux passes), 6 unit (migrator parity + idempotency + dispatch), 6 integration (`GET /guards` row: on-confirmed / on-blind / missing / Linux), 4 e2e (alive on the real AgentServer boot path; one durable finding for a ~/Documents agent; none on Linux; runbook exists).
- Side-effects review with an independent second pass: `upgrades/side-effects/avoid-tcc-protected-directories.md`.
