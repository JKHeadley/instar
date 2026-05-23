---
title: Silently-stopped trio — WorktreeManager clone-default + socket-disconnect detector + active-work-silence sentinel
date: 2026-05-22
author: echo
review-convergence: tactical-hotfix-2026-05-22
approved: true
approved-by: Justin
approved-via: Telegram topic 5447 ("yes! we need these fixes ASAP. please enter autonomous mode and make sure all fixes get deployed" at 2026-05-22 17:08 PDT, in response to the joint diagnosis with the gsd-side echo agent)
eli16-overview: silently-stopped-trio.eli16.md
---

# Spec — Silently-stopped trio

**Date:** 2026-05-22
**Author:** echo
**Status:** in-flight (approved 2026-05-22 in topic 5447)

**Triggering incident:** during today's work on PR #331 (auto-updater↔lifeline coordination), my own session hit a mid-session sandbox EPERM on the worktree's git metadata path. Recovery cost ~20 minutes. The cross-topic diagnosis (gsd-side echo) found two adjacent gaps in the same failure class — "agent silently stopped doing work without anyone noticing" — that were not present in my own diagnosis: no detector for Claude Code's "socket connection closed unexpectedly" message, and no watchdog for "session in registry actively working then went silent" independent of topic binding.

All three are the same shape: an agent stops producing output, the cause goes undetected, no recovery fires, no user-visible alert reaches Justin. We close the whole class in one scope per the no-deferrals rule shipped in PR #331.

## Scope (one PR — A, B, C)

### A — WorktreeManager clone-default for cross-project worktrees

**Files:** `src/core/WorktreeManager.ts`.

`git worktree add` puts the working files at the new path but keeps per-worktree metadata (HEAD, ORIG_HEAD, gitdir) inside the SOURCE repo's `.git/worktrees/<name>/`. Every subsequent git command from the worktree reads that metadata. The Claude Code sandbox can EPERM-block paths under `/Users/justin/Documents/Projects/` mid-session — verified today — and the moment it does, the worktree dies.

**Change.** When `createBinding` (or the equivalent factory) is asked to make a worktree for a project whose directory is outside `~/.instar/`, instead of `git worktree add` use `git clone <projectDir> <worktreePath>` followed by `git checkout -b <branch>`. The resulting checkout is a self-contained repo: its own `.git/` directory under agent home, no shared-path dependency. The sandbox can revoke the source path and the clone keeps working.

The clone path matches the existing convention `~/.instar/agents/<self>/.worktrees/<dirName>/`. Branch creation, fast-copy of `node_modules`, fencing-token binding signing, and all other surrounding behavior remain identical — only the underlying git mechanism changes.

**Migration of existing worktrees.** A new `migrateBindingToClone(binding)` helper:
1. Read the existing worktree's HEAD / branch / commit.
2. `git clone <projectDir> <new-path>` adjacent to the old path.
3. Checkout the same branch + commit; `rsync` uncommitted-but-tracked diffs from the old worktree into the clone (`git diff` + apply).
4. Update the binding's `worktreePath` to point at the clone.
5. Leave the old worktree on disk for one update cycle (operator can `git worktree prune` later). Don't auto-delete — too dangerous.

PostUpdateMigrator entry runs this for every active binding whose worktree path exists AND whose `.git` is a file pointer (the worktree shape) rather than a directory (the clone shape). Idempotent.

### B — SocketDisconnectSentinel

**Files:** `src/monitoring/SocketDisconnectSentinel.ts` (new) + `src/commands/server.ts` (wire-up).

Today the repo has detectors for rate limits, quota, API errors, hundreds of patterns. Zero detectors for Claude Code's own `socket connection closed unexpectedly` message. When that fires, the session freezes and nothing surfaces it.

**Detector.** Mirror `RateLimitSentinel`'s shape:
- Scans tmux output of each tracked session every N seconds (default 15s).
- Pattern: `/socket connection closed unexpectedly|ECONNRESET.*claude-code|websocket.*reset/i` (broad — false-positives are cheap, false-negatives are the incident).
- On first match: create a per-session `recovery state` row with `attempts: 0`, `detectedAt: now`, `status: 'detecting'`.
- Notify the user via tone-gated `/attention` with `category: degradation` — "[name] lost its connection to Claude Code. Trying to recover; will let you know if it can't." The existing `MessagingToneGate` B12-B14 ruleset applies (no jargon, ends in CTA).

**Recovery.** Same backoff staircase as `RateLimitSentinel` (1m / 5m / 15m / 30m). Each attempt:
1. Press Ctrl+C in the session's tmux pane (interrupt any half-stuck request).
2. Wait 2s.
3. Press Enter to nudge the prompt.
4. Capture output; if a new prompt or response line appears within 60s → status `recovered`, clear state.
5. Otherwise → `attempts++`, wait the next backoff window, retry.

**Escalation.** After 4 attempts fail, status → `escalated`. One final `/attention` POST: "[name] has been disconnected for [X minutes] and 4 recovery attempts didn't work. Want me to dig in?" Same tone-gate path; safe-template fallback.

**Wire-up.** `startServer` instantiates one sentinel per server and starts its tick loop. Stop loop on shutdown. Reset state on `serverUp` event (mirroring how `RateLimitSentinel` integrates).

### C — ActiveWorkSilenceSentinel

**Files:** `src/monitoring/ActiveWorkSilenceSentinel.ts` (new) + `src/commands/server.ts` (wire-up).

