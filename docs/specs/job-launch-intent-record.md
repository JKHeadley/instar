---
title: "Job launch intent and launch record (per-job thinking mode)"
slug: "job-launch-intent-record"
author: "echo"
parent-effort: "engine-optimization (docs/efforts/engine-optimization on the M5 agent home, topic 141868)"
tier: 2
round-cap: 3
word-budget: 1500
eli16-overview: "docs/specs/job-launch-intent-record.eli16.md"
review-convergence: "2026-11-11T23:06:19.041Z"
review-iterations: 3
review-completed-at: "2026-11-11T23:06:19.041Z"
review-report: "docs/specs/reports/job-launch-intent-record-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 7
contested-then-cleared: 0
---

# Job launch intent and launch record

## Frame (fixed before round 1)

- **Outcome.** A scheduled job can declare a neutral `thinkingMode`. Each engine's launch builder translates it, or drops it with a reason. Every job run that is spawned records what was requested, what was sent, what was dropped, and the CLI version, next to the row's existing `framework` and `model`.
- **Acceptance criteria.**
  1. A job without `thinkingMode` produces argv and env identical to today's on every engine.
  2. A job with `thinkingMode` gets the engine's native setting on Claude Code and Codex, unless it is dropped per §2. Gemini, pi and Grok record `dropped: not-supported`.
  3. Every run row written by `recordStart` (after `spawnSession` resolves) carries `launch`. A spawn error goes to `recordSpawnError` (`JobRunHistory.ts:373`) with no `launch`, and readers treat that as "no launch record". `cliVersion` is `unknown` when it can't be read.
  4. A ratchet lint fails CI if framework-id string literals outside `src/providers/adapters/` grow in total, or grow in any one file without the same PR lowering another file's entry in the checked-in baseline by the same amount. The launch module counts like any other file.
- **Non-goals.**
  - Moving the builders into the adapter tree, or registering the Codex or Gemini adapters.
  - Any other feature: fallback model, tool scope, schemas, advisor.
  - Topic sessions.
  - Triage-investigation spawns. They pass no `thinkingMode` and record no `launch`.
  - Other `buildHeadlessLaunch` callers (`PipeSessionSpawner.ts:421`, `routes.ts:12963`). They pass no `thinkingMode` and are unchanged.
- **Simplest route considered (Rule 116).** Reuse the per-topic `thinkingMode` path: the same enum, mapping functions and builders. Three alternatives were rejected:
  - a capability-registry lookup;
  - a runtime sentinel;
  - recording only a hash of the redacted argv. That would cover every feature, but it can't say *which* intent was dropped or why, and that is exactly what graduation compares.
- **Tier.** 2, because the scheduler spawn path runs on every agent in the fleet. Round cap 3.

## Problem

Every scheduled job runs at the engine's default reasoning effort. Instar already maps a neutral `thinkingMode` (`off|low|medium|high|max`) onto Claude's `--effort` / `MAX_THINKING_TOKENS=0` and Codex's `model_reasoning_effort`, but only for topic sessions (`frameworkSessionLaunch.ts:345-394, 496`). The headless builders take no `thinkingMode`, and `JobRunHistory` doesn't record what the engine was actually told.

## Frontloaded Decisions

