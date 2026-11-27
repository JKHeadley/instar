# Side-Effects Review — Isolate Login Probe Tests

Date:2026-11-23. Author:echo. Tier1, reversible test-only repair. Two test files plus three release/review documents. One independent review, zero spec-convergence rounds. Normal commit hooks remain required.

## Summary of the change

Integration and lifecycle login-probe fixtures now place the real host semaphore inside their temporary home and reset its process singleton between tests. The real stand-in CLI, wrapper, scheduler, pool and recovery remain exercised. A new saturation case keeps conservative swap behavior and proves no probe reservation was persisted. No runtime files change.

## Decision-point inventory

No production decision point added, removed or modified. Existing probe capacity, credential evidence and recovery decisions are exercised unchanged. The fixture supplies its own home for the shared admission resource.

## 1. Over-block

No production block surface. Available fixture capacity allows the existing success case; cap saturation remains a separate explicit negative case.

## 2. Under-block

No production policy weakened. Genuine sign-out still marks and swaps; saturation still produces no authenticated-success claim. The test is not a proof of live-host load behavior.

## 3. Level-of-abstraction fit

Test fixture isolation belongs in setup/cleanup, not in runtime account selection or increased timeouts. A concrete holdersPath assertion verifies the actual singleton rather than substituting a no-op wrapper.

## 4. Signal vs authority compliance

Per docs/signal-vs-authority.md, this test-only change introduces no blocking authority. The real capacity authority and conservative recovery policy retain their behavior.

## 5. Interactions

Each fixture resets the singleton after installing its temporary-home spy, and resets it before restoring mocks and deleting files. The saturation holder releases in finally. Other test files and live agents do not share this temporary file.

## 6. External surfaces

No new API, settings, credentials, transcript writes, messaging or installation behavior. The stand-in CLI replays committed captured output and makes no model request. Full verification is delegated to throughput.

## 7. Multi-machine posture

Test scratch state is ephemeral and isolated per fixture on each verification host; no persistent agent surface is introduced or replicated. Runtime cross-machine behavior is unchanged.

## 8. Rollback cost

Revert the test-only commit. No migration or state repair required.

## Verification and review

Original focused main run:3/3 passed. Controlled occupied cap reproduced the exact two reported assertion failures. Fixed targeted runs:34 unit,4 integration,4 lifecycle passed. Original full-run cause is inferred from the reproduced mechanism, not independently traced in its unavailable log. Complete suite remains throughput-owned before merge.

Independent reviewer stale_login_review concurs after reading final diff and controlled RED log: real semaphore remains used, cleanup order is sound, positive/refused/saturated boundaries are meaningful. No material concern identified. Reviewer ran no tests or source changes.
