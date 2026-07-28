# Side-effects review — e2e config's stale skip justification

**Change.** Comment-only, in `vitest.e2e.config.ts`. **No executable change whatsoever** —
`git diff` touches only comment lines; `include`, `globalSetup`, `testTimeout` and
`environment` are byte-identical.

The comment justified not compiling dist by stating that a build "would wake dormant
dist-gated tests (e.g. dev-preflight-cli, which spawns `pnpm` — absent on the CI e2e
runner)". Two things in that are no longer true:

1. **The pnpm obstacle is gone.** PR #1712 made `dev:preflight` resolve its package manager
   (pnpm, else `npm run lint`); it exits 0 under a pnpm-free PATH.
2. **The tests are not dormant.** `vitest.config.ts` includes `tests/e2e/**` *and* wires
   `build-dist.globalSetup` (added by #1709), so all three dist-gated tests run there.
   Verified by executing `cli-unknown-command` under that config: 2 tests, 512ms + 387ms of
   real work, not instant returns.

The comment now states the reason that actually remains — build cost — and records that the
tests are covered elsewhere.

## 1. Over-block / 2. Under-block

Not applicable: nothing is blocked or allowed. No predicate changed.

## 3. Level-of-abstraction fit

Correct. A config comment explaining *why* a globalSetup is absent belongs beside that
globalSetup. Its accuracy is load-bearing precisely because it is the artifact a future
reader consults before deciding whether to add a build step.

## 4. Signal vs authority compliance

No decision point touched. Worth noting the failure mode this repairs is the same class the
run that found it was auditing: **a description that no longer matches what it describes.**
A stale justification is a check on human reasoning whose passing condition (the pnpm
obstacle) has silently stopped holding — it would have talked the next reader out of a
change on grounds that expired.

## 5. Interactions

None. `vitest.config.ts`, `vitest.integration.config.ts` and `vitest.push.config.ts` all
wire `build-dist.globalSetup` and are untouched. The e2e job's runtime behaviour is
byte-identical: it still does not compile dist, and the three dist-gated tests still skip
*there* while running in the unit shards.

## 6. External surfaces

None. Not shipped to agents, not a route, not config an operator sets, no persisted state.

## 7. Multi-machine posture

**Not applicable** — a build-time test config, evaluated per CI job. No runtime surface, no
state, nothing to replicate, proxy, or strand on a topic transfer.

## 8. Rollback cost

Revert the commit. Comment-only; reverting restores an inaccurate comment, which is the
reason not to.

## Verification

- `tsc --noEmit` clean.
- `git diff` confirms only comment lines changed in the file.
- The claims in the new comment are each checked rather than asserted: the pnpm-free run of
  the built CLI exits 0 (from #1712's verification), and `cli-unknown-command` was executed
  under `vitest.config.ts` and observed to run rather than skip.
