# Side-Effects Review — Surface restartImmediately in GET /updates/status

**Slug:** `updates-status-restart-immediately`
**Date:** 2026-06-01
**Author:** echo
**Spec:** `docs/specs/updates-status-restart-immediately-spec.md` (approved by Justin, Telegram 13435)

## Summary of the change

Closes the #641 observability gap (#59): #641 added `restartImmediately` to
`AutoUpdaterStatus` + `getStatus()` and claimed it was "surfaced in GET
/updates/status", but the route's hand-picked response object omitted it. One
line added so the route echoes `auto.restartImmediately`.

**Files changed (source):**
- `src/server/routes.ts`: inside `router.get('/updates/status')`, the
  `if (ctx.autoUpdater)` `Object.assign(status, {...})` now includes
  `restartImmediately: auto.restartImmediately`. The value already exists on the
  status object (from #641); no other field touched.

**Files changed (tests):**
- `tests/integration/updates-status-restart-immediately-route.test.ts` — +2:
  builds the router with a stub `autoUpdater` and asserts `GET /updates/status`
  returns `restartImmediately` for both `true` and `false` (both sides of the
  boundary; regression pin so it can't be dropped from the pick-list again).

## Blast radius

Pure additive observability. The route gains one boolean field sourced from an
already-computed `getStatus()`. No behavior changes; no other field altered; the
no-`autoUpdater` path is unchanged (field simply absent). tsc + linters clean.

## Behavior delta

| Scenario | Before | After |
|---|---|---|
| `GET /updates/status`, autoUpdater wired, flag on | no field | `restartImmediately: true` |
| `GET /updates/status`, autoUpdater wired, flag off (fleet) | no field | `restartImmediately: false` |
| `GET /updates/status`, no autoUpdater | field absent | field absent (unchanged) |

## Risks considered

- **Leaking sensitive data?** No — it's a boolean config flag, same exposure
  class as the `autoApply` field already returned.
- **Breaking existing consumers?** No — additive field; existing fields unchanged.

## Migration parity

None — no agent-installed file changes (no hook/config/skill/CLAUDE.md template).
Read-only API field; existing agents gain it automatically on update.

## Tests / lint

2 new integration tests pass; `npm run lint` (tsc + destructive/LLM/URL-log/
codex-drift) clean.