| # | Decision | Choice | Reversibility |
|---|---|---|---|
| D1 | `off` on Claude Code | `MAX_THINKING_TOKENS=0` env, recorded `applied {channel:'env'}`, as in interactive sessions | cheap |
| D2 | `off` / `max` on Codex | Keep the existing mapping (`off`→`low`, `max`→`xhigh`). Record both `requestedValue` and `value`, so the remap is visible | cheap |
| D3 | A direct `effort` pin vs `thinkingMode` | The pin wins, recorded as `dropped: overridden-by-effort-pin` | cheap |
| D4 | The route falls back to another engine (`JobModelRoute.ts:67-83`) | The intent follows whichever engine actually launches. The run row's top-level `framework` and `model` show which one | cheap |
| D5 | Record shape | **Frozen**: it is a published interface through `GET /jobs/:slug/history`, and the field names below are fixed. Every enum (`feature`, `channel`, `reason`) is additive-only, and readers must tolerate values they don't know. The row's existing top-level `framework` and `model` are the only copy (no duplicate inside `launch`), and both are set from the same returned session object as `launch` | not cheap, so it is decided here |
| D6 | What the ratchet counts | Every string literal equal to a framework id in `src/**/*.ts`, outside `src/providers/adapters/**` and the id type definitions (`frameworkFacts.ts`, `intelligenceProviderFactory.ts`). Tests are not counted. The baseline is per file, plus a total. A PR may move counts between files (a split or rename re-keys the baseline) as long as the total does not grow. It is a floor, not a proof: constants, concatenation and `startsWith` get past it | cheap |
| D7 | This PR's effect on the baseline | It adds zero literals outside adapters. The builders are already keyed by engine | cheap |
| D8 | Pilot jobs | `bugs-overseer`, `coding-tools-current` and `promise-review` set `thinkingMode: low` on Echo | cheap |

## Design

### 1. Job field

`thinkingMode?: ThinkingMode` is added on every definition path:

- `JobDefinition` (`types.ts`);
- `validateJob` (`JobLoader.ts:359`, for legacy `jobs.json`);
- the agentmd per-slug manifest, which is the authority (`AgentMdJobLoader.ts:68-75, 769-809`): `PerSlugManifest`, `validateManifest`, and derivation in `buildPerSlugManifest`;
- `ALLOWED_FRONTMATTER_KEYS` (`AgentMdJobLoader.ts:80`).

An invalid value fails at load through the existing error path.

### 2. Builders

`HeadlessLaunchOptions` gains `thinkingMode?`. The builder **clamps** first: any value not in `THINKING_MODES` is dropped as `invalid`. This catches paths that skip the loader, the same way `validateEffortLevel` does (`:1023`). `buildHeadlessLaunch` returns `HeadlessLaunchSpec & { applied: LaunchFeature[]; dropped: LaunchDrop[] }`:

```ts
type LaunchFeature = { feature: 'thinkingMode'; requestedValue: ThinkingMode; value: string; channel: 'argv' | 'env' };
type LaunchDrop    = { feature: 'thinkingMode'; requestedValue?: ThinkingMode; reason: 'not-supported' | 'overridden-by-effort-pin' | 'invalid' };
// requestedValue is omitted when reason is 'invalid': raw input never reaches the record.
```

| Engine | Effect |
|---|---|
| claude-code | D3 first; otherwise `--effort <level>` (argv), or for `off`, `MAX_THINKING_TOKENS=0` (env) |
| codex-cli | `-c model_reasoning_effort="<level>"` per D2, including with the `--oss` local provider, exactly as the interactive builder does (`:496`) |
| gemini-cli, pi-cli, grok-build | `not-supported`, no change |

The rerouted-interactive path passes `thinkingMode` to `buildInteractiveLaunch`, which already supports it. That builder gains the same `applied`/`dropped` return values, from the same per-engine branches, so nothing is re-parsed from argv.

### 3. Wiring

`JobScheduler.spawnJobSession` passes `job.thinkingMode` in `spawnOpts`. `SessionManager.spawnSession` passes it to whichever builder runs. The `Session` object returned by `spawnSession` and `spawnReroutedInteractive` gains `launch?`, built **from the final spawned spec object**. That is after the last argv/env change, including the account-home env added at `SessionManager.ts:4836-4838`. `recordStart` (`JobScheduler.ts:3157`) stores it next to the `framework` and `model` it already takes from the same session.

### 4. Launch record

```ts
launch?: {
  cliVersion: string | 'unknown';                  // parsed semver, ≤64 chars
  requested: { thinkingMode?: ThinkingMode };      // validated value only, never raw text
  applied: LaunchFeature[]; dropped: LaunchDrop[]; // closed enums, ≤8 entries each
  truncated?: number;                              // entries beyond 8, dropped from the record and counted here
}
```

