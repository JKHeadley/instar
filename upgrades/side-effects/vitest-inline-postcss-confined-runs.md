# Side-Effects Review — inline empty PostCSS config in every Vitest config

**Version / slug:** `vitest-inline-postcss-confined-runs`
**Date:** `2026-10-19`
**Author:** `Echo`
**Second-pass reviewer:** `not required (test-tooling config; no runtime code path)`

## Summary of the change

Adds `css: { postcss: {} }` to `vitest.config.ts`, `vitest.contract.config.ts`, `vitest.e2e.config.ts`, `vitest.integration.config.ts` and `vitest.push.config.ts`. Vite then skips its upward PostCSS config search (lilconfig), which aborts on EPERM instead of continuing past an unreadable `package.json`. Inside the feedback executor's sandbox (`buildSandboxRuntimeSettings`), the agent home is read-denied around the workspace. Where the agent home is an instar checkout, as on Echo, every confined `npx vitest run` died before collecting tests. That failed the canary's must-succeed `base-unit-smoke` probe, which stops each attempt as `profile-unenforceable`.

Reproduced with the server's own dist (`SandboxRuntimeRunner`, `runRunnerCanary`): 27/28 probes passed, and `base-unit-smoke` failed with exit 1 and `EPERM ... open '<agentHome>/package.json'`. With the inline config, the same confined command gives exit 0 and 47/47 tests pass.

## Decision-point inventory

None. Test configuration only.

## 1. Over-block / 2. Under-block

The sandbox policy is untouched: no read is unblocked. The search is skipped, not permitted. No test in the repo uses CSS, so an empty PostCSS config changes no test outcome.

## 3. Level-of-abstraction fit

The fault is Vite's config discovery, so the fix is in Vite's config. Widening the sandbox to allow reading the agent home's `package.json` would loosen a security boundary to work around a tooling quirk.

## 4. Signal vs authority compliance

- [x] No — no decision point.

## 5. Interactions

`withTestRunnerBound` wraps each config unchanged. Measured: the unit, integration and e2e configs still run (triage-floors 47 tests, drain-service integration 17, execute-lifecycle e2e 2).

## 6. External surfaces

Contributors and CI: none visible. The executor's canary can now pass on an agent whose home is an instar checkout.

## 7. Multi-machine posture

Repo config, same on every machine.

## 8. Rollback cost

Revert five lines.

## Conclusion

Clears a deterministic canary failure that would have stopped every executor attempt on this machine. Clear to ship.

## Class-Closure Declaration (display-only mirror)

Not applicable: no self-triggered controller.
