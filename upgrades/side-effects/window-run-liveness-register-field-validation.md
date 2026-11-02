# Side-Effects Review — window-run-liveness register refuses missing and misnamed fields

**Version / slug:** `window-run-liveness-register-field-validation`
**Date:** `2026-11-01`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

On 2026-11-01 at 05:50 UTC, topic 131439's session called `POST /window-run-liveness/register` with `runId` instead of `autonomousRunId` and without `lifecycleRunId`. The route copied `body.autonomousRunId` (undefined) into the input, and `WindowRunLivenessAuthority.register` checked each id with `RegExp.test(value)`. `RegExp.test` coerces its argument to a string, so `undefined` became `"undefined"` and matched the id pattern. The new binding was then projected onto run `131439/undefined`, which does not exist, so the call failed with `window-run-liveness-projection-failed: autonomous-run-not-found`. The 24h run stayed `preparing`, its Stop hook never held the session, and it sat idle for about 4.5 hours.

The previous window at that time was already terminal and did not block the registration. The 134088 window visible now was registered 18 hours later (2026-11-02 00:09 UTC). The bug report's theory that the projection used the other topic's state was checked against the code and the transcript and is not what happened.

Changes:
- `src/core/WindowRunLivenessAuthority.ts`: `register()` requires each id field to be a real string matching the pattern, and names the field: `window-run-liveness-registration-invalid:<field>`.
- `src/server/routes.ts`: `/window-run-liveness/register` and `/window-run-liveness/work-advance` return 400 for an unknown body key (with a "did you mean" hint for common misnamings such as `runId`, `artifactPath`), a missing field, or a non-numeric topic id. The response lists the allowed fields.
- `src/core/PostUpdateMigrator.ts` (shared with the CLAUDE.md template): one bullet giving the exact five-field register body, plus a content-sniffed migration so existing agents get it.
- Tests: unit (authority), integration (routes), unit (migration).

Tier 1. Files: 3 source, 3 test, plus these artifacts. One spec round was not needed (no spec; Tier 1). Commit attempts: see PR.

## Decision-point inventory

- `register()` input validation: a deterministic schema check on caller-supplied identifiers. Tightened, not new.
- Route body validation: deterministic refusal of unknown/missing keys. New, at the HTTP boundary.

## 1. Over-block

A caller that sent extra harmless keys alongside a correct binding is now refused. No caller in the repository sends extra keys (checked: only sessions call these routes by hand; the cadence executor prompt names `work-advance` without a body). A caller sending `topicId` as a JSON number or a digit string still works; `null` or an empty string is refused, where `null` used to become topic 0. No legitimate input identified beyond that.

## 2. Under-block

A correctly shaped binding with a wrong but well-formed run id (a real typo) still reaches projection and fails with `autonomous-run-not-found`, as before. That failure is already loud (409) and leaves no state behind. The single-window design remains: a second topic cannot register while another topic's window is live. That is the existing documented behavior, not the cause of this incident.

## 3. Level-of-abstraction fit

Both layers: the authority is the owner of binding validity (any caller, including future in-process ones), and the route is where field names exist, so only it can name a misnamed key.

## 4. Signal vs authority compliance

Deterministic schema validation of identifiers is not a judgment call; refusing malformed input is the correct authority for a boundary check. No brittle heuristic gains blocking power over agent behavior.

## 4b. Judgment-point check

Not a competing-signals decision point. No heuristic added.

## 5. Interactions

The predicate-fact refusal (`predicate-facts-are-server-owned`) still runs first. The lock-retry loop is unchanged and only runs after validation. The executor-id correction path is unchanged.

## 6. External surfaces

Error strings change for malformed requests: `registration-invalid` now carries `:<field>`, and new 400 codes `window-run-liveness-unknown-field:*`, `window-run-liveness-missing-field:*`. Callers matching the old exact string are only tests that mock it (unchanged).

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the window-run-liveness authority is Echo-only and its state is per machine; this change only validates input on the machine that receives the request.

## 8. Rollback cost

Revert the commit. No state format change, no migration of stored data. The CLAUDE.md bullet is harmless text if left behind.

## Conclusion

Safe to ship. Fixes the exact failure seen on 2026-11-01 and makes the next misnamed field self-explaining.

## Second-pass review (if required)

(appended below)

**Concur with the review.** The root cause is confirmed: the old `RegExp.test(undefined)` check passed "undefined", and the new loop requires real strings and names the field. No legitimate caller in src, scripts, .claude or the dashboard sends a body to either route, and topic 0, numeric topics and digit-string topics still pass. Validation runs after the predicate-fact refusal and before the lock-retry loop, so a 400 never enters retries. The migration is idempotent for all three cases: no section, old section, line already present. Cosmetic only: on agents that already had the section, the new line lands at the end of the file rather than inside the section, and it still reads on its own.
