# Side-Effects Review — Give the confinement canary the same cache redirect as the check runs

## Summary of the change

`runRunnerCanary` built its confined env as `confinedEnv(process.env, { TMPDIR: paths.tmpDir })`.
vitest and esbuild write caches next to the nearest package root, which from an attempt workspace
resolves ABOVE the workspace into the agent home — in `denyRead`. The `base-unit-smoke` must-succeed
probe therefore failed with `EPERM ... open '<agentHome>/package.json'`, and a canary probe failure
calls `profileUnenforceable()`, which latches the executor for `DAY_MS` with no route that clears it.
The env now also carries `VITEST_CACHE_DIR` and `ESBUILD_CACHE_DIR` under `paths.tmpDir` — exactly
what `FeedbackExecutorService` already passes to its own check runs.

## Decision-point inventory

- `runRunnerCanary()` env construction — **modify** — adds two cache paths under the attempt temp.

## 1. Over-block

Nothing new can be blocked. No probe is added, removed, or re-expected; the must-fail set and its
expectations are untouched. The change only moves where two tools write scratch files.

## 2. Under-block

Does redirecting these caches weaken the rehearsal? No. The sandbox settings object is not touched:
`buildSandboxRuntimeSettings(paths)` still denies the agent home and the deps cache, and all 14
must-fail probes still run against the same policy. The redirect targets `paths.tmpDir`, which is
already in `allowWrite`, so it grants nothing that was not already permitted. Critically, it cannot
mask a real confinement break: a sandbox that wrongly allowed the agent home would still be caught
by `bash-read-agent-config`, `bash-read-secret` and `bash-read-home`, which are unchanged.

## 3. Level-of-abstraction fit

The alternatives were loosening `denyRead` to admit the agent home's manifests (which would blind the
very probes that prove reads are denied), or dropping the smoke probe (which would remove real
coverage). Redirecting two cache paths is the narrowest option and matches an existing precedent in
the same subsystem rather than inventing a mechanism.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It changes two environment values. The canary's verdict logic, its probe list and its expectations
are untouched.

## 4b. Judgment-point check (Judgment Within Floors standard)

None added. Two deterministic path joins.

## 5. Interactions

- **Shadowing:** none; no check runs before or after this.
- **Double-fire:** none; the env is built once per canary run.
- **Races:** both paths are under `paths.tmpDir`, which is already per-attempt and removed with the
  attempt tree, so two concurrent attempts cannot share or clobber them.
- **Feedback loops:** the canary's verdict feeds `profileUnenforceable()`. This change makes that
  latch fire on genuine confinement failures instead of on a cache-location accident — it reduces a
  false-positive path into a destructive 24h state.

## 6. External surfaces

- **Install base:** strictly better. An executor that could not pass its own rehearsal now can;
  nothing else observes these variables.
- **External systems:** none. The canary's network allowlist is empty and stays empty.
- **Persistent state:** two directories inside the attempt temp, discarded with it.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action added or
  touched. The operator-visible effect is the absence of a spurious 24h "profile unenforceable" stop.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface added or touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

None. The canary, the attempt temp and the deps cache are all machine-local; nothing replicates or
takes a lease. A peer without this commit is unaffected.

## 8. Rollback cost

Revert one commit. The symptom would return as the pre-existing spurious latch.

## Conclusion

Proceed. It removes a false-positive path into an unclearable 24h stop, weakens no probe, and copies
a redirect the same subsystem already relies on.

## Second-pass review (if required)

Not required — Tier 1: one env literal in one function plus a test. No decision point, no block
surface, no persisted state, no config.

## Evidence pointers

- Measured in the real sandbox via `SandboxRuntimeRunner` with the canary's own
  `buildSandboxRuntimeSettings(paths)` (no network), workspace = a trusted clone at current main with
  `node_modules` symlinked to the real deps cache, exactly as an attempt is assembled:
  - `smoke-plain` (`npx vitest run --no-cache tests/unit/feedback-factory/triage-floors.test.ts`,
    env as shipped): **EXIT=1**, `EPERM: operation not permitted, open '<agentHome>/package.json'`.
  - `smoke+cachedirs` (same command, plus the two cache dirs): **EXIT=0**.
  - `git-status`, `git-diff` and `sqlite-open` all **EXIT=0** in the same run, so the sandbox itself
    is healthy and the smoke failure was specific to the cache location.
- Unit test has teeth, verified both ways: with the single-line env restored the new test FAILS
  (1 failed | 37 passed); with the fix it passes (38 passed).
- Honest limit: the same measurement run showed `npm run lint` exiting 2 with `TS7006` implicit-any
  errors. That is attributed to the harness, not to main: the probe clone symlinked a deps cache
  built on 2026-10-19 against an older lockfile, while the clone was at current main. A real attempt
  builds its cache from its own base SHA. The lint probe is therefore NOT claimed as verified here.

## Class-Closure Declaration (display-only mirror)

The class is "confined commands whose tooling writes caches outside the writable attempt tree".
Members today: the executor's check runs (already redirected — the precedent) and the canary's
must-succeed probes (redirected here). Both now build their env through `confinedEnv` with the cache
paths under their own temp, so the class is closed at both of its call sites. The `HOME` redirect in
`depsCache.buildNatives` is the third, already-landed member of the same family.
