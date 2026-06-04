# Side-Effects Review — Iris-audit session lifecycle (PR A: items 2/3/4)

**Version / slug:** `iris-audit-session-lifecycle`
**Date:** `2026-06-02`
**Author:** `echo`
**Second-pass reviewer:** `3 independent spec reviewers (convergence round) — concur`

## Summary of the change

PR A of the Iris-audit spec (`docs/specs/iris-audit-session-observability.md`),
covering items 2/3/4. Three changes: (a) `claudeCodeBuilder` now pushes `--model
<resolved>` when `frameworkDefaultModels['claude-code']` is set (it was silently
dropped before — only Codex/Gemini builders passed it), and the interactive `Session`
record stores the model actually launched with; (b) a new `POST /sessions/restart-all`
route that bulk-refreshes every running Telegram-bound session through the existing
`SessionRefresh` path (staggered, conversation-preserving); (c) a CLAUDE.md template
section + idempotent `migrateClaudeMd` backfill teaching that hooks/config load at
session start so applying a change requires a restart. Files: `src/core/
frameworkSessionLaunch.ts`, `src/core/SessionManager.ts`, `src/server/routes.ts`,
`src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, plus tests and an
upgrade fragment. Decision points touched: the interactive launch-arg builder
(launch-shape, no block surface), the new restart-all action endpoint (real blast
radius — reuses the existing rate-guarded `SessionRefresh` authority), and an
additive idempotent doc migration.

## Decision-point inventory

- `claudeCodeBuilder` argv (frameworkSessionLaunch.ts) — **modify** — adds `--model`
  when a default is set; pass-through otherwise. No block/allow surface.
- `POST /sessions/restart-all` (routes.ts) — **add** — new action endpoint; delegates
  to the existing `SessionRefresh` (does not add a new blocking authority).
- interactive `Session.model` recording (SessionManager.ts) — **modify** — stores the
  effective launched model; observational, no decision logic.
- `migrateClaudeMd` awareness section (PostUpdateMigrator.ts) — **add** — additive,
  idempotent, content-sniffed text backfill; no decision logic.

## 1. Over-block

No block/allow surface — over-block not applicable. The only gating is the existing
`SessionRefresh` rate-guard (5/10min per session), reused unchanged; restart-all does
not add or alter any allow/deny logic. The Telegram-bound filter is an inclusion
filter (which sessions are eligible), not a rejection of legitimate input.

## 2. Under-block

No block/allow surface — under-block not applicable. restart-all intentionally skips
non-Telegram-bound sessions (Slack/iMessage/headless) — reported transparently in the
`skipped` count, not silently dropped.

## 3. Level-of-abstraction fit

restart-all sits at the right layer: it is a thin HTTP route that orchestrates the
existing, fully-tested `SessionRefresh` orchestrator (which owns kill+respawn,
rate-guarding, in-flight protection, and topic resolution). It does NOT re-implement
any of that — it loops the existing primitive with a stagger. The model-launch change
is at the builder layer where every other framework already applies `--model`. The
awareness change is documentation, delivered via the established `migrateClaudeMd`
mechanism. Nothing is at the wrong layer; no parallel re-implementation of an existing
primitive.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change has no block/allow surface (restart-all reuses the existing
  `SessionRefresh` authority; the model record and the awareness section are signals/
  documentation).

The model field on `GET /sessions` is a pure signal (observability). restart-all
carries the authority to kill+respawn, but that authority already exists in
`SessionRefresh` (used by `/sessions/refresh`); this change does not create a new
brittle authority — it reuses the smart, rate-guarded one. No brittle detector owns
blocking authority here.

## 5. Interactions

- **Shadowing:** restart-all runs N independent single-refreshes; it neither shadows
  nor is shadowed by other `/sessions/*` routes (it only reads the session list and
  calls `SessionRefresh`).
- **Double-fire:** the in-flight guard inside `SessionRefresh` prevents a second
  refresh of the same session firing before the first completes, so restart-all can't
  double-restart a session even if called twice.
- **Races:** the target set is snapshot-time; a session spawned after the snapshot is
  untouched (documented). The reaper interaction is NOT new — restart-all reuses the
  exact shipped `/sessions/refresh` path; a freshly respawned session has current
  activity (not idle-reapable) and the old session is marked `killed`.
- **Feedback loops:** none. restart-all is a one-shot operation; it does not feed a
  system that re-triggers it.

## 6. External surfaces

- **Other agents on the machine:** none — restart-all only acts on THIS agent's own
  sessions (its own `state`/`SessionRefresh`).
- **Install base:** items 2 and 4 reach the fleet via update. Item 2 makes a
  previously-inert config (`frameworkDefaultModels['claude-code']`) active — effect
  appears only on a fresh session, only when the field is set, and is auditable via
  `GET /sessions` (documented "activation safety"). Item 4 appends an idempotent
  CLAUDE.md section.
- **External systems:** Telegram only insofar as restarted sessions resume their
  Telegram-bound conversations via `claude --resume` — same as the existing single
  refresh.
- **Persistent state:** the `Session` record now carries `model` for interactive
  sessions (additive field); no schema migration needed (optional field already on the
  `Session` type). The CLAUDE.md migration appends text idempotently.
- **Timing:** the restart-all stagger (500 + i·750 ms) spreads respawns; no fleet-wide
  concurrency ceiling in v1 (per-session rate-guard is the aggregate backstop; named
  as a known bound in the spec).

## 7. Rollback cost

- **Hot-fix release:** pure code revert shipped as the next patch.
- **Data migration:** none — `Session.model` is an optional field already in the type;
  reverting just stops populating it for interactive sessions.
- **Agent state repair:** none. The CLAUDE.md migration is idempotent and additive;
  reverting the migrator leaves already-patched CLAUDE.md files harmlessly carrying the
  section (no removal needed).
- **User visibility:** no user-visible regression during the rollback window. Item 2's
  effect only manifests on a fresh session; reverting simply returns Claude sessions to
  the CLI account default.

## Conclusion

The review produced no design changes to PR A's code — the changes are additive and
reuse existing authorities. The convergence round refined the SPEC's documentation
(snapshot semantics, fleet bound, reaper-reuse, activation safety, idempotency
pattern). Clear to ship. Item 1 (token accounting) ships as the sibling PR B against
the same spec.

## Second-pass review (if required)

**Reviewer:** 3 independent spec reviewers (design-correctness, safety/blast-radius,
completeness/standards-fit)
**Independent read of the artifact: concur**

All three reviewers' material findings were resolved in-spec; the two "item 1 not
implemented" criticals were a misunderstanding of the intended PR A / PR B phasing
(item 1 is PR B, tracked via `deferrals-tracked`). No structural redesign. See
`docs/specs/reports/iris-audit-session-observability-convergence.md`.

## Evidence pointers

- `tests/unit/frameworkSessionLaunch.test.ts` — `--model` set/unset/tier/raw/with-resume.
- `tests/unit/sessions-restart-all-route.test.ts` — real Express route behavior.
- `tests/unit/PostUpdateMigrator-applyConfigToRunningSessions.test.ts` — migration idempotency.
- `tests/unit/feature-delivery-completeness.test.ts` — template↔migrator parity (green).
- `tsc --noEmit` clean; `pnpm build` clean.
