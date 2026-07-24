# Side-Effects Review — Restart-safe blocker classification (Step 1)

**Slug:** `restart-safe-blocker-classification`
**Date:** 2026-06-01
**Author:** echo
**Spec:** `docs/specs/restart-safe-blocker-classification-spec.md`
**Origin:** Codey-scoped (mentorship loop, #60) — Step 1 of restart-safe sessions.

## Summary of the change

Observability-only classification of the restart-deferral blocker set into
`restartSafeSessions` vs `hardBlockingSessions`, surfaced through
`UpdateGate.getStatus()` → `AutoUpdater.getStatus()` → `GET /updates/status`.
The restart decision is unchanged.

**Files changed (source):**
- `src/core/UpdateGate.ts`: new optional `restartSafetyResolver?(session)` config
  predicate; `classifyRunningSessions` returns + stores `restartSafeSessions` /
  `hardBlockingSessions` (split of the active/blocking set); `GateResult` and
  `UpdateGateStatus` gain the two fields; `getStatus()` returns them; `reset()`
  clears them. No resolver → all blockers hard, restart-safe empty (identical to
  prior behavior). A throwing resolver fails safe to "hard".
- `src/core/AutoUpdater.ts`: passes a `restartSafetyResolver` to the gate that
  treats a blocker as restart-safe iff its topic has a per-topic autonomous
  state file (`.instar/autonomous/<topicId>.local.md`); maps the two new fields
  into `AutoUpdaterStatus`. Fails safe to `false` on missing topic id / fs error.
- `src/server/routes.ts`: `GET /updates/status` adds `restartSafeSessions` +
  `hardBlockingSessions` to its hand-picked response object.

**Files changed (tests):**
- `tests/unit/UpdateGate.test.ts` — +5 (mixed-blocker split + still-defers;
  all-restart-safe still defers; no-resolver back-compat; throwing-resolver
  fail-safe; reset clears).
- `tests/integration/updates-status-restart-safe-sessions-route.test.ts` — +2
  (route surfaces both fields, populated and empty).

## Blast radius

Pure additive observability. No restart decision changes: the deferral clock,
warning thresholds, and the `alwaysRestartImmediately` short-circuit are
untouched. The active/blocking membership is computed exactly as before; the new
code only *labels* each existing blocker. The only new runtime cost is one
`fs.existsSync` per blocking session during an update check (infrequent),
wrapped in try/catch. No other field altered; the no-`autoUpdater` route path is
unchanged. tsc + linters clean.

## Behavior delta

| Scenario | Before | After |
|---|---|---|
| Deferring, 1 interactive + 1 resumable-autonomous blocker | defers; status lists both as blockers | defers (unchanged); status also splits: autonomous→restartSafe, interactive→hard |
| Deferring, all blockers restart-safe | defers | **still defers** (no behavior change); hardBlockingSessions empty |
| No resolver wired (any non-AutoUpdater caller) | n/a | all blockers hard; restartSafeSessions empty (identical to before) |
| Resolver throws | n/a | blocker treated as hard (fail-safe); gating unchanged |
| `GET /updates/status`, not deferring | no split fields | `restartSafeSessions: []`, `hardBlockingSessions: []` |

## Risks considered

- **Could it restart through a session it shouldn't?** No — this PR never changes
  the restart decision. The classification is read-only. Acting on it is a
  deferred later step. And the resolver fails safe to "hard" on any error, so
  even a buggy check cannot mark a session restart-safe by accident in a way that
  matters (nothing consumes the label to restart yet).
- **`process.cwd()` reliance in the resolver?** The server runs from the agent
  home; the fs check is wrapped in try/catch and returns false on any error, so a
  wrong cwd degrades to "no session is restart-safe" = today's behavior.
- **Leaking sensitive data?** No — the fields are session/topic display names,
  same exposure class as the existing `blockingSessions`.
- **Breaking existing consumers?** No — additive fields; existing fields
  unchanged. `UpdateGateStatus` / `AutoUpdaterStatus` gain required fields, but
  the only constructors of those types are the two `getStatus()` methods (both
  updated); test stubs cast `as any`.

## Migration parity

None — no agent-installed file changes (no hook/config/skill/CLAUDE.md template).
Read-only API fields; existing agents gain them automatically on update.

## Tests / lint

5 new unit tests + 2 new integration tests pass (28 across the touched files);
`npx tsc --noEmit` and `npm run lint` (tsc + destructive/LLM/URL-log/codex-drift)
clean.
