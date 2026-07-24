# Side-Effects Review — Tolerant legacy apprenticeship-cycle reads

**Version / slug:** `cycles-integrity-tolerant-read`
**Date:** `2026-07-15`
**Author:** `Instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

Stored cycle rows use tolerant `kind` normalization on read, mapping unsupported historical values to `unknown`. The strict validator remains the authority for new writes.

## Decision-point inventory

The change separates read compatibility from write admission. It does not add a heuristic gate or new authority.

## 1. Over-block

No legitimate read is newly blocked. New writes retain the existing supported-kind requirement.

## 2. Under-block

Malformed fields other than `kind` retain their existing decoding behavior. This incident and fixture are specifically an out-of-enum historical kind.

## 3. Level-of-abstraction fit

The cycle store is the correct layer because every consumer—list, get, role coverage, and the integrity route—must receive readable historical rows. Fixing only the route would leave other reads crashable.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

Strict write admission remains deterministic authority. The read path reports historical uncertainty as `unknown`; it neither blocks nor fabricates a supported semantic kind.

## 4b. Judgment-point check

No competing-signals judgment is introduced. Membership in the supported enum is an enumerable fact.

## 5. Interactions

Role coverage counts the legacy row in its existing `unknown` bucket. The integrity report continues to compare instance references without rewriting history. The constructor's special `differential-cycle` migration remains compatible.

## 6. External surfaces

Previously failing read APIs return records with `kind: unknown`. No data is changed and no new external operation is introduced.

## 7. Multi-machine posture

Machine-local by existing store design. Each machine tolerantly reads its own historical cycle database; no new replication or generated URL is involved.

## 8. Rollback cost

A hot-fix revert restores strict reads. There is no migration or state repair because the fix performs no writes.

## Conclusion

The change restores the honesty report at the shared decoding boundary while preserving strict creation rules. Clear to ship.

## Second-pass review

Not required: no messaging, session lifecycle, recovery controller, trust, sentinel, guard, or conversational judgment path is touched.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable.
