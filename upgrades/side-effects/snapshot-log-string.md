# Side-Effects Review — browser snapshot failure log as one string

**Version / slug:** snapshot-log-string
**Date:** 2026-11-08
**Author:** Echo
**Second-pass reviewer:** not required

## Summary of the change
Tier 1, 1 runtime line plus two test assertions. #2969 logged the swallowed snapshot error as a details object. The server's console wrapper prints an object argument as `[object Object]`, as seen live on Echo at 2026-11-08T18:28:14Z, so the class and message never reached the log. The line now logs one string: profile, error class and message (cut to 200 characters). Effort: no spec rounds. This repairs a defect I shipped an hour earlier.

## Decision-point inventory
None. Diagnostic text only; the 409 body is unchanged.

## 1. Over-block
No block/allow surface.

## 2. Under-block
No block/allow surface.

## 3. Level-of-abstraction fit
The same catch block; the logger's object handling is not changed here.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. Log text only.

## 4b. Judgment-point check
None.

## 5. Interactions
None. The same fields as before, now readable.

## 6. External surfaces
Server log line format only.

## 7. Multi-machine posture
Machine-local BY DESIGN: each server logs its own route failures.

## 8. Rollback cost
Plain revert.
