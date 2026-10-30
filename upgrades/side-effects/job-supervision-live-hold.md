# Side-Effects Review — scheduled-result live hold

**Version / slug:** `job-supervision-live-hold`
**Date:** 2026-10-30
**Author:** Echo
**Review tier:** Tier 2

## Summary

The scheduler checks the durable supervision hold on each script admission, including after its initial hold cache was loaded. The change is fail closed on a store read error. It does not enable Jev or a replacement model.

## Decision-point inventory

1. A held slug goes through the existing prior-runner fallback path.
2. A failed hold read calls the existing supervision write-failure path, which blocks the script in memory and reports degradation.
3. The test agent's mocked model replies and synthetic certificate are never used for production work.
4. A second hold check runs after an asynchronous gate, before the script claim. If a hold arrived during the gate, the scheduler restores the old session route and applies its quota and capacity checks.

## Over-block and under-block

An unreadable journal can hold a script until repair; this is deliberate for a safety decision. A hold written on another machine is not visible through this local check. The required pool-authoritative certificate registry is still absent, and the rollout gate remains closed.

## Side effects and rollback

Each admission adds one local SQLite read. The hold is durable and monotone through the existing store. Reverting the scheduler change restores startup-only hold loading; it must not be used as a safety rollback while certificates are active. No state migration or new external call is introduced.

## Evidence

The store unit test covers a revoked certificate and the new hold lookup. The joined lifecycle test covers a post-startup hold in a running scheduler, a hold arriving during an asynchronous gate, provider timeout, late settlement, secret redaction, and zero spawned investigation sessions. `docs/specs/job-result-supervision-v2-joined-test-agent-evidence.md` records the remaining gates.

## Class-Closure Declaration (display-only mirror)

The after-startup local hold gap is closed by the scheduler check and joined test. Pool-wide revocation remains open.

## Second-pass review

The independent reviewer found that a hold could arrive while `triggerJob` awaited a gate, after its first hold read. The scheduler now checks again after the gate and returns to the prior session route under its quota and capacity rules. The joined race test passed in the expanded network-restricted sandbox run.

**Follow-up second pass:** Concur with the review. The post-gate check closes the async wait window before script claim and launch; the fallback repeats quota and capacity checks. Pool-wide revocation remains a separate open gate.
