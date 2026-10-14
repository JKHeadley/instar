# Claude sessions launch from a retained per-version copy of the executable

## What Changed

- Every `claude-code` session (headless, interactive, triage) now launches from `<agent>/.instar/state/claude-bin/<version>/claude`, a one-time copy of the real Claude Code executable made at the first spawn of each version (`ClaudeBinaryRetainer`, wired through one `SessionManager.resolveLaunchBinary` chokepoint). A Claude Code npm update replaces `claude.exe` in place and leaves every running session on an unlinked executable; on macOS each EndpointSecurity path lookup on it then leaks ~1 KiB of kernel memory (`data.kalloc.1024`). The retained copy keeps its directory entry across updates, so the running session's executable stays linked.
- A retained file is never replaced in place (that would recreate the leak): a new version lands in a new directory, published with an atomic `link()` that refuses to overwrite. Unused old versions are pruned at most hourly, only when not current, idle past a 6 h grace, and mapped by no live process (`lsof` / `/proc`); "cannot tell" keeps.
- Every retainer failure (disk full, unreadable source, odd layout) falls back to launching the configured path with a loud error line and a named `reason`; a wrapper script is launched as-is. The spawn is never refused.
- New read surface `GET /sessions/claude-binary` (enabled, dir, current, lastResolution, lastError, retained[], lastPrune) and `POST /sessions/claude-binary/prune`. Off switch `sessions.retainedClaudeBinary.enabled: false` (plus `dir`, `pruneGraceMs`); the migrator writes the explicit `{ enabled: true }` block into existing configs without overwriting an operator's value, and adds one CLAUDE.md awareness bullet.

## What to Tell Your User

Each time Claude Code updated, every conversation that was already running kept using a program file that no longer existed by name, and on a Mac that slowly ate memory the system never gets back — enough that one machine crashed. From now on each conversation starts from its own saved copy of the Claude program, so an update can't pull the program out from under it. Nothing to set up; a new entry in the agent's status shows which copy is in use. Conversations started before this update still run the old way until they are next restarted.

## Summary of New Capabilities

- `GET /sessions/claude-binary` — which Claude executable sessions launch from, whether the last launch fell back and why, retained versions, last prune.
- `POST /sessions/claude-binary/prune` — run one prune pass now.
- Config `sessions.retainedClaudeBinary` — `enabled` (default true), `dir`, `pruneGraceMs`.

## Evidence

- Diagnosis on the Mac Studio (lane `studio-kmem-leak-1014`, 2026-10-14): `data.kalloc.1024` growing 163.34 MiB/h; 98.85% of 83,051 `vn_getpath failed: 0x2` kernel events in 30 min attributed to seven Claude PIDs whose executables all had link count 0; the same host panicked on 2026-10-06 at 20.13 GiB in that zone.
- Live check 2026-10-14 09:45 PDT: a session launched from the retained copy of 2.1.299 kept `nlink=1` on its executable (full path resolvable in `lsof -p <pid> -d txt`) before and after an in-place replacement of the npm `claude.exe`; an orphaned pre-existing session showed `nlink=0 /claude`. First copy of the 247 MB binary: 119 ms (APFS clone); subsequent resolves 1 ms with `copied:false`.
- Tests: 25 unit (retainer), 7 unit (SessionManager wiring), 5 unit (migration + template), 3 integration (route), 3 e2e (alive on the real AgentServer boot path).
- Side-effects review with an independent second pass: `upgrades/side-effects/retained-claude-executable.md`.
