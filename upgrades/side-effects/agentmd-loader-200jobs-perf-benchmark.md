# Side-effects review — agentmd 200-job loader perf benchmark

## What changed

New CI-time integration test `tests/integration/agentmd-loader-200jobs-perf.test.ts` exercises the spec §Performance Budgets contract:

- Cold-boot @ 200 per-slug manifests: <1500ms
- Warm-boot @ 200 per-slug manifests: <500ms

The fixture is generated deterministically at test-setup time (`generate200JobFixture(stateDir)`) — 200 `.md` bodies + 200 manifests in a synthetic workspace. The generator stays out of the repo (no 400 fixture files committed) but the bytes it produces are stable across runs.

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** the test fails the build only when the loader actually exceeds the budget. The cold-boot budget (1500ms) is intentionally generous for CI runners with variable IO speed; if it becomes flaky, the remediation is to profile + optimize the loader, NOT to raise the budget (the spec's number is the contract).
- **Under-block:** the benchmark only measures `loadJobs()` itself — not server boot, not migrator, not session spawn. A regression elsewhere in the boot path would not surface here. Adding boot-level benchmarks is a separate effort if needed.

### 2. Level-of-abstraction fit

Pure consumer of `loadJobs()`. The fixture generator is co-located in the test file (small enough to live there). No new runtime code paths.

### 3. Signal-vs-authority compliance

The test produces a signal ("budget exceeded"). The CI pipeline is the authority that fails the build on that signal. Both budgets are encoded as constants in the test, so any change to them is visible in the diff.

### 4. Interactions

- **Phase 1a JobLoader** — exercised directly. Any optimization to the per-slug fanout, YAML parse, or Zod validation will show up here.
- **Phase 1c-runtime lock-file consumer** — runs as part of `loadJobs` for `origin:instar` entries. The fixture uses `origin:user` to keep the benchmark focused on the loader fanout path; lock-file verification has its own dedicated tests.
- **CI runner stability** — measurements log to stdout so flakes are debuggable. If the budget becomes a problem on a specific runner shard, the log output identifies which step is slow.

### 5. Rollback cost

Trivial. Single test file. Delete to revert.

## Test coverage

2 cases in `tests/integration/agentmd-loader-200jobs-perf.test.ts`:

1. Cold-boot @ 200 jobs <1500ms (per spec)
2. Warm-boot @ 200 jobs <500ms (per spec)

Locally observed: cold ~15ms, warm ~16ms — orders of magnitude under budget. CI runners are slower; the 1500ms ceiling gives substantial headroom.

## What is NOT in this PR

- Reconcile + dispatch + spawn-time benchmarks (separate concerns).
- Per-step profiling (only end-to-end loader latency is asserted).
- Memory benchmarks (the spec's budgets are time-bounded only).
