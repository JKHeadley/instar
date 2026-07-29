# Side-Effects Review — Linux memory unparseable fallback

**Version / slug:** `linux-memory-unparseable-fallback`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`parseProcMeminfo()` now throws when `MemTotal` cannot be parsed. The existing
`readSystemMemoryPressure()` catch logs the failure and uses its existing RSS
fallback.

## Decision-point inventory

- Linux memory parseability — modified — total memory is mandatory.
- Platform reader fallback — reused unchanged.
- Pressure classification and session reaping — passed through unchanged.

## 1. Over-block

Valid Linux memory output follows the same formulas. Only content that
previously fabricated a zero denominator enters the existing fallback.

## 2. Under-block

Malformed successful reads no longer bypass fallback. The reader remains
non-throwing at its public boundary.

## 3. Level-of-abstraction fit

The pure parser is the first layer that knows `MemTotal` is absent. The caller
already owns logging and fallback, so the parser signals failure without
duplicating recovery policy.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — memory pressure informs real host-health decisions.

This change replaces an invented normal reading with the author-owned fallback;
it does not add a threshold or new authority path.

## 4b. Judgment-point check

No heuristic changes. Parseability is deterministic and the fallback formula is
unchanged.

## 5. Interactions

- **Shadowing:** the malformed path now reaches the existing catch.
- **Double-fire:** one logged fallback remains the only notice.
- **Races:** synchronous read behavior is unchanged.
- **Feedback loops:** downstream pressure consumers receive an existing reading
  shape.

## 6. External surfaces

Malformed Linux input now logs the existing fallback message and returns the RSS
estimate rather than `pressurePercent: 0, totalGB: 0`.

## 6b. Operator-surface quality

The fallback is explicitly logged with the parser reason, so the estimated
reading is not silently presented as primary telemetry.

## 7. Multi-machine posture

Platform-local by design. Other machines and macOS parsing are unchanged.

## 8. Rollback cost

Pure code rollback. No state or schema changes.

## Conclusion

Clear to ship as a bounded parser correction that reuses existing recovery.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; downstream thresholds,
actions, persistence, and lifecycle behavior are unchanged.

## Evidence pointers

- `tests/unit/host-memory-pressure.test.ts`
- `tests/unit/session-reaper-pressure-audit.test.ts`
- Twenty-five focused tests pass.
- Mutation proof: restoring the zero fallback produces two direct failures.
- Full repository lint, including TypeScript, passes.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
