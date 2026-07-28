# Side effects — reaper safe-skip no-auto-disable

## Change

`SessionReaper.performReap()`: a `terminate` refusal that carries a `skipped` reason
(busy/protected/already-gone) is now a normal skip (`reap-skipped` audit) instead of
tripping the `autoDisabled` fail-safe. Auto-disable now fires ONLY on a reasonless
`terminated:false` or a thrown error.

## Behavioral surface

- **What changes**: the reaper no longer disables itself when it declines to kill a busy/
  protected session. It skips that one and continues reaping other matured-idle candidates.
  On a fleet with a perpetually-busy session, the reaper now actually reaps the idle ones
  (previously it self-disabled every boot → 0 reaps).
- **What does NOT change**: candidate selection, every KEEP-guard, the grace window, rate
  limits (maxReapsPerTick/Hour), and the dry-run mode are all unchanged. The fail-safe still
  fires for genuine errors and reasonless refusals.
- **New audit event**: `reap-skipped` (a safe decline). `reap-skipped-auto-disable` now only
  appears for genuinely-unexpected outcomes.

## Migration / compatibility

- Pure in-code logic change in one method. No config, API, route, or state-schema change; no
  migration needed. A deployed agent picks it up on its next server restart/update.

## Risk

Low. The change makes the reaper LESS likely to self-disable (more available to do its
configured job), without widening WHAT it reaps. Worst case is the reaper attempts (and is
safely refused on) a busy session each tick — a harmless audit line, not a kill.

## Tests

`tests/unit/session-reaper.test.ts` (47/47, incl. 3 new) + 44/44 across the 5 sibling reaper
suites. `tsc` clean.
