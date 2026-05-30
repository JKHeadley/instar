# vNEXT — plain English overview

## What this change is

There's a safety guard called SourceTreeGuard. Its job is to refuse any
operation that would touch the instar source code from inside an agent
that's running against that source code. The 2026-04-22 incident — an agent
accidentally clobbering its own source tree — was the reason the guard
shipped. It's saved us from a repeat several times.

But the guard treats READ and WRITE the same: it refuses BOTH. That's
overcautious — reading the git log of a repo is harmless. And the
Failure-Learning Loop we just turned on yesterday needs to read git log
to find reverts, and to read `git remote get-url` to know which GitHub
repo to poll for CI failures. So on Echo (the canonical dogfooding agent,
whose checkout IS the instar source), the loop has been silently failing
once per detector tick for the past ~5 hours: a warning in stderr, no
event in the ledger, no surfacing in the API.

There's already an escape hatch — `sourceTreeReadOk: true` — that other
read-only callers (the worktree-manager, the canonical-ref reconciler)
use. This PR plugs the Failure-Learning Loop's three read callsites into
the same hatch. No changes to the guard itself.

## What already exists

- `SourceTreeGuard` (`src/core/SourceTreeGuard.ts`) — refuses operations
  against the instar source tree.
- `SafeGitExecutor` with `readSync` and `execSync` methods, plus
  `sourceTreeReadOk` opt-in.
- `SOURCE_TREE_READ_TIER_VERBS` — an allowlist of read-only verbs
  (`log`, `show`, `remote`, `rev-parse`, …) that the opt-in legitimizes.
- `RevertDetector`, `CiFailurePoller`, `FailureAttributionEngine` — the
  three failure-learning components that read git.

## What's new

- Three call sites updated to pass `sourceTreeReadOk: true`:
  - RevertDetector's default git function
  - AgentServer's `commitTouchedFiles` for the attribution engine
  - AgentServer's `resolveRepo` for the CI poller
- A unit test that scans the failure-learning code for any
  `SafeGitExecutor.readSync` call missing the flag. Catches any future
  new callsite that ships without the opt-in.
- An integration test that runs the DEFAULT RevertDetector against the
  real instar source tree (the existing tests entirely mocked git, which
  is how this gap shipped silently).

## What you need to decide

Nothing. Surgical fix, no config, no fleet migration. Existing agents
pick it up on the next process restart from auto-update.

## How to verify it worked after deploy

If you have `monitoring.failureLearning.sources.revert: true` (or
`sources.ci: true`) set on an agent whose project directory is the
instar source tree, check `logs/server-stderr.log` after the next
restart. The recurring `[revert-detector] SourceTreeGuardError`
warnings should stop. After a couple of detector ticks (the default is
6 hours but you can lower it), `/failures/analysis` should start
showing captured events with attribution.

## Why this matters more than it might look

The Failure-Learning Loop is the meta-trace we just deliberately enabled
because we've been shipping bugs faster than we can learn from them. If
that loop itself is silently broken on the canonical dogfooding agent,
the whole "we'll start learning from our bugs" plan is theater. This is
the post-mortem's lesson reflected back on itself: shipping ≠ working.
And the catch — that the existing unit tests masked the bug because
they entirely mocked the git layer — is precisely the
"tested-on-mocks-not-real-state" pattern the post-mortem named.
