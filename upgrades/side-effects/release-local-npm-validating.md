# Side-Effects Review — release-local: npm "Validating" review is PENDING

**Version / slug:** `release-local-npm-validating`
**Date:** `2026-10-20`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo (requested on the PR)`

## Summary of the change

From the first real local release (1.3.1360): npm accepted the publish but held the version in "Validating" for 40+ minutes, so the registry returned 404 and the 15-minute smoke window expired. Changes:
- `scripts/lib/release-local-steps.mjs` gains `npmPendingNotice()` and `smokeFailureVerdict()`.
- `scripts/release-local.mjs` judges a smoke failure by one registry read: not visible means PENDING (with the notice), visible means a real smoke failure. The `--push-only` npm checks report "absent" as PENDING with the same notice instead of "Nothing was published".
- `fail()` gets an `npmPending` branch that prints the `--push-only` resume and never restores the tree.
- Spec `docs/specs/local-release.md`, wording only, after approval: a "Validating review" paragraph and an "Open items (dated)" entry for the January 2027 npm 2FA-bypass-token change, whose route choice is Justin's. The ELI16 gains matching paragraphs.

## Decision-point inventory

- **post-publish smoke failure** — modify — the message and the pending flag. It still stops, and it still never re-publishes.
- **`--push-only` npm check** — modify — the message and the pending flag. It still refuses until npm shows the version.

---

## 1. Over-block

No new refusals. The same conditions stop as before; only the explanation and the failure branch differ.

## 2. Under-block

- **Visible-but-broken tarball.** A smoke failure on a version npm DOES show is reported as a real failure and is not called pending.
- **Not visible, for another reason.** A smoke failure on a version that is not visible for some reason other than review (for example npm rejected it after acceptance) is reported as pending. It is still never re-published, and `--push-only` keeps refusing, so the outcome is safe; only the explanation might be wrong.

## 3. Level-of-abstraction fit

The decision is one registry read, and it is a pure function with tests. The smoke script is unchanged.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface of its own; it changes messages on existing stops.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

## 5. Interactions

- The tree is not restored on a pending failure. This matches the existing published path: the version may be on npm.
- `--push-only` lands the release once npm shows the version, exactly as before.

## 6. External surfaces

Maintainer CLI output only.

## 6b. Operator-surface quality

Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN (maintainer tooling run on one workstation), unchanged.

## 8. Rollback cost

Revert the PR. Messages return to "NOT on npm" / "Nothing was published"; behaviour is otherwise identical.

## Conclusion

A message and failure-branch change that keeps every stop, and stops a pending npm review from being read as a failed publish.

## Evidence pointers

- `tests/unit/release-local-steps.test.ts`: the real CLI with a bare remote, pending then landing, plus the pure verdict tests. 6 of 6 mutations were caught.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
