<!-- internal-only -->
## What Changed

- **The unit tests run in parallel, and the full suite runs each file once.** `vitest.config.ts` (what `npm test` runs) is now the unit lane alone: `tests/unit/**` and `tests/real-world-state/**`, files in parallel with `maxWorkers` from `tests/setup/lane-workers.ts` (`INSTAR_TEST_WORKERS`, else 8 on a 12+ core host, else half the cores). It used to also include `tests/integration/**` and `tests/e2e/**`, so `npm run test:all` ran every integration and e2e file twice. Integration and e2e keep their own configs and stay one file at a time until their isolation follow-ups (port-reuse race, per-run tmux socket) land. `vitest.e2e.config.ts` now runs `build-dist.globalSetup` (a no-op when dist is current), because the dist-gated e2e files used to rely on the unit config having built dist. First piece of `docs/specs/local-verify-merge-authority.md` (§1).

## Evidence

- `tests/unit/test-lanes-config.test.ts`: the worker-count rule on both sides of 12 cores, the override and its rejection of 0/negative/non-numeric values; the three configs' include sets are disjoint; unit is parallel, integration and e2e sequential; the e2e lane builds dist; `test:all` runs the three lanes in order.
- Full lanes on the Mac Studio (16 cores) with this change: see the PR body for the measured times and counts.
