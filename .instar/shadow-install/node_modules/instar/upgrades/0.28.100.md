# Upgrade Notes (Unreleased)

## What Changed

Phase 1b of the INSTAR-JOBS-AS-AGENTMD spec unlocks the Phase 1a loader: `execute.type: "agentmd"` entries now fire on their crons. The Phase 1a defensive `start()` filter is removed and `buildPrompt`'s `case 'agentmd'` now returns the cached body verbatim. The per-job tool allowlist is threaded through `SessionManager.spawnSession` into the spawned Claude Code process as `--allowedTools <comma-separated>`. The two-flag guard for `toolAllowlist: "*"` requires `unrestrictedTools: true` in the same manifest — otherwise the resolver clamps to `["Read"]` and narrates the downgrade via a Dashboard event plus a `DegradationReporter` event. Run records gain seven new observability fields (`origin`, `resolvedPath`, `bodyHash`, `frontmatterHash`, `manifestVersion`, `toolAllowlist`, `unrestrictedTools`, `clampedAllowlist`) and a 2 KB per-row size cap with progressive truncation of non-essential fields. Legacy `prompt`/`skill`/`script` jobs continue to spawn byte-identical to today, with no `--allowedTools` flag (full-tools back-compat preserved). The signed lock-file pipeline lands in Phase 1c.

### feat(scheduler): agentmd job dispatch + tool allowlist enforcement (Phase 1b of jobs-as-agentmd spec)

- **`buildPrompt` agentmd dispatch** — `case 'agentmd': base = job.body` (was: throw). Throws only on the hydration invariant (an agentmd entry missing its body, which is a programmer error not reachable from user input).
- **Tool-allowlist resolver** — pure static `JobScheduler.resolveAllowlist(job)` returns a closed-set `AllowlistResolution`. Decision matrix: legacy → no flag; array → array; `"*"` + `unrestrictedTools:true` → no flag (full tools authorized); `"*"` without `unrestrictedTools` → clamp to `["Read"]` + Dashboard event + degradation event; missing + user origin → `["Read"]`; missing + instar origin → no flag + degradation event (Phase-1c-gap).
- **SessionManager `allowedTools` option** — additive parameter on `spawnSession`. When non-empty array is supplied, appends `--allowedTools <comma-separated>` to `claudeArgs`. Omitted/empty → no flag (full tools, back-compat).
- **Run-record observability extension** — `JobRunHistory.recordStart` now persists `origin`, `resolvedPath`, `bodyHash` (sha256 of body), `frontmatterHash` (sha256 of canonicalized frontmatter — stable across YAML key order), `manifestVersion`, `toolAllowlist`, `unrestrictedTools`, `clampedAllowlist`. All optional; old consumers tolerate `undefined`.
- **2 KB row-size cap** — `JobRunHistory.applyRowSizeCap` enforces a per-row size cap, dropping `outputSummary` → `stateSnapshot` → `handoffNotes` → `reflection` → `error` in that order until the row fits. Essential fields (`runId`, `slug`, `sessionId`, `startedAt`, `result`, `origin`) always survive. Degradation event narrates the truncation.
- **Phase-1c-gap signal** — instar-origin agentmd jobs without an explicit allowlist spawn with full tools AND emit a `DegradationReporter` event on every fire. Phase 1c lock-file defaults will close this; until then the gap is observable and narrated.
- **What does NOT work yet (Phase 1c follow-ups)**: signed lock-file (`.instar/jobs/instar.lock.json` + signatures); lock-file generation in the build pipeline; custom git merge drivers; migration script; dashboard agentmd surface; PostUpdateMigrator changes.

### Evidence

New test files added:

- `tests/unit/scheduler/JobScheduler.agentmd-dispatch.test.ts` — 5 cases: buildPrompt agentmd returns body, prefix-wrapping invariants, golden equivalence for legacy entries (prompt + skill), hydration-bug throw.
- `tests/unit/scheduler/JobScheduler.tool-allowlist.test.ts` — 15 cases: full resolution matrix (legacy/array/unrestricted/clamped/default-user/instar-no-allowlist) + spawn-time plumbing + clamp event emission + Phase-1c-gap degradation event.
- `tests/unit/scheduler/JobScheduler.run-record.test.ts` — 13 cases: observability field population, hash determinism, hash stability across YAML key order, row-size cap truncation order, essential-field preservation.
- `tests/integration/scheduler/agentmd-end-to-end.test.ts` — 1 case: load a synthetic agent state from disk, dispatch the job, assert the spawn-marker file appears AND the run-record row carries every Phase 1b observability field.

Test highlights (verified locally on the worktree):

```
 ✓ tests/unit/scheduler/JobScheduler.agentmd-dispatch.test.ts (5 tests) 22ms
 ✓ tests/unit/scheduler/JobScheduler.tool-allowlist.test.ts (15 tests) 31ms
 ✓ tests/unit/scheduler/JobScheduler.run-record.test.ts (13 tests) 16ms
 ✓ tests/integration/scheduler/agentmd-end-to-end.test.ts (1 test) 56ms

 Test Files  4 passed (4)
      Tests  34 passed (34)
```

The pre-existing `tests/unit/scheduler-queue-edge.test.ts` (which asserts on the literal source text of `buildPrompt`) continues to pass — Phase 1b's change to the `case 'agentmd'` branch did not regress that fixture.

Side-effects review: `upgrades/side-effects/jobs-as-agentmd-phase-1b.md` — covers over-block, under-block, level-of-abstraction fit, signal-vs-authority compliance (every new surface is signal-or-enumerable-disambiguation, no brittle blocking authority added), interactions, external surfaces (one new event type, two new degradation reasons), and rollback (additive — revert + patch release, no schema migration).

## What to Tell Your User

Phase 1a let instar READ the new markdown-based job format. Phase 1b lets it RUN them: agentmd jobs now fire on their crons, with each job's tool allowlist enforced inside its session. Legacy jobs keep working exactly as before. When you migrate a job to the new format, you can declare a precise list of tools — and instar refuses to grant a wildcard without a second confirmation flag in the same file, falling back to read-only with a logged warning if you forget. Run records now carry a hash of each job's body so it is visible at a glance when the markdown changed. The signed lock-file pipeline (where these hashes become security gates) lands in Phase 1c.

## Summary of New Capabilities

- **agentmd job dispatch** — `execute.type: "agentmd"` jobs now fire end-to-end; `buildPrompt` returns the cached body, prefix logic wraps unchanged.
- **Per-job tool allowlist enforcement** — frontmatter `toolAllowlist` is threaded into the spawned Claude Code session via `--allowedTools`.
- **Unrestricted-tools two-flag guard** — `toolAllowlist: "*"` requires `unrestrictedTools: true` in the same manifest; mis-paired manifests clamp to `["Read"]` with a narrated downgrade event.
- **Run-record observability** — every agentmd run records origin, resolved path, body + frontmatter hashes, manifest version, effective allowlist, unrestricted/clamped state.
- **2 KB row-size cap** — bounded run-record size with deterministic truncation order; essential fields always survive.
