# Periodic Goal Re-Alignment Phase 1 — Validation Record

## Scope

This artifact validates only Phase 1: verified operator priority intake, durable
candidate/checkpoint/ledger state, dry-run alignment review, and the authenticated
pull surface. It contains no injection, planner write, attention item, blocking
authority, Phase 2 session delivery, Phase 3 canary/audit/planner contract, or
ACT-1386 work.

## Refusal-first evidence

Before `src/monitoring/GoalRealignment.ts` existed, the new unit suite was run against
the unmodified implementation branch. Vitest failed at module loading with:

> Failed to load ../../src/monitoring/GoalRealignment.js

That failure establishes that the acceptance suite did not pass against old source
or merely restate existing behavior. The implementation was added only after this
refusal.

## Required proof cases

| Required case | Pinned evidence |
|---|---|
| Standing priority older than recency window survives | Unit test constructs a 2025 priority, builds a 2026 digest with `recencyDays:7`, and requires the row to remain `open` |
| Quoted/pasted-only priority is not authoritative | Unit test places the directive only in a fenced block, requires no extractor call, `needs-operator-confirmation`, and `authoritative:false` |
| Crash replay produces the same priority ID | Unit test throws immediately after checkpoint persistence, then replays twice; extractor call count remains one, priority IDs match, and exactly one event exists |

## Additional invariant coverage

- Candidate exists as `pending` before an intentionally suspended extractor resolves.
- Exact raw provider output, source cursor, parsed extraction, prompt, and model are
  persisted before event application.
- Explicit supersession closes only its cited target.
- Ambiguous “Ship it” cannot confirm completion; an exact grounded confirmation can.
- Durable priorities are never projection-trimmed; overflow is reported separately.
- UID mismatch, forwarded messages, and legacy unknown-forwarded rows are ineligible.
- SQLite schema-4 databases migrate to schema 5 while preserving forwarded
  provenance.
- `diverged` downgrades to `indeterminate` without valid priority and focus evidence.
- Truncated source history, unresolved extraction candidates, and digest projection
  overflow each persist `indeterminate` at confidence zero without calling the reviewer.
- Identical digest+focus reuses the verdict with zero additional model calls.
- Provider/malformed/no-run/empty-digest outcomes are counter-visible and inject zero.
- History intake through coordinator to dry-run review works end to end, and server
  wiring is independent of Presence Proxy.
- `GET /goal-realignment` is authenticated, dev-gated, bounded, and read-only.
- Both model decisions are registered in the provenance census with identity-only
  content envelopes and bounded `budget:250` volume classes.

## Validation commands and results

| Layer | Result |
|---|---|
| Goal-realignment unit suite | PASS — 19 tests |
| Forwarded-provenance unit suite | PASS — 2 tests |
| Focused feature + structural ratchets | PASS — 152 tests across 15 files |
| Goal-realignment route integration | PASS — 3 tests |
| TypeScript no-emit | PASS |
| Full lint chain | PASS |
| State registry lint | PASS — 100 categories |
| Store retention lint | PASS — 25 retentioned, 75 grandfathered |
| Full unit suite | Pending |
| Full integration suite | Pending |
| Full end-to-end suite | Pending |
| Production build | Pending |

The pending rows are updated to exact counts after the complete repository gates
finish; this artifact is not complete until every row is terminal.

## Design conclusion

The recommended operating shape is hybrid:

- priority intake is event-driven on verified operator messages;
- reviewer eligibility is cadence-backed and also sensitive to semantic input
  changes;
- digest+focus+rubric+completeness content addressing makes unchanged wakes cost zero calls.

Pure ledger-event triggering would miss drift caused by the run focus changing while
operator priorities remain stable. A blind hourly model call would waste spend and
repeat stale judgments. The hybrid keeps the periodic “zoom out” guarantee without
turning the timer into an hourly bill.
