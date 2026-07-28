# Side-Effects Review — Apprenticeship dogfooded-channel enforcement

**Slug:** `apprenticeship-channel-enforcement` · **Date:** `2026-06-04` · **Author:** `echo`
**Second-pass reviewer:** `not required` (additive field + a counting gate; grandfathered)

## Summary

Adds a `channel` field to ApprenticeshipCycleStore records (`telegram-playwright` |
`threadline-backup` | `direct-shortcut` | `unknown`), an idempotent ALTER-TABLE migration
for existing DBs (default `unknown`), and a `roleCoverage` gate: a
`mentor-mentee-differential` cycle on `direct-shortcut` is recorded but does NOT count
toward the keystone axis (surfaced via a new `shortcutDifferentialCount`). Enforces the
§4a dogfooded-channel standard in code.

## Decision-point inventory

One new branch in `roleCoverage`: a mentor-mentee-differential cycle is skipped from axis
tallying iff `channel === 'direct-shortcut'`. Covered both-sides (dogfooded fires; shortcut
doesn't + increments the counter; grandfathered/backup fire).

## 1. Over-block

Rejects nothing. Garbage/unset channels normalize to `unknown`, which COUNTS (grandfathered)
— so it never retroactively un-fires an earned keystone (cycle #4, recorded pre-field, holds).
Only an EXPLICIT `direct-shortcut` is gated, and even then the cycle is still stored + listed.

## 2. Under-block

The mentor tick (#743) records cycles without setting `channel` → they default to `unknown`
→ count. That is intentionally grandfathered for now; aligning the automated tick to set
`direct-shortcut` (or to drive via Playwright, the real fix) is the follow-on once Codey's
Playwright driving capability exists. The gate is per-axis-tally; it does not retro-rewrite
stored rows.

## 3. Level-of-abstraction fit

Right layer: the enforcement lives in the cycle store's `roleCoverage` (the single place the
keystone is computed), reusing the existing axis-tally loop. No route/server change — the
existing `GET /apprenticeship/instances/:id/role-coverage` surfaces the new field for free.
