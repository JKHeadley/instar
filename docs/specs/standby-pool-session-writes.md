---
title: Standby may persist its pool-owned sessions (read-only guard scoped to shared state)
slug: standby-pool-session-writes
status: approved
review-convergence: 2026-05-31T11:15:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h deploy mandate (topic 13481).
  Bug #9 of the multi-machine live-transfer cascade, found running the full live
  "move this to the Mac mini" Telegram test (Justin authorized autonomous live
  testing — feedback_live_transfer_test_autonomous_authorized). Touches the
  standby read-only split-brain guard; scoped narrowly. Flagged in the PR per
  cross-agent discipline.
---

# Standby may persist its pool-owned sessions

## Problem

Found live (2026-05-31): with bug #8 fixed, "move this to the Mac mini" now
forwards correctly — the mini RECEIVES the session and begins spawning it. But the
owner-side resume aborts:

```
[session-pool] owner-side resume failed for topic 8882:
  StateManager is read-only (this machine is on standby). Blocked: saveSession
```

Root: `MultiMachineCoordinator` sets `state.setReadOnly(!holdsLease)` — the
non-lease-holder (the mini) is read-only, so `StateManager.guardWrite` throws on
ALL writes, including `saveSession`. That read-only guard exists to stop a standby
from forking SHARED cluster state (lease, kv, jobs, events). But the active-active
session pool legitimately hands the standby sessions to OWN and serve — and serving
requires persisting their per-session state. The two models collide: one-awake
read-only-standby vs active-active pool standby-owns-sessions.

## Goal

A standby that participates in the session pool can persist the PER-SESSION state of
sessions it owns (so a moved session actually starts there), WITHOUT weakening the
guard that prevents a standby from forking shared cluster state. A pure one-awake
standby (no pool) stays fully read-only — unchanged.

## Non-goals

- Does NOT fix bug #7 (the standby has no Telegram token, so the spawned session
  still can't reply — tracked separately).
- Does NOT let a standby write shared cluster state (`set`/`delete`/`saveJobState`/
  `appendEvent`) — those stay blocked.
- Does NOT remove or weaken the read-only guard for non-pool agents.

## Design

1. **`StateManager` gains `_sessionPoolActive` + `setSessionPoolActive(active)`** and
   a `sessionScoped` option on the private `guardWrite`:
   - `guardWrite(op)` (shared write) → throws when read-only, as before.
   - `guardWrite(op, { sessionScoped: true })` → permitted when read-only ONLY if
     `_sessionPoolActive` is true; otherwise throws.
   Why it's safe: a `sessionScoped` write targets one session's own file
   (`state/sessions/<id>.json`). The session pool's CAS ownership guarantees a single
   owner per session, so an owned-session file write cannot fork shared state. And the
   only code path that calls `saveSession` on a standby is the pool's owner-side resume
   — which itself fires only past the `'dark'` rollout stage and only for a
   CAS-confirmed owned session.

2. **`saveSession` / `removeSession` pass `{ sessionScoped: true }`** (per-session
   lifecycle). All other guarded writes are untouched (shared → still blocked).

3. **`server.ts` calls `state.setSessionPoolActive(true)`** where the SessionRouter is
   wired (this machine is a pool participant). Default stays false → pure one-awake
   agents are byte-identical to today.

## Testing

- Tier 1 (`state-manager-readonly.test.ts`): read-only + pool-active ALLOWS
  saveSession/removeSession (and the file persists); STILL BLOCKS set/delete/
  saveJobState/appendEvent; read-only + pool-INACTIVE blocks saveSession (one-awake
  unchanged); pool-active without read-only leaves all writes working. Existing
  read-only block tests stay green (default pool-inactive).
- 104 StateManager-family + coordinator + wiring tests green; `tsc --noEmit` clean.
- Tier-3: the next live re-test confirms the mini's owner-side resume now persists +
  the session serves (the remaining mute is bug #7).

## Migration parity

Pure code (one flag + a guard option + a wiring call). No config/hook/route/CLAUDE.md
change. Default `false` → existing standbys remain fully read-only until the session
pool is enabled. Existing agents get it on the v-next update.
