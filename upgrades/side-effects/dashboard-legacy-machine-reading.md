# Side-Effects Review — Older server's resource reading on the right machine card

**Date:** 2026-11-17
**Author:** Echo
**Independent reviewer:** fresh general-purpose reviewer, no defects; confirmed both new cases fail on the old code.
**Tier:** 1, small reversible display correction.

## Decision-point inventory
Which machine card shows a resource reading. A pooled answer (with a machines list) is still matched by machine name. An older standalone answer (no machines list) measures only the machine that served it, so it now attaches to the self card instead of whichever card shares its display label.

## Over-block and under-block
Before: an older server's reading was dropped when its label did not match the self card, and could appear on a peer that shared the label. After: it shows on the serving machine's card and sheet only; peers show "no resource reading here".

## Level of abstraction
poolUsageOf exposes the legacy reading as `self`; machines.js picks the reading once per card and passes it to the sheet, so card and sheet cannot disagree.

## Signal versus authority and judgment
Display only. No block/allow surface; docs/signal-vs-authority.md applies unchanged.

## Interactions and external surfaces
Web console Machines page only. Pooled readings, restart care and remote desktop blocks unchanged. No API, native app, migration or scaffold-awareness change.

## Multi-machine posture
Corrects attribution when a newer console talks to an older standalone server. No persisted state or replication change.

## Known edge
If an older server's pool listed machines but marked none as self, its legacy reading would now show on no card instead of a name match. Showing nothing is the honest outcome when the serving machine cannot be identified.

## Rollback
Revert the static asset change. No data repair.

## Verification
New DOM cases in console-machines.test.ts for pool on and off, including a peer with the same label. 17 tests in the file passed. Full validation belongs to Local Verify before merge.