**Version helper: `readCliVersion(binPath)`.** It is async.

- **Cache:** it caches the version *string*, keyed on `realpath + size + mtime`, with a 1-hour TTL so that shims and wrappers whose own file never changes are re-read. That costs one `stat` per spawn, and an in-place upgrade is re-read. For Claude it reuses `ClaudeBinaryRetainer`'s cache.
- **Probe:** async `execFile(bin, ['--version'])`, with a 2-second timeout, no shell, stderr discarded, and the child killed on timeout.
- **Never waits:** `recordStart` runs exactly when it does today, inside the spawn's `.then` (`JobScheduler.ts:3137`). That keeps `activeRunIds` and completion matching untouched. It uses the cached value or `unknown`. The probe starts with the spawn, and when it settles (bounded at 2 seconds) a new `recordLaunchVersion(runId, version)` patches the row, following the existing `recordReflection` / `recordEmailOutboxId` updaters. It copies the latest row for the run whole and changes only `launch.cliVersion`, never rebuilding from the start data, so a completion row is never overwritten. A test covers a completion that arrives before the probe settles. A failed probe is never cached as a value. The probed binary is the one that actually launches (the retained per-version copy, `headlessBinaryPath`, `SessionManager.ts:4649`), not the configured path.
- **Claude today:** the existing `ClaudeBinaryRetainer` already probes `--version` synchronously in the spawn path (`ClaudeBinaryRetainer.ts:210-213`, called at `SessionManager.ts:4649`). That cost exists today. The helper reads that cache when the retainer is on, and probes asynchronously itself when the retainer is off.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Builder translates or drops `thinkingMode` | invariant | basis: enumerable-domain; evidence: the input is the 5-value `THINKING_MODES` enum and the output is each engine's fixed flag set, so every case is listed in the §2 table |
| Builder clamp rejects an unknown value | invariant | basis: enumerable-domain; evidence: any value outside the 5-value enum has no engine meaning, and the same clamp already guards `effort` (`validateEffortLevel`, `frameworkSessionLaunch.ts:1023`) |
| Pin beats `thinkingMode` | invariant | basis: external-constraint; evidence: the CLI takes one `--effort` value, and the interactive builder already gives the direct pin precedence (`frameworkSessionLaunch.ts:349-390`); two sources cannot both be sent |
| Ratchet lint fails CI over the baseline | invariant | basis: external-constraint; evidence: 2.0 Rule 30 forbids engine special-casing outside adapters, and the lint only blocks growth of a counted, checked-in number at CI, never a runtime action; the baseline is edited by reviewed PR |
| Graduation verdict | judgment-candidate | **Floor:** fewer than 10 matched runs per job per window is `unknown`, never a pass. A drop in median Jev grade larger than the baseline window's interquartile range is a fail. Smaller grade or token movements are judgment inputs. **Arbiter:** the recurring `feature-maturation-review`, whose model decides (Maturation Path). The fleet change is a reviewed code PR it opens once two independent readings agree. **Conservative default:** not graduated |

## Multi-machine posture

- **Job field.** It is part of the job definition. Definitions are machine-local today, and they move between machines only through the approval-gated private job transfer. The field travels with them. No new surface.
- **Launch record.** This is an **inherited surface, and this spec leaves its posture unchanged.** `launch` is a sub-field of the existing `JobRun` row, and that row is machine-local today (`{stateDir}/ledger/job-runs.jsonl`, `JobRunHistory.ts:11`; read locally by `/jobs/:slug/history`; not backed up). The spec introduces no new machine-local surface, so no justification key is claimed. The fact that the row can't be read across the pool is a pre-existing gap, filed as fb-ca7635e0-b76. Graduation reads the history of the lease holder that runs the jobs and matches runs by `machineId` (`JobRunHistory.ts:72`).
- **Version cache.** In-process memory only, never durable state.

## Verify the state, not its symbol

