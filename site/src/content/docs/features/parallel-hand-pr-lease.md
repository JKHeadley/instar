---
title: Parallel-Hand PR Lease
description: A per-branch push-ownership lease so two of the agent's own concurrent sessions can't push competing commits to the same branch — closing the merge-thrash failure mode.
---

The agent can run more than one session at once (multi-session autonomy, or an
autonomous run plus the interactive session you're chatting in). When two of those
sessions independently drive the same pull request, they force-push over each other
and each push restarts CI — a merge that should take minutes can take hours (the
2026-06-15 PR #1183 incident).

The **Parallel-Hand PR Lease** prevents that. Before any session runs `git push`, a
PreToolUse Bash hook asks the server whether another *live* session of this agent
already holds that branch's lease. If one does, the second session **stands down**
instead of pushing a competing commit.

## How it works

- **Ownership is keyed on the conversation topic**, not the session id — so a session
  that respawns mid-work (compaction, refresh, revival) still recognizes its own lease
  and never deadlocks against itself.
- One process-wide lock with atomic compare-and-swap takeover (no double-drive), a TTL
  with dead-holder auto-heal, and a 90-minute absolute ceiling so a lease can never
  wedge a branch. A *live* same-machine holder past the ceiling is escalated to the
  operator, not seized (a long rebuild is legitimate work).
- **Fail-open on every uncertainty.** A corrupt state file, an unreachable server, the
  hook itself crashing, or no resolvable branch all *allow* the push. A broken guard
  never blocks real work.
- It coordinates the agent's **own cooperating sessions only**. It is never authority
  over another person or agent, and a human action always wins.

## Status

Ships **dark and dry-run-first**, dev-gated (`monitoring.prHandLease`). In dry-run the
full decision loop runs and audits every would-deny to `logs/pr-lease-decisions.jsonl`,
but no push is ever blocked until a deliberate `dryRun:false`. Single-session agents
are a strict no-op. v1 is machine-local; cross-machine coordination is a tracked
follow-up.
