# Remote Desktop live-reading driver

Tier 1. One new operator script, `scripts/desktop-live-reading.mjs`. Nothing imports it, and nothing runs it automatically. It is a live-proof tool for CMT-033, the measured phone-to-machine reading.

## Decision and operator impact

The driver is adapted from `scripts/desktop-public-browser-smoke.mjs`. It reads the dashboard PIN from stdin, opens `/dashboard/desktop.html?machineId=<id>` in a temporary headless Chrome profile, and measures:
- the time from PIN entry to the first picture;
- the idle picture rate over 10 s;
- the delay from each of 20 single scroll steps to the next picture, alternating down and up so the remote page ends where it began;
- the picture rate and longest gaps during a 3 s scroll burst;
- any status changes, and whether Stop blanked the session.

It prints only numbers and always presses Stop. `--view-only` sends no input. The PIN is never printed or logged.

## Verification and rollback

`node --check` passes. A dry run against a locked M5 reached the Studio viewer and was refused with "Incorrect PIN", because the M5 PIN is not the Studio's. That showed the page address, the sign-in path and the failure output work. Delete the file to roll back.

## Second-pass review

**Reviewer:** not reviewed. It is a standalone operator script with no importer; it goes through review before it is published.

## Class-Closure Declaration

The defect class is claim-vs-evidence: a speed figure must come from pictures the browser drew, timed from the input event's own timestamp.

unbounded-self-action: closure n/a (negative declaration). A one-shot, operator-run measurement that ends with Stop; it is not a self-triggered loop.

## 6b. Operator-surface quality

ELI16: docs/specs/desktop-live-reading.eli16.md.

No user-facing surface changes.
