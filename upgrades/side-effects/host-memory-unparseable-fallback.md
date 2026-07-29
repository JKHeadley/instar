# Side-Effects Review — Host-memory unparseable fallback

**Version / slug:** `host-memory-unparseable-fallback`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`parseVmStat()` now rejects a zero total-page count as unparseable.
`readSystemMemoryPressure()` already catches parser errors, logs the failed
native read, and returns its existing RSS-based fallback. The new test enters
the previously uncovered successful-but-unparseable path; the existing
thrown-reader test and fallback implementation are unchanged.

## Decision-point inventory

- `parseVmStat` parse-validity invariant — modified — a non-empty native command
  result must contain at least one total-memory page counter before it can
  become a pressure measurement.
- Memory-pressure policy — passed through — the existing fallback and all
  downstream pressure thresholds remain unchanged.

## 1. Over-block

No user or agent action is blocked. A syntactically unusual `vm_stat` output
that contains none of the five total-memory counters is rejected rather than
graded; that is appropriate because no total-memory denominator can be derived.

## 2. Under-block

The parser can still accept partially populated output when at least one
total-memory counter is present. That preserves its existing tolerant parsing
contract. This change does not claim to validate the semantic relationship
between every page category; it closes the specific state where no measurement
exists at all.

## 3. Level-of-abstraction fit

The validity check belongs in the pure parser, immediately after the denominator
is assembled. The reader already owns fallback selection, logging, and
never-throw behavior. Reusing that path avoids a second fallback policy and
keeps consumers unaware of parser details.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The zero-page check is a hard structural invariant: pressure cannot be computed
without total pages. It does not decide whether an operation may proceed.
Downstream pressure policy continues to consume the resulting measurement.

## 4b. Judgment-point check

No competing-signals judgment point or new policy heuristic is added. A
zero-denominator parse cannot yield a measurement.

## 5. Interactions

- **Shadowing:** the new parser rejection feeds the existing catch-and-fallback
  path; it does not bypass or duplicate it.
- **Double-fire:** only one reading is returned. The rejected native parse does
  not also publish a zero reading.
- **Races:** all reads remain synchronous and local; shared state is unchanged.
- **Feedback loops:** downstream reaping and revival continue to see the same
  fallback shape already used when the native command throws.

## 6. External surfaces

On malformed non-empty macOS output, logs now name the parse failure and the
returned reading comes from the RSS fallback. Valid macOS output, Linux input,
other platforms, external services, persistent state, and message formats are
unchanged. No operator-facing action is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local by design.** Memory pressure is a physical property of each
host and must differ across machines. The correction emits no user notice,
stores no durable or topic-bound state, and generates no URL.

## 8. Rollback cost

Pure code rollback: remove the zero-page rejection and restore the guarded
division. No data migration or agent repair is required. Rollback would
reintroduce the false-healthy reading for malformed native output.

## Conclusion

Clear to ship as a small corrective PR. The change reuses the existing visible,
never-throw fallback and leaves its already-correct thrown-reader path intact.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; the implementation changes
only parser validity and routes through an existing tested fallback. It does not
modify a lifecycle controller, authority, threshold, or action.

## Evidence pointers

- `tests/unit/host-memory-pressure.test.ts`
- Fourteen focused tests pass.
- Mutation proof: removing the validity check makes the parser fail to throw and
  makes the reader return zero instead of the asserted 93.75-percent fallback.
- Full repository lint, including TypeScript, passes.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
