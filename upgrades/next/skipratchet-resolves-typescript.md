## What Changed

The local-verify classifier's skip/delete ratchet now resolves its TypeScript
parser from the repository under verification before falling back to its own
install location, and the orchestrator passes the run directory in through a new
injectable `loadTs` seam.

The verifier process is loaded from the agent's shadow install — a production
npm install with no devDependencies — so the ratchet's previous
`createRequire(import.meta.url)('typescript')` could not find the parser. The
orchestrator's catch-all then classified the pull request as harness-changing,
which is the correct safe direction for an unreadable check but was firing on a
condition that had nothing to do with the pull request. The parser is resolved
before the ratchet inspects any file, so this fired on EVERY run, not only on
pull requests containing a test-file change: every verified pull request was
routed to the operator for a manual approval.

The repository under verification always has its dependencies installed (its
test lanes had just run), so the parser is found there. If neither location has
it, the error is re-raised and the old catch-all behaviour is unchanged.

## Evidence

- Measured on the 2026-10-23 verify run of PR #2318: that run's log recorded
  `{"event":"classify-read-failure","detail":"Cannot find module 'typescript' …
  shadow-install/node_modules/instar/dist/localVerify/skipRatchet.js"}` and the
  record carried `harnessChanging: true`, while `classifyHarness` run directly
  over that PR's exact merge-base→head diff returns
  `{harnessChanging: false, reasons: []}`.
- Scope measured on the same machine: 31 of the 44 run logs carry that failure,
  and those 31 are exactly the runs that reached classification (none of the
  other 13 has a `run-finished` event); 10 of the 31 are `pr: 0` main verifies
  with an empty diff. All 20 records in
  `.instar/state/local-verify/journal.jsonl` carry `harnessChanging: true` with
  no `false` — the autonomous merge path had never produced an unflagged record.
  4 of those 20 also carry `protectedPath: true`, which is computed correctly
  inside the same catch-all, so those needed a review regardless: the defect is
  in the reason the flag gave, not in whether a review was warranted.
- New `tests/unit/localVerify/skipRatchetTsResolution.test.ts` (7 tests) pins the
  resolution order, the fallback, that two repos never share a parser, that the
  result is cached rather than merely deterministic, and that a present but
  unloadable copy does not shadow a working one. With both source files reverted
  every one of them fails with `TypeError: loadTsFrom is not a function`.
- Two new cases in `tests/unit/localVerify/orchestrator.test.ts`: one asserts an
  unresolvable parser still classifies `harnessChanging: true` with a logged
  `classify-read-failure` (the fail-closed direction), the other that the seam is
  asked for the run directory and that the record comes back
  `harnessChanging: false` with no `classify-read-failure` logged.

## What to Tell Your User

Nothing changes for an ordinary agent. On a maintainer agent that verifies its
own pull requests locally, EVERY pull request was being held for your approval
with the reason "touches test infrastructure", whether or not it did — so that
approval was never telling you anything. Those pull requests now proceed on
their own, and a pull request that genuinely changes the test harness is still
held, by the same rules as before, which now means something again.

## Summary of New Capabilities

None — this is a correctness fix to an existing classifier. No new route, flag,
config key or user-facing surface.
