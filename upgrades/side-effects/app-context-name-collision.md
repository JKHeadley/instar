# Side-Effects Review — a context file name cannot collide within one millisecond

**Version / slug:** `app-context-name-collision`
**Date:** `2026-11-07`
**Author:** `echo (echo-liveproof-2)`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, one source line. Repairs main: `tests/unit/app-dispatch-engine.test.ts` failed 4 of 4 at bfe143d6d6. #2916 added the exclusive `wx` flag to the context-file write in `src/core/appInboundDispatch.ts`, but the name used only `Date.now()`, so a start and a message in the same millisecond threw EEXIST. The name now carries the same random suffix as the message file beside it. `wx` stays.

## Decision-point inventory

None. This is a file name.

## 1. Over-block

Removes a false failure. Nothing new is refused.

## 2. Under-block

No issue identified. A real collision of name and 8 random characters would still be refused by `wx`.

## 3. Level-of-abstraction fit

Right layer: the name is built where it is written.

## 4. Signal vs authority compliance

No decision authority involved.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added or changed.

## 5. Interactions

The path goes into the injected text as before. Nothing parses the name.

## 6. External surfaces

The file name in the session's instruction gains a suffix. No API change.

## 7. Multi-machine posture

Machine-local by design: a per-session temporary file.

## 8. Rollback cost

Revert and release. No state or config.
