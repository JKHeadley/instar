# Side-Effects Review — Local Verify priority release note

**Date:** 2026-10-27
**Author:** Echo
**Second-pass reviewer:** not required for documentation-only follow-up

## Summary of the change

This review covers the release fragment `upgrades/next/local-verify-suite-priority.md`, added after the runtime side-effects review in `upgrades/side-effects/local-verify-suite-priority.md`. The fragment describes the same reviewed implementation and its rollout limits. It changes no runtime decision point.

## Decision-point inventory

No decision point is added, modified, or removed by this documentation change.

## 1. Over-block

No block/allow surface — over-block is not applicable.

## 2. Under-block

No block/allow surface — under-block is not applicable. The note states the mixed-version worktree limitation and that ordinary suites can reach the existing 45-minute wait budget under a sustained merge backlog.

## 3. Level-of-abstraction fit

The release fragment communicates the already reviewed host-semaphore policy to operators. The runtime implementation and its authoritative state remain in the semaphore and Local Verify service.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md). No blocker, detector, or authority is introduced by this documentation change.

## 4b. Judgment-point check

No new static heuristic or competing-signals judgment point.

## 5. Interactions

The fragment is consumed by the release guide assembler. It names the additive status field, claim file location, and rollout limits already covered by the runtime review. It does not shadow another check, double-fire an action, race with cleanup, or create a feedback loop.

## 6. External surfaces

The assembled release guide and its user-facing wording change. There is no API write, operator action, credential, persistent runtime state, or URL. The note avoids claiming that integration and E2E checks have passed while their full suite is running.

## 7. Multi-machine posture

Documentation-only. It describes per-host claims and says older worktrees must update; it emits no notice, holds no durable work, and generates no machine-specific link.

## 8. Rollback cost

Delete or revise the fragment in a later release. No data migration or agent state repair is needed.

## Conclusion

The release note accurately summarizes the independently reviewed change and its known limits. Clear to publish once the associated code passes its remaining tests.

## Second-pass review

Not required for this documentation-only follow-up. The runtime change has a concurring independent review in its primary side-effects artifact.

## Class-Closure Declaration

No agent-authored artifact defect or self-triggered controller change in this documentation-only follow-up; not applicable.
