---
status: approved
parent-principle: "Structure beats Willpower"
review-convergence: "operator green-light after plan review, Telegram topic 1052, 2026-06-05T05:12:00Z"
approved: true
approved-by: "Justin via Telegram topic 1052"
approved-at: "2026-06-05T05:12:00Z"
---

# Respawn Build-Context Re-establishment

> **Status:** Approved spec (Tier-2). **Tracks:** the #1 mentor-onboarding hardening item — *"a respawned dev session must deterministically re-establish its fleet-PR build checkout."*
> **Earned from:** the 2026-06-04 server-bounce respawn cascade (a host-load session death + respawn wiped Codey's build context → 6-friction setup slog: wrong repo, stale deps, gate-sha drift, …). Re-grounded 2026-06-05.

## Problem

A dev/build session that is mid-way through building a fleet PR lives in a **git worktree** (e.g. `~/.instar/agents/<agent>/.worktrees/<slug>/`). The agent `cd`s into that worktree *inside its session* (via `instar worktree create` then `cd`, or `git worktree add` directly) and does its build there.

When that session **dies and is respawned** (host-load reap, server bounce, socket drop → bridge respawn), the new session comes back with its build context **wiped**:

- The respawn spawns the tmux session in `this.config.projectDir` (agent-home) — see `SessionManager.spawnInteractiveSession` (`-c this.config.projectDir`). It does **not** restore the worktree the session was building in.
- `claude --resume <uuid>` restores the **conversation**, not the **shell working directory**. The resumed agent has its chat history but its shell is back in agent-home.
- The resumed agent does not know it had an active build checkout, so it flails: rebuilds in the wrong repo, symlinks stale `node_modules`, re-runs the gate against a drifted sha, etc.

This is **in-session shell state** (`cwd`) that no layer persists or restores across respawn.

## Non-goals

- Changing where a session is *first* spawned (`spawnSession` correctly resolves a worktree cwd when `WorktreeManager` + `topicId` are wired). This spec is only about **respawn**.
- Preserving arbitrary in-session shell state (env vars, background jobs). Only the **build checkout** (cwd + the PR/branch it maps to) matters.
- Normal conversational topic sessions whose home *is* agent-home — they must be unaffected.

## Design

### 1. Track each session's working directory (detection)

The general signal — independent of how the worktree was created — is the session's **live pane cwd**. tmux exposes it: `tmux display-message -p -t <session>: '#{pane_current_path}'`.

A lightweight tracker (mirroring `OutputActivityTracker`'s polling cadence) samples each managed session's `pane_current_path` on its existing monitor tick and persists, per session:

```jsonc
// state/session-build-context.json  (keyed by tmux session name)
{
  "instar-codey-chat-with-codey": {
    "spawnCwd": "/Users/justin/Documents/Projects/instar-codey",
    "currentCwd": "/Users/justin/.instar/agents/codey/.worktrees/dashboard-diag",
    "branch": "codey/dashboard-refresh-diagnostics",   // best-effort: `git -C <cwd> branch --show-current`
    "updatedAt": 1780633000000
  }
}
```

`branch` is enrichment only (read on change, never required). The load-bearing field is `currentCwd`.

### 2. Re-establish on respawn (the fix)

When `spawnInteractiveSession` respawns a session for which a persisted build-context exists **and** `currentCwd !== spawnCwd` (the agent had navigated away from home into a build checkout), inject a **CONTINUATION preamble** as the first thing the resumed agent sees:

```
[BUILD-CONTEXT RESTORE] Before this restart you were building in:
  worktree: <currentCwd>
  branch:   <branch>
Your shell is back in <spawnCwd> after the restart — `cd <currentCwd>` before
continuing your build. Do NOT start over in agent-home; your work is in that worktree.
```

**Why a CONTINUATION note, not a tmux `-c <currentCwd>`:** for chat-home dev sessions, agent-home *is* the correct tmux home (the worktree is a sub-location the agent navigates to per-build). Spawning the session directly in the worktree would be wrong for a session that juggles multiple worktrees across its life. The note re-establishes the *agent's* intent deterministically while leaving the session's home correct. (A future option: also `cd` for sessions flagged single-worktree, but the note is the safe universal default.)

### 3. Scope guard

Only sessions that are **dev/build sessions** get the restore note. Gate on: a persisted build-context exists AND `currentCwd` is under a `.worktrees/` path (or differs from `spawnCwd` by more than a trivial subdir). Normal topic sessions that never leave agent-home have `currentCwd === spawnCwd` → no note, zero behavior change. This makes the feature a no-op for the common case.

### 4. Staleness

Persist on change only; treat a context older than `maxAgeMs` (default 6h) as stale and skip the note (the worktree may be long gone). On respawn, verify `fs.existsSync(currentCwd)` before injecting — a removed/merged-and-reaped worktree yields no note (and the agent is correctly back in home).

## Testing (3-tier)

- **Unit:** the cwd-diff/scope-guard logic (home==current → no note; under-`.worktrees` → note; stale → skip; missing dir → skip; branch enrichment best-effort/never throws).
- **Integration:** `POST`/respawn path produces the CONTINUATION preamble for a session with a persisted worktree context, and omits it for a home-only session — full wiring (tracker writes → respawn reads → note injected).
- **E2E:** a spawned session, `cd` into a fixture worktree, kill + respawn → assert the resumed session's first injected text contains `[BUILD-CONTEXT RESTORE]` with the right path; a home-only control session respawns with no note.

## Open design questions (for operator/overseer review before build)

1. **Persist location:** standalone `state/session-build-context.json` sidecar (this spec) vs. extending the `Session` record (types.ts:42). Sidecar keeps the hot `Session` shape unchanged and is crash-safe to write independently — recommended.
2. **Branch/PR enrichment:** is `currentCwd` alone sufficient (agent re-derives branch/PR once it `cd`s back), or do we also surface branch + PR# in the note? Leaning: include branch (cheap, one `git` call), skip PR# (not reliably knowable from cwd).
3. **Migration parity:** new sidecar + new respawn-path behavior — gate behind `developmentAgent` first (dark on fleet, live on echo/codey) per the standard, since it changes respawn output. No `migrateConfig` needed (no config); the tracker + respawn hook ship in code.

## Blast radius

Touches `SessionManager` (respawn path + a tracker hook) — core infrastructure. The scope guard (§3) makes it a strict no-op for non-build sessions, so the risk is bounded to dev/build sessions, which are exactly the ones this helps. Ship dark behind `developmentAgent`, dogfood on echo + codey, then graduate.
