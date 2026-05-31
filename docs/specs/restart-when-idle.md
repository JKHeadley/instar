---
title: Restart-when-idle — skip the restart-window wait when nothing is active
slug: restart-when-idle
date: 2026-05-31
author: echo
status: approved
review-convergence: internal-plus-adversarial-self-review-2026-05-31
approved: true
approved-by: Justin (Telegram topic 13435, 2026-05-31 08:46Z — "Yes, please proceed. I'll go with your recommendations for all of these")
approval-note: >
  Justin greenlit this from the approved-priorities list (#41 Echo restart-when-idle). It is a
  self-improvement fix: Echo's own restart window (02:00-05:00) was stranding it on a stale
  version all day even with zero active sessions to protect. The fix is contained and additive —
  the existing restart gate is byte-for-byte unchanged.
second-pass-required: false
second-pass-status: n/a-additive-idle-bypass-existing-gate-unchanged-and-regression-tested
eli16-overview: restart-when-idle.eli16.md
---

# Restart-when-idle — skip the restart-window wait when nothing is active

## Background — the version-lag bug, grounded

An agent can configure a `restartWindow` (e.g. `{ start: '02:00', end: '05:00' }`) so that
update-restarts only happen during that window, never interrupting active work. The window is
the right idea — but `AutoUpdater.gatedRestart()` applied it **unconditionally**: when an update
landed outside the window, the restart was deferred to the window start *regardless of whether
any session was active*. So an **idle** agent (no active sessions, nothing to protect) would sit
on a downloaded-but-unapplied update for up to ~24h, running a stale version all day. This is the
observed Echo symptom (#41): the 02:00-05:00 window deferred every restart for the whole day even
with zero active-session blockers.

The window exists to protect **active work**. When there is no active work, an idle restart is
invisible — and in fact the in-window path *already* does an idle silent-restart (the
`hasRunningSessions === false` branch in `gatedRestart`). Deferring an idle restart to the window
buys nothing and costs hours of version lag.

## Design

In `AutoUpdater.gatedRestart()`, at the restart-window gate, probe for active sessions before
deferring:

- If there are **blocking (active) sessions** → defer to the window exactly as before (and now
  record the blocking session names in the deferral record instead of `[]`).
- If the box is **idle** (no active sessions) → fall through to the normal restart path and
  restart now. The session gate immediately below re-checks via `canRestart()` and performs the
  silent restart.

The probe must be **side-effect-free**: `canRestart()` (the existing gate) *mutates* deferral
state when sessions are active (starts the deferral clock, sets warning flags). Calling it at the
window gate would perturb that bookkeeping. So we add a pure read-only method:

```ts
// UpdateGate
getBlockingSessions(sessionManager, sessionMonitor?): string[]
```

It returns the names of active (healthy, non-job) sessions **without** touching deferral state.
To guarantee the probe can never drift from the real gate, both `canRestart()` and
`getBlockingSessions()` share a single private `classifyRunningSessions()` helper (extracted from
`canRestart`'s existing classification loop — the loop itself is unchanged, just relocated).

```ts
if (!bypassWindow && !this.isInRestartWindow()) {
  const blockers = this.sessionManager
    ? this.gate.getBlockingSessions(this.sessionManager, this.sessionMonitor)
    : [];
  if (blockers.length > 0) { /* defer to window as before */ return; }
  // idle → fall through to restart now
}
```

## Safety (adversarial self-review)

- **Could it restart during active work?** Only if `getBlockingSessions()` returned `[]` when it
  shouldn't. It uses the *same* classification as `canRestart()` — asserted identical by a
  no-drift unit test — so it inherits the existing gate's (conservative) judgment. No new
  misclassification path.
- **Race between the window probe and the session gate?** If a session becomes active between the
  window-gate probe and the `canRestart()` call at the session gate (~microseconds later), the
  session gate catches it and defers. The session gate remains the real guard; the window
  idle-bypass only decides whether to wait for the window *first*.
- **Cascade dampener?** Unaffected — the dampener check runs *before* the window gate, so
  fall-through does not bypass it.
- **`canRestart()` behavior?** Byte-for-byte unchanged — the classification loop was extracted
  verbatim into `classifyRunningSessions()`; the cascade-dampener integration tests stay green.
- **No-sessionManager + outside-window edge:** now restarts (was: defer). This matches the
  existing "no session manager wired → silent restart" semantics one block down; in production the
  sessionManager is always wired (server.ts `setSessionDeps`), so this only affects degenerate/test
  setups (tests updated accordingly).

## Migration parity

N/A — this is a **code-only** change (`AutoUpdater.ts` + `UpdateGate.ts`, compiled into `dist`).
It ships in the normal npm release; existing agents receive it on update. No agent-installed file
(hook/skill/config/CLAUDE.md template) changes, so no `PostUpdateMigrator` pass is needed. No new
config key (the behavior is always-on; rollback is reverting the PR).

## Agent Awareness

N/A — internal restart-timing infrastructure. No new API endpoint, proactive trigger, registry
lookup, or building block for the agent to surface, so no CLAUDE.md template update is required.

## Test plan

`#41` is internal restart-gating logic with **no HTTP route**, so the Testing-Integrity tiers map
as: Tier 1 unit covers both decision-boundary sides + the pure-probe invariant; Tier 2/3 (HTTP
integration / "feature alive" e2e) are N/A — there is no route to return 200/503. This mirrors the
existing `restart-window.test.ts` (unit-only).

- Unit (`UpdateGate.test.ts`): `getBlockingSessions` returns [] for no-sessions and idle-job-only;
  returns active names for an active interactive session; classification matches `canRestart`
  exactly (no drift); and is **pure** — after probing active sessions, `getStatus()` shows
  `deferring=false`, `blockingSessions=[]`, warnings unset.
- Unit (`restart-window.test.ts`): outside-window + active session → defers (requestRestart not
  called); outside-window + idle → restarts now (requestRestart called with the version).
- Regression (`AutoUpdater-cascade-dampener.test.ts`): unchanged, green — confirms the
  `canRestart` extraction preserved behavior.
