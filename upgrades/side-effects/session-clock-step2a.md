# Side-Effects Review — Session Clock Step 2a (emit-session-clock.sh shared routine + delivery)

**Slug:** `session-clock-step2a`
**Date:** `2026-06-02`
**Author:** `echo`
**Tier:** 2 (driven by the converged + approved `ROBUST-SESSION-TIME-AWARENESS-SPEC.md`)
**Spec:** `docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md` (Component 2 — the shared routine)

## Summary of the change

Ships the **shared time-awareness routine** and its delivery to every agent. Step 1 (merged #683) added the compute + `/session/clock` query surface; this adds the bash routine that formats the SESSION CLOCK line, plus install-everywhere. Its call sites (the two hooks) are the next sequenced step, tracked in #682.

- `src/templates/scripts/emit-session-clock.sh` — the routine (a real template file, like `telegram-reply.sh`/`secret-drop-retrieve.mjs`; NOT an inline TS string, so no escaping risk). Two modes:
  - **render** `<startedISO> <durationSec> <elapsedSec> <remainingSec> <label>` — formats ONE SESSION CLOCK line from values the caller already computed (no re-resolution → can never disagree with the caller's own clock).
  - **query** `<topic> <port> <auth>` — curls `GET /session/clock` and formats the first active session; prints nothing if none / server unreachable.
- `src/core/PostUpdateMigrator.ts` — `migrateScripts` installs it to `.instar/scripts/` always-overwrite (existing agents, mirrors the secret-drop-retrieve.mjs block).
- `src/commands/init.ts` — `installEmitSessionClock` installs it at scaffold time (new agents).

## Decision-point inventory
- install policy: install-if-missing vs always-overwrite → always-overwrite (new, non-user-customizable shared routine; must stay current). Custom forks live elsewhere and are untouched.
- routine value source: render (caller's numbers) vs re-resolve → render uses the caller's already-computed values (no double-resolution; adversarial round-2 fix in the spec).

## 1. Over-correction risk
None — purely additive. The routine is a standalone script; until a hook calls it (the next step, #682), it has zero runtime effect. Installing it changes no behavior.

## 2. Under-correction risk
The routine is shipped + delivered + tested but its call sites (the two hooks) land with #682; that is the sequenced wiring step. The routine is complete and independently testable.

## 3. Level-of-abstraction fit
A single shared routine both call sites will use; render math lives in it, the compute-of-record stays in `SessionClock.compute()` (TS). The bash routine only formats.

## 4. Signal vs Authority
Tier0, signal-only: pure stdout, never blocks, never mutates. Appropriate.

## 5. External surfaces
None new. query mode calls the existing Bearer-gated `/session/clock`. The routine echoes only the already-sanitized `label` the route/caller supplies (never a raw goal).

## 6. Interactions with existing primitives
The `migrateScripts` addition mirrors the secret-drop-retrieve.mjs install exactly (verified: that test suite stays green). No change to existing scripts/hooks.

## 7. Rollback cost
Trivial: remove the script + the two install calls. No state, no data migration.

## Migration parity
- New agents: `installEmitSessionClock` (init.ts).
- Existing agents: `migrateScripts` always-overwrite install on the normal dist update.
- Both verified by tests.

## Tests
- Unit/golden (`emit-session-clock.test.ts`, 7): render formats elapsed/remaining/percent; omits the remaining clause when unbounded; clamps negative elapsed to 0s; minutes/seconds formatting; no-label; query-unreachable → empty exit 0; unknown mode → no-op.
- Migration (`PostUpdateMigrator-emitSessionClock.test.ts`, 3): migrateScripts installs the script, always-overwrite (restores a stale copy, idempotent), mode 0o755.
- Regression: secret-drop migration (13) stays green; `tsc --noEmit` clean.
