# Side-Effects Review — Linux unit test environment fixes

**Version / slug:** `linux-unit-temp-paths`
**Date:** 2026-11-07
**Author:** Echo
**Second-pass reviewer:** independent reviewer, concern addressed below

## Summary of the change

Tier 1, eight source and test files with a small reversible edit; one review round; two interrupted commit attempts for resource isolation and a locked dependency install, followed by a passing commit gate. Tests that need a fixed temp root now use `/tmp`; one memory fixture declares its project root; media replication awaits copy completion; SourceTreeGuard fixtures pin their git root; the idle-backoff test records sleep calls instead of inferring them from host timing; the config-reader test counts byte reads instead of source-poller metadata checks. AgentOwnedMemory stops treating configured `TMPDIR` as proof of a throwaway agent and uses ThrowawayAgentGuard's fixed-root classification.

## Decision-point inventory

- `AgentOwnedMemory.isThrowaway` — modified — uses the already established fixed OS temporary roots for the memory-link safety check.
- ThrowawayAgentGuard and fleet-watchdog decisions — passed through, with corrected test fixtures.
- SourceTreeGuard, idle-backoff, and config-reader decisions — passed through, with tests that observe their intended boundaries directly.

## 1. Over-block

The changed memory check no longer blocks a normal agent simply because `TMPDIR` is under HOME. Agents truly under `/tmp`, `/var/tmp`, `/var/folders`, or `/dev/shm` are blocked from linking to a non-temp login. The old memory check covered `/tmp` and `os.tmpdir()`; `/var/tmp` and `/dev/shm` gain protection when `os.tmpdir()` points elsewhere. No legitimate agent under those fixed scratch roots should be linked into a real login.

## 2. Under-block

A deliberately temporary agent placed under an arbitrary normal home path is not identified by location alone. That is the existing policy; an explicit throwaway record or other guard still applies where available. No new under-block identified.

## 3. Level-of-abstraction fit

AgentOwnedMemory now reuses the shared location classifier instead of maintaining a second, inconsistent interpretation of temporary location. Tests set up the physical location each boundary requires.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md). This is a deterministic filesystem safety invariant using the existing classifier. The change adds no new detector or competing authority; it makes an existing guard consistent with the throwaway guard.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The fixed roots are an existing enumerable location policy.

## 5. Interactions

No shadowing, double-fire, race, or feedback loop identified. The media test waits for the existing asynchronous copy result. The SourceTreeGuard fixture contains its own git root so an ambient `/tmp/.git` cannot redirect it. The idle-backoff test records actual sleep invocations, so host scheduling delay is not interpreted as product sleep. The config-reader test counts byte reads, which the periodic source poller does not perform, and gives its later healthy worker read a 3-second fixture budget while retaining the blocked-read timeout assertion. The memory check retains the same call order and side effects after classification.

## 6. External surfaces

A normal agent using a home-based `TMPDIR` can now link its memory as intended. Fixed-root throwaway agents remain protected. No external API, message, or state migration changes.

## 7. Multi-machine posture

Machine-local by design: each host classifies its own filesystem and creates its own memory symlink. No replicated state or generated URL is involved.

## 8. Rollback cost

A code revert restores the prior rule; no data migration or agent-state repair is needed. The tests do not touch live agent state.

## Second-pass review

Independent reviewer raised a concern that the test's original non-temp path could be under `/tmp` when CI uses a temp checkout. The test now uses a fixed nonexistent non-temp path and asserts the skip reason, so it cannot write into a checkout and cannot pass merely because the config path is absent. The artifact also records the expanded protection for `/var/tmp` and `/dev/shm`. Reviewer conclusion after re-review: **Concur with the review. No remaining concern found.**

Fresh review after the full-run fixture additions: **Concur.** The source-tree tests retain both true and false decisions, the backoff tests assert real `sleep` calls, and the config-reader test still requires timeout recovery, one fresh byte read, one worker, and revision behavior. The 3-second budget applies only to the test fixture; the product default stays 10 seconds.
