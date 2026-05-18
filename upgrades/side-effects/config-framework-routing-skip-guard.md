# Side-effects review — config-framework-routing test skip-guard fix

**Version / slug:** `config-framework-routing-skip-guard`
**Date:** `2026-05-18`
**Author:** Echo
**Second-pass reviewer:** self-review — tests-only; logic correction in skip guard.
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md`.

## Summary

`tests/unit/config-framework-routing.test.ts` used `detectClaudePath() !== ''` as its skip guard. But `detectClaudePath` returns `null` (not `''`) when the binary is missing — `null !== ''` is always `true`, so `claudePresent` was always `true` and the `it.skipIf(!claudePresent)` guards never fired. On CI runners (no `claude` binary), `loadConfig()` threw the prerequisite error and three tests failed.

Fix: guard against both `null` and `''`. The tests now correctly skip on CI when the binary is absent, while still running on dev machines that have it installed.

## Decision-point inventory

- **Skip-guard correction** — `change`. Pure test-helper bug; no production code touched.

## Signal vs authority

CI Unit Tests are structural authority. Fix unblocks the gate.

## Over-block / under-block analysis

**Over-block:** None. The tests still run wherever the binary is present.
**Under-block:** None. The tests already declare "these need at least one framework binary installed"; the skip guards now correctly enforce that.

## Rollback cost

Zero.

## Verification

- Local: `npx vitest run tests/unit/config-framework-routing.test.ts` — 7/7 pass.
- CI: skip-guards will now correctly fire when the binary is absent.
