## What Changed

- **The local merge check now runs as a proper line (CMT-980).** A PR waiting for its local test run keeps its place in the queue when `main` moves or when the PR gets a new commit; before, every move sent it to the back of the line (one PR waited 18 hours). Each check starts against `main` as it is at that moment. And a PR whose check passes is handed to the merge watcher right away, with the queue held (at most 30 minutes) until that merge lands or is refused, so the next PR is tested on top of it instead of the watcher finding it at its next ten-minute look.
- Nothing about what may merge changed: the same gates apply (the operator's code-owner review for constitution files, the independent second-pass review for harness-changing records, holds, the lease, safe-merge's own checks, and GitHub's required status).

## What to Tell Your User

Nothing to do. PRs that wait on the local merge check are now merged in the order they arrived, promptly once they pass, and a PR no longer loses its place in line when main moves. If you ask, I can show you the line (which PR is being merged right now and how many have gone through) and I can switch the immediate merging off again without a restart, which puts merges back on the watcher's ten-minute rhythm.

## Summary of New Capabilities

- `GET /local-verify` → `mergeLine { wired, hold, handoffs, merged, lastOutcome }`.
- Config: `monitoring.localVerify.mergeLine` (read live; absent = on).
- Watcher: `tick({ handoff: { pr, head } })` merges exactly that verified PR through every existing gate.

## Evidence

- `tests/unit/localVerify/LocalVerifyService.test.ts` ("merge line (CMT-980)": kept place on a moved base/head, pre-start base refresh, derive at start, hand-off hold, bounded hold, refusal/no-retry, no watcher)
- `tests/unit/green-pr-local-floor.test.ts` ("merge line hand-off": exact target, not-eligible reasons, actions floor, dryRun/latch/lease, in-flight wait without a breaker feed, code-owner wait)
- `tests/unit/localVerify/mergeLineWiring.test.ts` (status gate, unknown head listed first, kill switch)
- `tests/integration/local-verify-routes.test.ts` (merge hold over HTTP), `tests/e2e/local-verify-lifecycle.test.ts` (wired through the production function, alive over HTTP)
