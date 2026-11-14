# Side-Effects Review — the test-runner probe no longer records a zero-length window

**Version / slug:** `probe-window-zero-length`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `not required (test fixture only; no runtime surface)`

## Summary of the change

Tier 1. One test fixture file, 12 lines. No runtime code. No spec review rounds; one commit attempt expected.

`runProbe()` in the test-runner-bound fixture stamped a probe's end the instant its barrier opened. The last probe to start therefore recorded start and end in the same millisecond, the overlap count ignored that empty window, and five concurrent workers measured as 4. The check `(d2) own suite` (PR 3112, mine, 2026-11-12) failed intermittently and decided PR 3053's run on 2026-11-13. Each probe now stays open 150 ms after the barrier opens.

## Decision-point inventory

None in runtime code. In the suite: the checks that read probe windows (`(d)` capped at most 4, `(d2)` more than 4, the cli-proof and pinned variants).

## 1. Over-block

No issue identified: `(d2)` now measures 5 when 5 workers ran together.

## 2. Under-block

Could the dwell let a capped run pass as uncapped, or hide a real cap from `(d2)`? Under a cap of C workers the (C+1)th probe starts only after one of the first C has ended (its worker is free only then), so its start stamp follows that end stamp and the two windows never overlap; the dwell lengthens windows but cannot reorder a start before the end it waited for. The capped checks keep their meaning. If a real cap of 4 applied to the own-suite child, `(d2)` would still measure 4 and fail, as it should.

## 3. Level-of-abstraction fit

The flaw is in how the probe records its window, so the fix is in the probe. Changing `maxOverlap` to count zero-length windows would have made the measurement looser for every check that uses it.

## 4. Signal vs authority compliance

Not applicable: no runtime decision point.

## 4b. Judgment-point check

Not applicable.

## 5. Interactions

Each of the four probe scenarios takes 150 ms longer per probe wave. In the capped scenarios the first four probes wait out their 4-second deadline as before, then dwell.

## 6. External surfaces

None.

## 7. Multi-machine posture

Not applicable: test fixture.

## 8. Rollback cost

Revert the commit.

## Verification

With the fix, `tests/integration/test-runner-bound-meta.test.ts` passes (16 tests, one full run on the Studio). A direct run of the five probes under the fixture config recorded windows of 150, 152, 201, 203 and 205 ms and a measured overlap of 5; before the fix the last probe's window was 0 ms.

## Conclusion

Repairs a measurement artifact in a test I added, which was failing unrelated runs. Ship ahead of ordinary work.
