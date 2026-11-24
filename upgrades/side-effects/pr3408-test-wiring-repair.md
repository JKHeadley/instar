# Side-Effects Review — PR 3408 test wiring repair

**Version / slug:** `pr3408-test-wiring-repair`
**Date:** 2026-11-21
**Author:** echo
**Second-pass reviewer:** not required

## Summary of the change

The end-to-end wiring assertion now includes the real `windowAwareSelection` dependency added to the device-limit composition. The framework-literal baseline follows a one-literal decrease in `UsageWallRescue.ts` after the branch updated from main. Only a test assertion and a lint baseline change; no production code or runtime behavior changes.

## Decision-point inventory

The framework-literal lint's checked-in floor decreases from 1121 to 1120. The test wiring assertion changes to match the production dependency list. No runtime decision point changes.

## 1. Over-block

The narrower test assertion could fail if composition changes legitimately without changing the device-limit behavior. It is intentionally a production-wiring check and names the required dependency. The lowered lint floor could reject a future new framework literal that the old baseline allowed; that is the ratchet's intended behavior.

## 2. Under-block

These checks still cannot prove all downstream runtime behavior. The other two cases in `codex-device-limit-lifecycle.test.ts` exercise the live lifecycle, and separate tests cover the window-aware selector.

## 3. Level-of-abstraction fit

The wiring check belongs in the end-to-end test. The baseline belongs to the existing framework-name ratchet. Neither introduces a parallel runtime check.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md). No runtime block or allow surface changes. These are build-time tests and lint checks.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

The end-to-end test reads `server.ts` and the runtime fixture. The ratchet compares the source tree against its baseline. They do not share runtime state, fire notices, or race with recovery paths.

## 6. External surfaces

No external or operator-facing surface changes. No database, message, API, or agent-installed file changes.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated through source control: the same test and lint baseline run on every test machine. There are no user-facing notices, durable runtime state, URLs, or changed status surfaces.

## 8. Rollback cost

Revert this test and baseline commit. No migration or agent state repair is needed.

## Conclusion

The change restores accurate test expectations after the main-branch merge and tightens the existing literal floor. Targeted end-to-end and ratchet tests passed. Clear to ship through Local Verify.

## Second-pass review (if required)

Not required; no runtime decision or agent behavior changed.

## Evidence pointers

- `/tmp/pr3408-e2e-targeted.log`
- `/tmp/pr3408-ratchet.log`