- **`applied`.** The symbol is the builder's return value. The state it stands for is that the spawned argv/env carried the setting.
  - **Corroboration:** `launch` is derived from the same spec object that was spawned, after its last change. A unit test asserts that the argv or env contains each `applied` entry.
  - **Unmeasurable case:** a run that never reaches spawn gets no record, never a fabricated one.
- **Not claimed:** that the engine honoured the setting, or that it helped. `applied` means "sent". Benefit is measured only by graduation. For `channel: env`, `applied` means "set by this launch". An identical value inherited from the server's own environment is not detected, and is out of scope.

## Testing

- **Unit:**
  - on the real spawn path (not only the builder's return value), the spawned argv/env contains each `applied` entry;
  - golden argv/env with the field absent, snapshotted before the change, for every engine, for both the headless and the interactive builders;
  - every mode on every engine, including the `off`/`max` remaps, the clamp, pin precedence, route fallback and the reroute path;
  - loader validation on legacy, manifest and frontmatter jobs;
  - the version helper: a cache-key change, a timeout, and a failure not being cached;
  - the ratchet: over and under the baseline, and a rename lowering one file's count.
- **Integration:** a scheduler run with `thinkingMode: low` records `launch.applied` on claude-code and `dropped` on a stubbed gemini builder.
- **E2E:** the production init path runs a job, and `GET /jobs/:slug/history` shows `launch`.
- **Surface:** the change is not user-facing, and no dashboard view shows run history. Live-User-Channel Proof does not apply.

## Maturation plan

- **test-agent-live:** a throwaway agent runs one job per engine (claude-code, and codex-cli where installed) with `thinkingMode: low` and one with `off`. Its `GET /jobs/:slug/history` must show `launch.applied` with the expected value and channel.
- **dev-agent-live:** Echo's lease holder sets `thinkingMode: low` on `bugs-overseer` (about 12 runs a day), `coding-tools-current` (4 a day) and `promise-review` (4 a day) for 14 days, alternating by day with the default. Every job run writes a `jobs.launchIntent` `fired` record to the feature-evidence log, plus an `error` record when a launch spec cannot be built.
- **fleet:** built-in jobs may declare `thinkingMode`. The `feature-maturation-review` opens that change as a reviewed code PR per job class once two independent readings of the dev-rung evidence agree. No default changes for user jobs.
- **graduation criterion:** a script computes the floor verdict and the review model reads it. Per job, eligible runs are: treatment runs whose `launch.applied` contains `thinkingMode` with the expected value; baseline runs with no `thinkingMode` requested and no direct effort pin; runs with a known `cliVersion` (`unknown` versions are excluded, and excluded runs are reported separately). Each window needs at least 10 eligible runs matched on framework, model, lane and `cliVersion`. To keep versions shared, the two arms alternate by day over 14 days rather than running as two sequential weeks. No drop in median Jev grade larger than the baseline window's interquartile range. A provisional token target, an absolute median reduction of `max(0.20 × baseline median tokens, 2 × baseline token IQR)`, as a judgment input for the review model. Fewer than 10 matched runs means `unknown`, never a pass.
- **dark-window:** at most 28 days from merge to the dev-rung verdict (merge date plus 28 days). If the criterion is not met by then, the reason and a new date are recorded on the maturation track.
- **ladder:** not applicable: per-job opt-in field with no switch, evidence is jobs.launchIntent records

**Owner check.** The Engine Optimization charter's item B6 (draft, pending Justin's approval) asks Justin to confirm the dev rung. That is an effort-level confirmation on top of the review model's verdict. It never replaces the verdict.

**Rollback:** remove the field; the default path is unchanged. **Migration parity:** one CLAUDE.md template line ("a job can set `thinkingMode` to choose how hard the engine thinks"), plus an identical `migrateClaudeMd` insert sniffed on the phrase "a job can set `thinkingMode`". The bare word `thinkingMode` already appears in the topic-profile line (`PostUpdateMigrator.ts:801`).

## Open questions

*(none)*
