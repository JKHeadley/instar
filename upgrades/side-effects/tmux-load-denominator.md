# Side-Effects Review — Degraded-tmux load denominator

**Version / slug:** `tmux-load-denominator`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `Euler`

## Summary of the change

The degraded-tmux load provider now returns `null` when CPU count is unavailable.
The guard pauses corroboration when load is unknown rather than treating it as
zero.

## Decision-point inventory

- Per-core load conversion — modified — a denominator is required.
- Load-gate decision — modified — unknown cannot advance corroboration.
- Attention creation — unchanged and remains signal-only.

## 1. Over-block

The trigger is near-unreachable on ordinary hardware because operating systems
normally report at least one CPU. If it occurs, the watcher waits for a measured
load value. It does not suppress any path with a valid zero or positive ratio.

## 2. Under-block

A missing denominator and a throwing/non-finite provider all pause
corroboration. No unavailable state can be converted into a calm measurement.

## 3. Level-of-abstraction fit

The pure conversion helper owns denominator validity. The guard owns what an
unknown load signal means for its corroboration state.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — the watcher remains signal-only.

The only possible automated output remains one deduplicated Attention item. This
change narrows when that signal may be raised and adds no blocking, refresh, or
termination authority.

## 4b. Judgment-point check

No heuristic threshold changes. Missing denominator is deterministic; the
existing configured load threshold is unchanged.

## 5. Interactions

- **Shadowing:** unknown load pauses the same corroboration counter that high
  measured load pauses.
- **Double-fire:** no new output path.
- **Races:** core count remains cached once at server construction.
- **Feedback loops:** valid load samples retain prior behavior.

## 6. External surfaces

On a host that reports zero CPUs, the watcher no longer raises a degraded-tmux
notice based on a fabricated idle-host reading.

## 6b. Operator-surface quality

The behavior avoids a confident notice whose load premise was not measured.
There is no new operator message.

## 7. Multi-machine posture

The correction is local to each machine's operating-system sample. Machines
with valid CPU counts are unchanged.

## 8. Rollback cost

Pure code rollback. No state, schema, or migration.

## Conclusion

Clear to ship as a bounded consistency correction for a near-unreachable but
genuine fail-open signal path.

## Second-pass review

**Reviewer:** Euler
**Independent read of the artifact:** Concur with the review — null load
correctly pauses corroboration without fabricating an idle measurement; valid
zero remains distinct, and the signal-only authority boundary is unchanged.

## Evidence pointers

- `tests/unit/DegradedTmuxGuard.test.ts`
- `tests/e2e/tmux-resilience-lifecycle.test.ts`
- Mutation proof: returning zero for a missing core count fails both the
  conversion and downstream-decision assertions.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
