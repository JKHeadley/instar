---
title: "UpdateGate health lookup must key by tmux session name, not display name"
slug: "update-gate-health-key-fix"
author: "echo"
status: "converged"
review-convergence: "2026-05-31T16:40:00Z"
review-iterations: 1
review-completed-at: "2026-05-31T16:40:00Z"
approved: true
approved-by: "echo"
approved-date: "2026-05-31"
approval-note: "Root-cause bug fix surfaced by live dogfooding (restart-deferral / version-lag). Self-approved under the standing autonomous-dev mandate; flagged in the PR. Independently adversarially reviewed before merge."
eli16-overview: "UPDATE-GATE-HEALTH-KEY-FIX-SPEC.eli16.md"
---

# UpdateGate health lookup must key by tmux session name, not display name

## Problem

`UpdateGate.classifyRunningSessions()` decides which running sessions block an
auto-update restart. It excludes `idle` / `dead` / `unresponsive` sessions so
that an otherwise-idle box can restart promptly (the restart-when-idle behavior,
spec/issue #41). It does this by joining two data sources:

- `sessionManager.listRunningSessions()` → `SessionInfo[]`, where `.name` is the
  **human-facing display name** (e.g. `"Codey Collaboration"`) and `.tmuxSession`
  is the **tmux slug** (e.g. `"echo-codey-collaboration"`).
- `sessionMonitor.getStatus().sessionHealth` → entries keyed by `sessionName`,
  which in production is the **tmux slug** (it is sourced from the
  TelegramAdapter `topicToSession` registry, whose values are the tmux session
  names — verified live in `topic-session-registry.json`).

The join was written as `healthMap.get(session.name)` — display name against a
map keyed by slug. **The lookup always misses.** Every interactive session
therefore falls into the `!h` ("no health data — be conservative, treat as
active") branch and is classified active, regardless of whether it is genuinely
idle. The idle/dead exclusion is effectively **dead code**, so restart-when-idle
(#41) never fires whenever any interactive session exists.

### Observed impact (live, 2026-05-31)

Echo ran stale `v1.3.165` in memory for ~hours while `v1.3.172` sat on disk. The
AutoUpdater deferred the restart with reason `7 active session(s)`. The persisted
`auto-updater.json.restartDeferral.currentBlockers` listed display names
(`"Codey Collaboration"`, `"CPU Load Investigation"`, `"token management"`, …) —
all days-old, genuinely-idle topic sessions — while `topic-session-registry.json`
keyed those same sessions by slug (`"echo-codey-collaboration"`, …). The
mismatch is the root cause of the day-long version-lag and a contributor to the
"too many active sessions / load" signal.

## Fix

In `classifyRunningSessions`, look up session health by `session.tmuxSession`
first (the key the health map actually uses), then fall back to `session.name`:

```ts
const h =
  (session.tmuxSession ? healthMap.get(session.tmuxSession) : undefined) ??
  healthMap.get(session.name);
```

This is a single-point change at the only place the health map is consulted, so
it fixes both `canRestart()` (the real gate) and `getBlockingSessions()` (the
pure idle probe used by the restart-window bypass), which both route through
`classifyRunningSessions`.

## Why this is safe

- It makes the classification **correct**, not more aggressive. A genuinely
  `healthy` session keyed by slug is now correctly seen as healthy and **still
  blocks** the restart — active work remains protected. Only `idle` / `dead`
  sessions become non-blocking, which is the documented intent.
- The `name` fallback preserves backward compatibility with any caller/fixture
  that keys health by display name (the pre-existing unit tests do this).
- The conservative `!h` default is retained for genuinely-untracked sessions.
- No change to the deferral state machine, warnings, or the max-deferral logic.

## Non-goals

- This does not change how sessions are named, nor the SessionMonitor health
  classification thresholds.
- It does not touch the restart-window configuration (that is a separate
  operator setting).

## Tests

`tests/unit/UpdateGate.test.ts` adds a `health key shape — tmuxSession vs display
name (#47)` block using the **real production key shape** (health keyed by slug,
`session.name` a display name):

1. an idle slug-keyed session is **not** blocking (was wrongly blocking pre-fix),
2. `canRestart` **allows** the restart when the only session is idle,
3. a healthy slug-keyed session **still blocks** (active work protected),
4. a dead slug-keyed session is non-blocking,
5. a name-keyed health entry is still found via the fallback (back-compat).

Verified that tests 1, 2, 4 **fail** against the pre-fix lookup and pass with the
fix (no vacuous assertions). All pre-existing UpdateGate + AutoUpdater unit tests
stay green.
