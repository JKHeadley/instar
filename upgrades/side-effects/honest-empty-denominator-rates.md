# Side-Effects Review — honest empty-denominator rates

**Version / slug:** `honest-empty-denominator-rates`
**Date:** 2026-07-29
**Author:** Instar Agent (instar-codey)

## Summary

`DispatchDecisionJournal.stats()` and `PatternAnalyzer.analyze()` now return
`null`, rather than a fabricated `0`, when their acceptance-rate or
success-rate denominator is empty. Non-empty calculations are unchanged. The
pattern-report formatter branches on the nullable value before doing
arithmetic.

## Decision-point inventory

No decision point changes. These fields are read-only aggregate signals. They
do not gate dispatch, scheduling, proposal generation, or any action. The
change makes the signals distinguish “measured zero” from “not assessable.”

## 1. Over-block

No blocking authority is added or modified. The only compatibility cost is
that readers typed against a guaranteed number must handle `null`; the
repository typecheck identifies such readers, and the sole arithmetic caller
now branches explicitly.

## 2. Under-block

This correction is deliberately bounded to the two remaining sites identified
by the ACT-1243 audit. It does not claim that every rate in the system shares
the same denominator semantics. Both targeted producers now represent empty
evidence honestly, and focused tests pin that behavior. Re-injecting the old
zero fallback made both assertions fail before the correct implementation was
restored.

## 3. Level-of-abstraction fit

The producers own denominator knowledge, so they emit `null` at the source.
Fixing only a formatter would leave API and programmatic consumers exposed to
the fabricated value. The formatter change is a consumer adaptation, not a
second interpretation layer.

## 4. Signal vs authority compliance

Compliant with `docs/signal-vs-authority.md`. These are observational signals
with no blocking authority. The change removes an invented verdict from
missing evidence and preserves all actual measurements.

## 5. Interactions

The dispatch stats object is exported publicly and serialized by existing
callers without arithmetic. The pattern report feeds reflection and
integration analysis; proposal generation depends on detected patterns, not
the summary rate. The CLI is the only arithmetic reader and handles `null`
explicitly.

## 6. External surfaces

Consumers may now see JSON `null` instead of `0` for an empty dispatch or job
history. That is the intended contract correction. Histories with one or more
records produce byte-equivalent numeric values.

## 7. Multi-machine posture

Machine-local by design. Each rate summarizes the journal read by that
machine. No new state, replication path, URL, message, or one-voice concern is
introduced.

## 8. Rollback cost

A direct revert restores the former numeric-only types and fabricated zeros.
There is no data migration or state repair because no stored record changes.

## Conclusion

The change makes two aggregate signals honest at the empty-denominator
boundary without altering authority or non-empty behavior.
