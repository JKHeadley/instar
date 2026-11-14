# Side-Effects Review — Desktop setup platform CI repair

**Version / slug:** `desktop-setup-platform-ci-repair`
**Date:** 2026-11-02
**Author:** Echo
**Second-pass reviewer:** pr2584_second_pass

## Summary of the change

This PR repairs test and documentation coverage for the guided Remote Desktop setup on Mac, native Linux and Windows. The production implementation is unchanged. The Mac production-boot positive case runs only on macOS, and the macOS CI package job now runs that E2E file after build; a native-Linux production-boot case checks the unsupported state, HTTP 409 and absence of a config write. The Windows packaged transport smoke probe retries only an HTTP 503 connection-unavailable result, at most five times, each with a newly signed nonce. The package-completeness test retries a known temporary identity-helper ENOENT race; the context-map expiry test uses a controlled clock. Two documentation pages restore the required capability coverage after newer mainline routes landed.

## Decision-point inventory

- `.github/workflows/ci.yml` — adds the production-boot E2E file to the macOS package job so the Mac positive assertion runs in CI.
- `tests/e2e/desktop-setup-boot-lifecycle.test.ts` — modifies CI platform selection; verifies the Mac positive path on Mac and the native-Linux refusal path on Linux.
- `tests/e2e/windows-desktop-local-transport-smoke.mjs` — modifies the Windows CI probe's bounded startup retry, not the product transport.
- `tests/unit/package-completeness.test.ts` — modifies a test-only retry predicate for a temporary native helper deletion race.
- `tests/unit/threadline/ContextThreadMap.test.ts` — replaces wall-clock spin with a deterministic fake Date; product expiry logic is unchanged.
- Docs pages — add explanation of shipped desktop and machine-maintenance capabilities; no runtime decision changes.

## 1. Over-block

The Windows smoke still fails if the companion returns a non-503 error, responds at a later phase, or remains unavailable after five attempts. A slow but eventually healthy companion after the fifth attempt will fail CI. That is a bounded test gate, and the Windows package job passed on this exact head. Native WSL is excluded from the native-Linux assertion because WSL has a separate platform capability path; this leaves WSL coverage to its own tests.

## 2. Under-block

The Windows retry might hide a transient startup delay, but each failed attempt must be the specific unavailable response and the final successful attempt must still complete the signed transport request. Fresh nonce and timestamp avoid accidental replay rejection. This smoke does not test the Windows companion replay-rejection path; that path is not established by this PR’s test evidence. The Mac-only skip means Linux CI cannot prove the Mac positive path; the new macOS CI step and local Mac execution cover it. The native-Linux test checks that refusal writes no setup config, reducing the risk of false success. The package retry matches only ENOENT mentioning a temporary capture or identity helper, so unrelated pack failures remain failures.

## 3. Level-of-abstraction fit

The host assertion belongs in production-boot E2E tests because it checks the actual AgentServer platform behavior. Startup tolerance belongs in the Windows packaging smoke rather than production transport: it addresses companion launch timing and cannot alter user traffic. The package helper race and controlled-clock change stay in tests. No new product-level static heuristic is introduced at a competing-signals decision point.

## 4. Signal vs authority compliance

The Windows smoke test retains CI failure authority only for a deterministic transport invariant: an authenticated request must eventually succeed within five bounded attempts, with every other error failing. It does not grant a product decision or weaken a runtime guard. The other changes alter test selection or test timing, and the docs change has no runtime authority. This follows `docs/signal-vs-authority.md` by keeping the CI probe as evidence for the packaging gate while the production platform and transport code remain the authority for actual behavior.

## 5. Interactions

The platform split prevents a native Linux runner from demanding a Mac-only state; the new Linux case checks the legitimate refusal instead. The Windows smoke runs after the companion launches; each retry signs new bytes so the existing replay guard does not reject a duplicate. This smoke does not exercise the replay rejection branch. The package retry can run while desktop-host tests create/delete helper files; it retries only the observed path-specific race. Fake Date is restored in `finally`, so other tests do not inherit its clock. Docs Coverage reads the new architecture and API text but changes no service wiring.

## 6. External surfaces

The user-facing product behavior is unchanged. GitHub CI gains an accurate Linux assertion, a macOS production-boot E2E step, a bounded Windows startup probe, and restored documentation coverage. The API reference now names the watch-only machine-maintenance routes and their dark/unknown states. No user messages, credentials, network destinations or runtime permissions change.

## 7. Multi-machine posture

This repair runs in CI on Mac, native Linux and Windows; it has no durable state to replicate. The test fixtures use temporary local state only. The documented machine-maintenance endpoints explicitly describe machine-local observation and avoid implying a pool-wide result. No one-voice notification path or topic transfer changes.

## 8. Rollback cost

Reverting this PR restores the prior false Linux assertion and fixed one-second Windows wait, so CI may fail on healthy code again. The docs can be reverted without data migration. There is no production state migration or agent state repair.

## Second-pass review

**Reviewer:** pr2584_second_pass

First pass raised two specific concerns: the macOS package job did not run the Mac production-boot E2E, and the artifact overstated replay coverage. The workflow now runs that file on macOS after build, and sections 2 and 5 describe the fresh nonce as avoiding accidental replay rejection rather than testing the replay guard. A second review found an unsupported claim of separate replay-rejection coverage; section 2 now states that this path is unmeasured by this PR. Final independent review concurred after this correction.

**Final verdict:** Concur with the review — reviewer `pr2584_second_pass`. The macOS workflow runs the boot E2E after build, and the artifact accurately limits the Windows replay claim.
