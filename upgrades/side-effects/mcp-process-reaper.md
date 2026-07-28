# Side-Effects Review — MCP-Process Reaper (Option B)

**Version / slug:** `mcp-process-reaper`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `recommended before dryRun:false is set on any agent (it kills processes)`

## Summary of the change

A new `McpProcessReaper` (separate sibling, NOT a change to `OrphanProcessReaper` /
`ReapGuard` / `ReapAuthority`) reaps leaked MCP-server children (playwright-mcp /
mcp-remote / instar-mcp-stdio) whose owning tmux session is dead/stale or fully
orphaned. Ships OFF + dry-run fleet-wide; the `developmentAgent` gate enables it on
echo but leaves `dryRun:true`, so it only observes + audits would-reap. Read-only
report at `GET /processes/mcp-reaper`.

## Decision-point inventory

One decision point: the per-proc keep/reap classifier (`classifyMcpProcess`). It is
pure and unit-tested on both sides of every boundary. The kill action is gated
behind `killsEnabled = enabled && !dryRun`.

## 1. Over-block (what legitimate things could it wrongly KILL?)

The risk is killing an MCP server that a live session still needs. Mitigations,
each unit-tested:
- A proc under a **live/tracked** session is KEPT regardless of age (`session-live`)
  — a long-running autonomous session keeps its old MCP servers.
- A proc under an **external (non-instar)** tmux session is KEPT (`external-session`)
  — the reaper never touches the user's own processes.
- A proc **younger than `minAgeMs` (2h)** is KEPT — a starting session's children are
  never candidates.
- A **failed evaluation** KEEPS (never reap on error).
- Only **three exact signatures** match — never a broad node/npm match.
- Ships **dark + dry-run**; even on the dev agent it only observes. Kills require an
  explicit `dryRun:false`.
- `maxReapsPerPass` (25) bounds the blast radius per pass.

## 2. Under-block (what leaks does it still MISS?)

- It does not prevent NEW leaks — that is Option A (tree-kill on session teardown),
  noted as a follow-up. B is the backstop that cleans existing + future unclean deaths.
- A leaked MCP proc whose dead session's tmux pane somehow still lingers AND is not
  recognized as an instar session would be treated as external (KEPT). This is the
  safe failure direction (favor false-negatives).
- Non-MCP leaked processes are out of scope by design (precise allow-list).

## 3. Reversibility

SIGTERM on an already-orphaned helper is low-risk (its session is gone). The reaper
itself is fully reversible via config (`enabled:false`). No persistent state is
mutated except the append-only audit log.

## 4. Blast radius on the existing reaper

**Zero.** This is a separate class; the shared `OrphanProcessReaper` / `ReapGuard` /
`ReapAuthority` / session-reap authority path is untouched (the same Option-B
isolation used for #722).
