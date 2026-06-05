# Side-Effects Review — Gate decision-audit verdict finalization

**Version / slug:** `gate-blocked-audit-hygiene`
**Date:** `2026-06-05`
**Author:** `instar-echo`

## Summary

`writeDecisionAudit` writes entries with `verdict: 'pending'` and records `{entryPath, entryData}` in a module variable; a `process.on('exit')` hook (registered next to the variable, ABOVE the gate's top-level flow) rewrites the entry with `verdict: code === 0 ? 'pass' : 'blocked'` and re-stages it. Entry naming, staging, timing, and the riding-the-retry property are unchanged.

## Decision-point inventory

- Entry schema — extended — new `verdict` field ('pending' at write; finalized at exit). Additive: old entries without the field remain valid; no reader migration (the decision-audit-presence CI check matches by path, not schema — verified, its 9 tests untouched and green).
- Exit hook — added — one hook covers every exit path (enforceTier1's exit(0), Tier-2 fall-through, every blockCommit's exit(1)); synchronous-only work; its own try/catch leaves 'pending' on failure (still more truthful than no verdict).
- Source-order placement — the variable AND the hook registration live above the top-level audit call site. Both failure modes fired in development: a below-call-site declaration TDZ-throws inside writeDecisionAudit's try/catch (silently skipping tracking), and a below-flow registration is never reached when blockCommit exits early (verdict stayed 'pending' — caught by the new blocked-path test).

## Direction of failure

- Old failure: rode-along entries from blocked runs (often under 'unknown'/foreign slugs) read as real shipped decisions — twice in one day (echo #836, codey #842).
- New behavior: every entry self-describes its outcome.
- Conservative direction: a finalization failure leaves 'pending' — ambiguous but honest; never a wrong verdict.

## Side-effects checklist

1. **Over-block:** none — the gate's pass/block decisions are untouched; this only records them.
2. **Exit-hook safety:** synchronous fs/execSync only (required in 'exit' handlers); wrapped in try/catch; cannot change the exit code (the 'exit' event can't).
3. **Double-stage:** the entry is git-added at write AND at finalize — idempotent (same path, updated content).
4. **CI interplay:** decision-audit-presence-check matches entries by PATH under .instar/instar-dev-decisions/ — schema-agnostic; its tests run green against the new field.
5. **Level-of-abstraction fit:** the verdict is determined by the process outcome, not by threading state through every blockCommit call site — one mechanism, all paths.
6. **External surfaces:** none — local gate script + committed JSON records.
7. **Rollback cost:** revert; entries return to verdict-less (old shape), already-committed verdict entries remain valid.

## Scope not taken

- No slug-resolution improvement for blocked runs (the verdict defuses the mislabeling harm; resolving the "right" slug for an unmatched trace is guesswork).
- No retroactive verdict backfill of historical entries.
- No blocked-entry relocation/exclusion — riding-the-retry stays (deliberate #827-era design: every evaluation leaves a committed trace).

## Rollback

Revert the commit.
