# Side-Effects Review — Release retry with concurrent fragments

**Version / slug:** `release-concurrent-fragment-retry`
**Date:** 2026-10-31
**Author:** Echo
**Second-pass reviewer:** independent GPT-6 Astra review, no blockers

## Summary of the change

The npm publish workflow tags the published release cut before a main push retry, and both that workflow and the local recovery helper disable Git's directory rename inference during the rebase. This repairs the observed conflict when a concurrent pull request adds a new `upgrades/next/` fragment. The tag remains on the package source while main can include later merged code.

## Decision-point inventory

- Publish workflow retry — modified: only a rejected main push triggers a fetch and rebase; a true conflict still aborts.
- Local keep-tag recovery retry — modified: same directory rename behavior, with existing tag and push checks unchanged.

## 1. Over-block

A genuine same-file conflict still stops the release metadata push. That is intentional; the change does not reject any newly legitimate fragment shape.

## 2. Under-block

A concurrent main merge that changes the same package or guide fields can still require manual reconciliation. An unlanded tag may remain if main refuses the push. The existing recovery command can resume it without republishing.

## 3. Level-of-abstraction fit

The fix is at the Git release retry, where directory rename inference and tag placement occur. It does not change feedback triage or npm publication.

## 4. Signal vs authority compliance

This is a deterministic safety floor on an irreversible release action: only fast-forward pushes advance main, actual conflicts stop, and the tag remains tied to the published cut. It adds no brittle detector with independent blocking authority. See [signal vs authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check (Judgment Within Floors standard)

There is no competing-signals judgment point. Git fast-forward, tag identity, and conflict outcomes are exact invariants. A conflict is surfaced for review rather than guessed away.

## 5. Interactions

The release fragment gate still requires a note; the new retry preserves notes merged after the publish began. The package version resolver still uses main and npm versions. `release-skip-annotate.mjs` uses reachable tags and can overreport after a divergent published tag; it is advisory only.

## 6. External surfaces

GitHub receives the version tag before the main release commit, and npm has already received the package. A failed main push may temporarily leave a tag ahead of main; existing recovery logic detects that state. No user messaging or credentials change.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator interface. The workflow error and recovery command remain the operator surfaces. The tag's published-source meaning is stated in the workflow comment and release notes.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each publish runner uses its own checkout, while GitHub main/tag refs and npm registry are shared authorities. The workflow serializes publish runs and only uses fast-forward pushes; a concurrent PR is safely rebased or stopped.

## 8. Rollback cost

A revert restores prior retry behavior. A version tag already pushed to a published cut must not be moved or deleted as part of rollback; the recovery path can land its metadata separately.

## Conclusion

The narrow retry change preserves published source identity and future release notes. It does not make true Git conflicts disappear. No blocking side effect identified by the independent reviewer.

## Second-pass review (if required)

Independent GPT-6 Astra review found no concrete blocker. It identified a nonblocking reachable-tag advisory limitation and recommended a workflow execution fixture beyond the real-Git helper test. The parity test now asserts the workflow command order.

## Evidence pointers

- Real-Git test: `tests/unit/release-local-steps.test.ts`, concurrent fragment case.
- Workflow order test: `tests/unit/release-local-parity.test.ts`.
- Observed failures: publish runs 41194473300 and 41194824125, both after npm smoke passed.

## Class-Closure Declaration (display-only mirror)

The observed class is a concurrent fragment added while the release consumes earlier fragments. The real-Git regression checks preservation of the later fragment and tag identity; remaining same-file conflicts are explicit holds. No broader class is claimed closed.
