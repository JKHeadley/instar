# Side-Effects Review — UpdateGate health lookup keys by tmux session name

**Version / slug:** `update-gate-health-key-fix`
**Date:** 2026-05-31
**Author:** echo

## Summary of the change

`UpdateGate.classifyRunningSessions()` looked up per-session health with
`healthMap.get(session.name)` (display name) against a map keyed by the tmux
session slug. The lookup always missed → every interactive session hit the
conservative "treat as active" default → the idle/dead exclusion was dead code →
restart-when-idle (#41) never fired. Fix: look up by `session.tmuxSession` first,
fall back to `session.name`.

**Files changed (source):**
- `src/core/UpdateGate.ts` — one lookup expression in `classifyRunningSessions`
  (+ an explanatory comment). No signature, interface, or control-flow change.

**Files changed (tests):**
- `tests/unit/UpdateGate.test.ts` — +1 describe block (5 tests) exercising the
  production key shape (health keyed by slug, `session.name` a display name).

## Blast radius

`classifyRunningSessions` is the single private classifier behind both
`canRestart()` (the restart gate) and `getBlockingSessions()` (the pure idle
probe). Both are consumed only by `AutoUpdater` for restart gating. Nothing else
calls them. So the change's reach is exactly: "which running sessions are deemed
active for the purpose of deferring an auto-update restart."

## Behavior delta

| Scenario | Before | After |
|---|---|---|
| Interactive session, health=`idle` (keyed by slug) | counted **active** (lookup miss → conservative) → blocks restart | correctly **idle** → does not block |
| Interactive session, health=`healthy` (keyed by slug) | counted active (right outcome, wrong reason) | counted active (correct reason) → still blocks |
| Interactive session, health=`dead`/`unresponsive` (slug) | counted active (miss) | correctly excluded / unresponsive |
| Session with genuinely no health entry | conservative active | conservative active (unchanged) |
| Health keyed by display name (legacy/test) | found | still found (fallback) |

Net: idle/dead sessions stop blocking restarts; **active (`healthy`) sessions
still block, so live work is never interrupted.**

## Risks considered

- **False-idle interruption?** No. Only `idle`/`dead` health statuses become
  non-blocking, and those are set by SessionMonitor's own thresholds (15-min
  no-output for `idle`). A session actively producing output is `healthy` and
  still blocks.
- **Name collision (a session's display name equals another's slug)?** The
  fallback only fires when the slug lookup misses; display vs slug formats differ
  (spaces/caps vs hyphenated-prefixed), so a cross-match is implausible and would
  at worst reuse an existing same-status entry.
- **Restarts now happen more often** — that is the intended effect (#41). They
  remain gated by genuinely-active sessions and the operator restart window.

## Migration parity

None required. `src/core/UpdateGate.ts` is shipped library code, not an
agent-installed file (hook, config default, CLAUDE.md template, or skill). It
takes effect for every agent on the normal server restart that activates the new
version. No `PostUpdateMigrator` entry is needed.

## Test evidence

`npx vitest run tests/unit/UpdateGate.test.ts tests/unit/AutoUpdater.test.ts` →
29 passed. The 3 status-discriminating new tests were confirmed RED against the
pre-fix lookup and GREEN with the fix. `npm run lint` clean.
