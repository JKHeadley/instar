# Side-Effects Review — release-local: never-published caveat on --push-only

**Version / slug:** `release-local-never-published-hint`
**Date:** `2026-10-20`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo (her non-blocking notes on #2227; requested on the PR)`

## Summary of the change

`npmPendingNotice(name, version, { pushOnly })` adds two lines for `--push-only`. Absent can mean "never published", and in that case `--push-only` cannot help, so the notice says to re-run release-local normally. The smoke path, which only runs after `npm publish` was accepted, doesn't show the lines. Code comments and one spec bullet record the deliberate asymmetry: `unknown` is pending on the smoke path and `publishUnknown` in `--push-only`.

## Decision-point inventory

No decision changes. Message text and comments only.

---

## 1. Over-block

Not applicable — no block/allow change.

## 2. Under-block

Not applicable — no block/allow change.

## 3. Level-of-abstraction fit

The notice lives in its existing function, with an option.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic.

## 5. Interactions

None. The same stops apply, with an extra line of explanation.

## 6. External surfaces

Maintainer CLI output only.

## 6b. Operator-surface quality

Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN (maintainer tooling), unchanged.

## 8. Rollback cost

Revert the PR. It is text only.

## Conclusion

A clearer message on an existing stop, plus a documented asymmetry.

## Evidence pointers

- `tests/unit/release-local-steps.test.ts` (64): 4 of 4 mutations were caught.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.

## Review note from #2228 (Echo, non-blocking), 2026-10-20

In the `--push-only` notice, the last line now begins "Otherwise (published, still in review):". With the never-published caveat above it, "re-run release-local normally" and "Do NOT publish again" each say which case they are for, so they no longer read as contradictory. The notice on the smoke path has no caveat and is unchanged. Tests: the `--push-only` notice ends with the prefixed line, after the caveat; the smoke notice has no prefix; and the end-to-end `--push-only` refusal prints it. A mutant without the prefix fails 2 tests.
