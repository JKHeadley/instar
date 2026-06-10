---
title: Reaper active-process relaxation parity
status: implemented
tier: 1
eli16-overview: upgrades/next/reaper-active-process-relaxation-parity.eli16.md
---

# Reaper active-process relaxation parity

## Problem

`SessionReaper` and `SessionManager.terminateSession` (the single ReapAuthority)
both consult the shared `ReapGuard`. The guard returns `keep('active-process')`
for any session with a non-baseline child process (`ReapGuard.ts` line ~160).

`SessionReaper.evaluate()` already RELAXES that veto for a session it has proven
idle, by two independent, already-shipped mechanisms:

- `cpuAwareActiveProcessKeep` — under CPU pressure, a child that exists but is
  CPU-flat (a wedged/idle MCP child) no longer holds the session hostage.
- `reapStaleIdleWithActiveChildren` (default ON) — a session with no user
  message in `staleCommitmentWindowMinutes` (8h) is treated as abandoned, and
  its own idle children (e.g. the standing MCP stack) must not shield it forever.

After relaxing, `evaluate()` still requires the stateful proofs (transcript not
grown, positively-idle pane, frame-static through the grace window) before the
session is `reap-eligible`. The reaper then enters two-phase `reap-pending` and
calls the `terminate` dep.

But `terminateSession` re-runs the shared guard WITHOUT the relaxation, so it
returns `keep('active-process')` again and refuses the reap. The reaper
authorizes a reap the authority then vetoes — every tick, forever.

Observed live (dist v1.3.448): reap-log `skipped:active-process` ×1,532; idle
sessions (8–19h idle) accumulated and over-subscribed the host. Every such
session holds an always-on MCP stack (`@playwright/mcp`, `mcp-remote`,
`threadline mcp-stdio-entry`, fathom), so the un-relaxed guard makes EVERY idle
session permanently unreapable.

## Decision

Plumb the reaper's already-made relaxation through to the authority, rather than
duplicating the relaxation logic in the guard or making `hasActiveProcesses`
MCP-aware (a brittle process-name allowlist that would also change a shared
primitive used by `McpProcessReaper`).

- `SessionManager.terminateSession` gains an opt `bypassActiveProcessKeep`.
  When set AND the guard's blocking reason is `active-process`, that ONE veto is
  lifted — exactly mirroring the existing `bypassRecoveryFlag` handling for
  `recovery-in-flight`. Every other KEEP-guard is re-checked and still vetoes.
- `SessionReaperDeps.terminate` accepts the opt.
- `SessionReaper.performReap` forwards `bypassActiveProcessKeep =
  evaln.cpuTightened || evaln.staleIdleRelaxed` — i.e. true only when THIS reap
  reached `reap-eligible` by relaxing the active-process veto. When the session
  had no active process at all, the flag is false and the bypass is a no-op.
- `server.ts` wires the opt through the `terminate` dep closure.

## Safety

- The bypass is opt-in per call; only the reaper sets it, and only on a reap it
  already relaxed. An arbitrary killer calling `terminate()` without the flag
  still receives the full `active-process` veto.
- The bypass is scoped to the single `active-process` reason. All other guards
  (recent-user-message, open-commitment, active-subagent, protected,
  not-lease-holder, in-flight, CAS) are re-checked fresh by the authority.
- Over-reap is bounded: a session is only reaped after the stateful idle proofs
  clear (no transcript growth, positively-idle pane, frame-static through grace)
  in addition to the relaxation; and any reaped session resumes via
  `claude --resume`, so a wrong reap is recoverable, not data loss.
- Rollback is a plain code revert; behavior can also be disabled via the existing
  `reapStaleIdleWithActiveChildren` / `cpuAwareActiveProcessKeep` flags.

## Tests

- `tests/unit/session-reaper-cpu-aware-keep.test.ts` — the reaper passes
  `bypassActiveProcessKeep:true` when it reaps via the cpuFlat or stale-idle
  relaxation, and `false` when no active process was the blocker.
- `tests/unit/session-manager-terminate.test.ts` — the authority lifts the veto
  with the flag, refuses without it, and does NOT lift a different keep-reason
  (recent-user-message still vetoes even with the flag).
- `tests/integration/session-lifecycle-reap-wiring.test.ts` — the real reaper
  and real `terminateSession` agree end-to-end.
- `tests/e2e/session-reaper-lifecycle.test.ts` — lifecycle remains green.
