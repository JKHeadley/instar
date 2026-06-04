---
title: MCP-Process Reaper (leaked-MCP descendant sweep — Option B)
status: approved
parent-principle: "Structure beats Willpower"
review-convergence: "overseer-designed (Codey task brief, .instar/apprenticeship/codey-task-mcp-leak-reaper.md) + Echo build-review with both-sides safety tests; autonomous Tier-2 under standing preapproval"
approved: true
approved-by: "Justin (18h autonomous task list, 2026-06-04: 'build + ship the MCP-leak reaper (Option B)' + standing preapproval for autonomous dev)"
eli16-overview: MCP-PROCESS-REAPER-SPEC.eli16.md
lessons-engaged:
  - "Structure beats Willpower — sessions should take their children with them, not rely on a human noticing stray procs"
  - "Protected sessions are sacred (Dawn pattern) — never reap a live/tracked session's children"
  - "Dark + dry-run default for any destructive reaper (SessionReaper / AgentWorktreeReaper precedent)"
---

# MCP-Process Reaper — Option B (descendant-aware sweep)

## Problem

A session spawns MCP-server children (Playwright, `mcp-remote`, instar's stdio MCP).
Killing the session's main pid does **not** cascade to those children — they
re-parent (to PID 1 / launchd) or are held by an `npm exec` wrapper and survive
for **days**. The fleet accumulated **~80** such leaked procs, up to 5 days old,
as a persistent load floor (profiling evidence: `autonomy_loop_fix_and_codex_recovery_wip`).
`OrphanProcessReaper` reaps the session-level CLI proc but not its MCP descendants.

This is **Justin's #1 host-load concern** and a real fleet bug. It is the
descendant-leak counterpart to the per-agent CPU hog that #714/#728 addressed.

## Design — Option B (sibling sweep), not a change to the shared reaper

Codey's brief offered Option A (tree-kill on session teardown — fix at source)
and Option B (a descendant-aware sweep — backstop that cleans the existing leak
and catches future unclean deaths). **This spec ships Option B as a separate
`McpProcessReaper`** — NOT a modification of `OrphanProcessReaper` / the shared
`ReapGuard` / `ReapAuthority` path. Rationale: the shared reaper path governs
*session* kills with a lease gate + KEEP-guard; an MCP-descendant sweep has a
different safety model and a different blast radius, so isolating it as a sibling
keeps the working session-reap authority untouched (zero blast radius — the same
Option-B discipline used for #722). Option A (tree-kill at teardown) remains a
worthwhile *source* fix and is noted as a follow-up; B both cleans the existing
~80 and catches future unclean deaths regardless of how the session died.

### Components

- **`mcpProcessSignatures.ts`** — a precise allow-list of exactly three MCP-server
  shapes (`playwright-mcp`, `mcp-remote`, `instar-mcp-stdio`), each a conjunction
  match. Never a broad `node`/`npm` match — an unrelated node process can never be
  a candidate.
- **`McpProcessReaper.ts`** — pure `resolveOwningSession` (walks the ppid chain to
  a tmux pane, cycle-safe + hop-bounded) + pure `classifyMcpProcess` + the reaper
  class (mirrors `AgentWorktreeReaper`: dep-injected, EventEmitter, `start/stop`,
  `reap()`, `snapshot()`).
- **`mcpProcessReaperDeps.ts`** — production signal sources (ps / tmux / SessionManager
  / `process.kill(SIGTERM)` / JSONL audit), kept out of the class so the classifier
  is unit-testable without a real process table.

### Safety model (the #1 review axis)

For each allow-listed MCP proc, resolve its owning tmux session by walking the
ppid chain to a tmux pane pid. Then:

| Owning session | Verdict |
|---|---|
| live / tracked (in `listRunningSessions`) | **KEEP — `session-live`** (sacred, ANY age — a long-running autonomous session legitimately owns old MCP servers) |
| external / non-instar tmux session | **KEEP — `external-session`** (never touch the user's processes) |
| stale/dead *instar* session (in `listKnownTmuxSessions` but not live) + old | **reap — `stale-instar-session`** |
| stale instar session + young | KEEP — `stale-instar-too-young` |
| none (orphaned / re-parented, no tmux ancestor) + old | **reap — `orphaned-no-session`** (the dominant leak shape) |
| orphaned + young | KEEP — `orphan-too-young` |

Age alone is **never** sufficient. A failed evaluation always KEEPS (never reap on
an error). `minAgeMs` defaults to **2h** (the leaked procs are hours-to-days old).

### Rollout (dark + dry-run)

- Config gate `monitoring.mcpProcessReaper = { enabled:false, dryRun:true, minAgeMs:7_200_000, reapIntervalMs:1_800_000, maxReapsPerPass:25, maxAncestorHops:30 }` (via `ConfigDefaults`, `applyDefaults` is add-missing-only ⇒ migration parity automatic).
- **developmentAgent gate**: `enabled` defaults ON for dev agents (echo) — but `dryRun` stays `true`, so a dev agent **observes + audits would-reap without killing**. Fleet-wide it is fully OFF. Kills only ever happen when `dryRun:false` is set explicitly.
- Every decision (`reaped` / `would-reap` / `kept`) is audited to `logs/mcp-reaper-audit.jsonl`.
- Read-only observability at `GET /processes/mcp-reaper` (snapshot: per-proc verdict + owning session + `reapEligible` count + `enabled`/`dryRun`).

## Tests (3 tiers, both sides of every boundary)

- **Unit** (`tests/unit/mcp-process-reaper.test.ts`, 18): signature match/non-match; `resolveOwningSession` (direct pane / ancestor chain / no-ancestor / cycle-safe / hop-cap); `classifyMcpProcess` both sides of every boundary (live→keep at 10 days, external→keep, stale-instar→reap, too-young→keep, orphaned→reap, orphan-young→keep); `reap()` dry-run-classifies-not-kills, enabled-kills-orphan-never-live, `maxReapsPerPass` cap, disabled-kills-nothing, snapshot side-effect-free.
- **Integration** (`tests/integration/mcp-process-reaper-routes.test.ts`): `GET /processes/mcp-reaper` → 503 unwired, 200 snapshot wired.
- **E2E** (`tests/e2e/mcp-process-reaper-lifecycle.test.ts`): the route returns 200 (not 503) through the real `AgentServer` → `RouteContext` plumbing — the feature-is-alive guard.

## Follow-up

- **Option A (source fix):** make the session-teardown kill path tree-kill the
  descendant MCP servers, so new leaks never form. B remains the backstop.