The 1h16m black hole on the gsd-style worktree session today slipped through every existing watchdog:
- **SessionWatchdog** requires a long-running child process. The frozen session had no child — just no output.
- **SessionMonitor** only inspects sessions returned by `getActiveTopicSessions()` — worktree sub-spawns aren't registered there.
- **PresenceProxy** wakes on inbound user messages. Justin sent none.

The gap: a session was actively producing output (the registry has a `lastOutputAt` per session), then stopped producing output for an extended time without any of the existing reasons firing. No watchdog covers this exact case.

**Detector.** Iterate all sessions in the SessionRegistry (NOT topic-bound; the registry is the broader surface). For each session that:
- Has `lastOutputAt > 0` (was working at some point), AND
- `now - lastOutputAt > silenceThresholdMs` (default 15 min), AND
- Has no current restart-in-progress or known-paused flag,

emit a `silence` event with the session name + idle duration.

**Recovery.** Try one nudge before escalating:
1. `tmux send-keys -t <session> ''` (empty send-keys; signals the pane and triggers a re-render — sometimes enough to unfreeze).
2. Wait 30s.
3. If `lastOutputAt` has advanced → cleared, log + done.
4. If not → escalate.

**Escalation.** Tone-gated `/attention` POST: "[name] was working and went quiet about [X] minutes ago. I tried a gentle nudge and nothing came back. Want me to dig in?" Same path. Safe-template fallback.

**Wire-up.** Same as the socket sentinel — one instance per server, tick loop on start, reset on activity.

**Important non-interaction with PresenceProxy.** PresenceProxy fires on USER-WAITS-FOR-AGENT; this sentinel fires on AGENT-WAS-WORKING-AND-FROZE. Different signals, different sessions, no overlap.

## Non-goals

- Not changing PresenceProxy, SessionWatchdog, or SessionMonitor. They keep their existing scope.
- Not building cross-session recovery actions (we're only ADDING detection + first-level nudge + escalation). The user decides whether to dig in.
- Not changing the v3 Remediator design. <!-- tracked: topic-3079-v3-remediator -->

## Acceptance criteria

1. **A — WorktreeManager.** Creating a new binding for a project under `/Users/justin/Documents/Projects/` produces a clone (`.git/` directory, not file). Test fixture creates a binding and asserts `fs.lstatSync(path.join(wt, '.git')).isDirectory()`.
2. **A — Migration.** PostUpdateMigrator on a fixture project with an old-style worktree converts it to a clone, preserving the branch + uncommitted changes.
3. **B — Detector.** SocketDisconnectSentinel's tick sees a fixture tmux pane with "socket connection closed unexpectedly" and creates a recovery state row with status `detecting`.
4. **B — Recovery.** Recovery loop sends Ctrl+C + Enter; if output advances, status → `recovered` and state clears.
5. **B — Escalation.** After 4 failed attempts, POST to `/attention` with `category=degradation` and a B12-compliant message ending in "Want me to dig in?".
6. **C — Detector.** ActiveWorkSilenceSentinel sees a session with `lastOutputAt = now - 16min` and emits a `silence` event.
7. **C — Recovery + Escalation.** Empty send-keys nudge; if no advance within 30s, escalate via `/attention` with the same wire-up.
8. **All — tone-gate compliance.** Escalation payloads have no jargon (`pid`, `tmux`, `socket`, `disconnect`, `silence`, `frozen`).
9. **All — agent awareness.** CLAUDE.md template gains a section explaining the new sentinels in plain English so future agents understand what the alerts mean.

## Signal-vs-authority compliance

| Component | Signal or Authority | Reason |
|-----------|---------------------|--------|
| `crossesBreaking` / migration trigger | Mechanic (file shape check) | No judgment. |
| Socket-disconnect regex | Detector | Emits a signal; recovery loop is the consumer. |
| Active-work-silence threshold | Detector | Same. |
| Recovery loop | Bounded primitive | Fixed staircase, fixed attempt count. |
| `/attention` POST | Pass-through to existing authority | All blocking decisions remain in MessagingToneGate. |

No new judgmental gates over message content or agent intent.

## Interactions

- **PR #331 just shipped:** the no-deferrals enforcement applies to this PR. Every "deferred / out of scope / follow-up" mention has either a tracker marker or this commit uses the bootstrap-override escape hatch (only when the rule's vocabulary forces it).
- **WorktreeManager refactor:** existing topic-bindings, fencing tokens, snapshot system all keep their behavior — only the underlying git mechanism changes.
- **SocketDisconnectSentinel + ActiveWorkSilenceSentinel** can both fire on the same session (socket dropped → output stopped). The active-work sentinel waits 15 min; the socket sentinel ticks every 15s. The socket sentinel will almost always fire first. Idempotency-by-id in `/attention` prevents duplicate topics.
- **v3 Remediator** absorbs both sentinels' detection + recovery surfaces when Tier-3 lands. <!-- tracked: topic-3079-v3-remediator -->

## Tests

- Unit: WorktreeManager clone-shape detection + migration helper; sentinel detectors against fixture session outputs; recovery loop state machine; escalation payload shape (B12 jargon scan).
- Integration: end-to-end pipeline for each sentinel — fixture tmux pane + fixture /attention endpoint + assert correct response shape.
- E2E: real server boot with both sentinels registered; assert `/health` reports the sentinels as wired.

## Rollback

All three layers are independently revertable. The WorktreeManager refactor falls back to `git worktree add` cleanly (no schema changes in bindings). The two sentinels are new files; removing them and their wire-up restores PR-#331-state behavior.
