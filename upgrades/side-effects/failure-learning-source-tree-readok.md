# Side-effects review — Failure-Learning git reads opt into sourceTreeReadOk

## What changed

Three `SafeGitExecutor.readSync` call-sites used by the Failure-Learning Loop
now pass `sourceTreeReadOk: true`:

1. `src/monitoring/RevertDetector.ts` — default `git` injection (used when the
   constructor caller doesn't supply an override).
2. `src/server/AgentServer.ts` — the `FailureAttributionEngine`'s
   `commitTouchedFiles` (uses `git show --name-only`).
3. `src/server/AgentServer.ts` — the `CiFailurePoller`'s `resolveRepo` (uses
   `git remote get-url origin`).

All three verbs (`log`, `show`, `remote`) are already in
`SOURCE_TREE_READ_TIER_VERBS`, so the flag legitimately opens the read on the
instar source tree without weakening the destructive-write protection.

## Why

The 2026-05-29 pipeline post-mortem (PR #545) flipped the
`monitoring.failureLearning.sources.ci: true` and `sources.revert: true`
flags on Echo. Within an hour of the flip — and continuing for several hours
after — `logs/server-stderr.log` filled with

```
[WARN] [revert-detector] SourceTreeGuardError: Refusing to run
failure-learning:revert-detect against the instar source tree (requested
dir: /Users/justin/.instar/agents/echo, resolved git root: /Users/justin/
.instar/agents/echo).
```

once per detector tick (every ~5 min). `GET /failures/analysis` reported
`total: 1` (the manually-diagnosed entry I posted that morning) because
every actual CI/revert ingestion attempt was silently bouncing off the
guard. The detector's `onError` callback logged a warn and then returned,
so the ledger never saw the event.

`SourceTreeGuard` exists to prevent destructive operations against the
instar source tree (the 2026-04-22 incident class). The escape hatch
`SafeGitOptions.sourceTreeReadOk: true` is the documented opt-in for
legitimate read-tier calls against an agent's own checkout — already used
by the worktree-manager and the canonical-ref reconciler. The
Failure-Learning Loop's revert-detector and CI-poller are exactly the
same shape: they read the agent's own repo to do their job. The fix is
to opt them into the existing escape hatch, not to weaken the guard.

The substrate (`SOURCE_TREE_READ_TIER_VERBS`, `sourceTreeReadOk`,
`isSourceTreeCheckBypassed`) was already shipped — this PR just wires
the failure-learning consumers into it.

## Risk surface

- **No new destructive-shape exposure.** `sourceTreeReadOk: true` only
  bypasses the source-tree check for verbs in the explicit
  `SOURCE_TREE_READ_TIER_VERBS` set. Destructive verbs still hit the
  guard the same as before. `readSync` itself also fails-closed on any
  non-read shape (via `isReadOnlyShape` + `READONLY_GIT_VERBS`) before
  the source-tree check is even consulted.
- **No fleet config change.** Default off agents see no behavior change.
  Agents that have already opted in (only Echo today) start capturing
  CI failures + reverts on the next process restart.
- **Tests** — one unit (4 sub-tests, static introspection of the
  call-shape across RevertDetector + AgentServer + the catch-all
  failure-learning callsite scanner) and one integration (1 sub-test,
  exercises the DEFAULT git invocation against the actual instar
  source tree — the path the existing unit tests entirely mocked,
  which is how the gap shipped silently in the first place). Both
  positive- and negative-verified by removing the flag.

## Bug surfaces eliminated

- The failure-learning loop's `revert` source captures real reverts on
  dogfooding agents (Echo).
- The failure-learning loop's `ci` source can now resolve the GitHub
  repo URL on dogfooding agents (it was silently returning `null` from
  `resolveRepo` and skipping the entire poll).
- Future failure-learning git reads added against the agent's source
  tree must carry the flag — surfaced at commit time by the catch-all
  test.

## Migration footprint

None. This is pure source-code wiring; no config schema change, no
fleet migration required. Existing agents pick up the fix on next
process restart (auto-update path).

## Testing

- Unit: `tests/unit/failure-learning-source-tree-readok-wiring.test.ts`
  — 4 tests. Per-callsite positive checks + catch-all that scans the
  failure-learning surface. Verified positive + destructive-negative
  (removing the flag from RevertDetector → catch-all test fails as
  expected).
- Integration: `tests/integration/failure-learning-real-source-tree.test.ts`
  — 1 test. Constructs RevertDetector with NO git override (forces the
  default SafeGitExecutor.readSync path), points `cwd` at the test's own
  repo root (which IS the instar source on every CI shard), asserts the
  default invocation does not throw SourceTreeGuardError and returns a
  real commit-subject string. Verified negative — removing the flag
  makes the test fail with `SourceTreeGuardError`.

## Follow-ups

- Meta lesson: the existing RevertDetector + CiFailurePoller unit tests
  mock `git`/`runGh` entirely, which is how this gap shipped silently.
  This is an instance of post-mortem pattern #1 ("tested on fresh state,
  not real-world state"). Post-mortem lever B (real-world-state fixture
  test class) closes the broader pattern; until then, the catch-all
  static-introspection test pins this specific class.
- Echo's accumulated `[revert-detector] SourceTreeGuardError` warnings
  in `server-stderr.log` will stop appearing after the v1.3.109+
  auto-update lands.
