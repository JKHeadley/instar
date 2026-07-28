# Upgrade Guide — NEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

**SessionReaper — pressure-aware cleanup of idle-but-alive sessions.** A new monitor that reaps sessions sitting idle at a ready prompt (holding memory) — but ONLY when the machine is under memory pressure, and it NEVER reaps a session that might be working. It requires *positive* proof of idleness (turn complete + at a ready prompt + screen byte-static across several checks + no running process + no transcript growth) and KEEPs on any ambiguity. Ships **OFF + dry-run by default** — the only monitor that kills on a heuristic, so it stays dark until an operator validates the dry-run log and opts in. Closes the gap behind the 2026-05-25 fleet pileup (idle sessions accumulated until the machine starved and cross-agent messaging silently failed because agents could no longer spawn).

New read-only endpoint `GET /sessions/reaper` shows the live pressure tier and, per session, the verdict + the exact gate that kept it. `SessionManager` gains a single-writer `terminateSession()` so the existing idle-kill and the reaper can never double-kill. The zombie-kill recovery veto now also defers to the socket + silence sentinels.

## What to Tell Your User

- **Idle sessions get cleaned up under memory pressure — safely.** When your machine fills up with idle agent sessions, this sweeps them so new sessions (and incoming cross-agent messages) don't get refused. It will never reap a session that's actually working. It's off by default; ask me to turn it on after we watch its dry-run log.
- **You won't notice anything unless you enable it.** No behavior change on update.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| SessionReaper (idle-session cleanup under pressure) | `monitoring.sessionReaper.enabled:true` (leave `dryRun:true` first). Off by default. |
| Reaper observability | `GET /sessions/reaper` — pressure tier + per-session verdict + keptBy |
| Single-writer session termination | `SessionManager.terminateSession()` — idle-kill + reaper share one CAS kill path |
