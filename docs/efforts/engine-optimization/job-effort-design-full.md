---
title: "Job launch intent and launch record (per-job thinking mode)"
slug: "job-launch-intent-record"
author: "echo"
parent-effort: "engine-optimization (docs/efforts/engine-optimization on the M5 agent home, topic 141868)"
tier: 2
round-cap: 3
word-budget: 1500
eli16-overview: "docs/specs/job-launch-intent-record.eli16.md"
review-convergence: "2026-11-11T23:27:13.924Z"
review-iterations: 3
review-completed-at: "2026-11-11T23:27:13.924Z"
review-report: "docs/specs/reports/job-launch-intent-record-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 8
contested-then-cleared: 0
---

# Job launch intent and launch record

## Frame (fixed before round 1)

- **Outcome.** A scheduled job can declare a neutral `thinkingMode`. Each engine's launch builder translates it, or drops it with a reason. Every job run that is spawned records what was requested, what was sent, what was dropped, and the CLI version, next to the row's existing `framework` and `model`.
- **Acceptance criteria.**
  1. A job without `thinkingMode` produces argv and env identical to today's on every engine.
  2. A job with `thinkingMode` gets the engine's native setting on Claude Code and Codex, unless it is dropped per §2. Gemini, pi and Grok record `dropped: not-supported`.
  3. Every run row written by the main job path's `recordStart` (`JobScheduler.ts:3157`, after `spawnSession` resolves) carries `launch`, unless the row-size cap shed it (D9). The script-run (`:1940`, `:2616`) and triage (`:2920`) call sites do not. A spawn error goes to `recordSpawnError` (`JobRunHistory.ts:373`) with no `launch`, and readers treat that as "no launch record". `cliVersion` is `unknown` when it can't be read.
  4. A ratchet lint fails CI if framework-id string literals outside `src/providers/adapters/` grow in total, or grow in any one file without the same PR lowering another file's entry in the checked-in baseline by the same amount. The launch module counts like any other file.
- **Non-goals.**
  - Moving the builders into the adapter tree, or registering the Codex or Gemini adapters.
  - Any other feature: fallback model, tool scope, schemas, advisor.
  - Topic sessions.
  - Triage-investigation spawns. They pass no `thinkingMode` and record no `launch`.
  - The other `buildHeadlessLaunch` caller (`PipeSessionSpawner.ts:421`). It passes no `thinkingMode` and is unchanged.
  - **The benefit experiment** (which jobs, how arms alternate, how tokens and grades are compared). This was cut after round 3 and moved to its own spec, `job-thinking-mode-pilot`, tracked as an initiative. This spec ships the mechanism and its record, proved mechanically.
- **Simplest route considered (Rule 116).** Reuse the per-topic `thinkingMode` path: the same enum, mapping functions and builders. Rejected: a capability-registry lookup, a runtime sentinel, and an argv hash (it can't say which intent was dropped or why).
- **Tier.** 2, because the scheduler spawn path runs on every agent in the fleet. Round cap 3.

## Problem

Every scheduled job runs at the engine's default reasoning effort. Instar already maps a neutral `thinkingMode` (`off|low|medium|high|max`) onto Claude's `--effort` / `MAX_THINKING_TOKENS=0` and Codex's `model_reasoning_effort`, but only for topic sessions (`frameworkSessionLaunch.ts:345-394, 496`). The headless builders take no `thinkingMode`, and `JobRunHistory` doesn't record what the engine was actually told.

## Frontloaded Decisions

| # | Decision | Choice | Reversibility |
|---|---|---|---|
| D1 | `off` on Claude Code | `MAX_THINKING_TOKENS=0` env, recorded `applied {channel:'env'}`, as in interactive sessions | cheap |
| D2 | `off` / `max` on Codex | Keep the existing mapping (`off`→`low`, `max`→`xhigh`). Record both `requestedValue` and `value`, so the remap is visible | cheap |
| D3 | A direct `effort` pin vs `thinkingMode` | The pin wins, recorded as `dropped: overridden-by-effort-pin`. Today no job path passes a pin to the headless builder (`SessionManager.ts:4728-4744`), so this branch is defensive | cheap |
| D4 | The route falls back to another engine (`JobModelRoute.ts:67-83`) | The intent follows whichever engine actually launches. The run row's top-level `framework` and `model` show which one | cheap |
| D5 | Record shape | **Frozen**: it is a published interface through `GET /jobs/:slug/history`, and the field names below are fixed. Every enum (`feature`, `channel`, `reason`) is additive-only, and readers must tolerate values they don't know. The row's existing top-level `framework` and `model` are the only copy (no duplicate inside `launch`), and both are set from the same returned session object as `launch` | not cheap, so it is decided here |
| D6 | What the ratchet counts | Every string literal equal to a framework id in `src/**/*.ts`, outside `src/providers/adapters/**` and the id type definitions (`frameworkFacts.ts`, `intelligenceProviderFactory.ts`). Tests are not counted. The baseline is per file, plus a total. A PR may move counts between files (a split or rename re-keys the baseline) as long as the total does not grow. It is a floor, not a proof: constants, concatenation and `startsWith` get past it | cheap |
| D7 | This PR's effect on the baseline | It adds zero literals outside adapters. The builders are already keyed by engine | cheap |
| D8 | Dev-rung job | One Echo **user** job (not an instar-origin, lock-signed one) sets `thinkingMode: low`: `bugs-overseer` (an Opus job, about 12 runs a day). The benefit experiment is the separate pilot spec | cheap |
| D9 | Row size cap | `launch` is appended to `TRUNCATABLE_FIELDS` (`JobRunHistory.ts`), so the existing 2,048-byte cap sheds it, last among the optional fields and before any essential one. A shed `launch` reads as "no launch record". `recordLaunchVersion` does nothing when the latest row has no `launch` | cheap |

## Design

### 1. Job field

`thinkingMode?: ThinkingMode` is added on every definition path:

- `JobDefinition` (`types.ts`);
- `validateJob` (`JobLoader.ts:359`, for legacy `jobs.json`);
- the agentmd per-slug manifest, which is the authority: `PerSlugManifest` (`AgentMdJobLoader.ts:163`), `validateManifest`, `manifestToJobDefinition` (`:1513`), `buildPerSlugManifest` (`src/scheduler/buildPerSlugManifest.ts:63`), and the frontmatter extraction in `InstallBuiltinJobs.ts:286`;
- the legacy-to-agentmd migration, which picks fields explicitly (`src/commands/jobMigrate.ts:164`);
- the private job transfer's closed key set (`MANIFEST_KEYS`, `src/core/JobPortableBundle.ts:13`), which otherwise refuses the field with `unknown-manifest-field`;
- `ALLOWED_FRONTMATTER_KEYS` (`AgentMdJobLoader.ts:80`).

**Paths deliberately not covered.** None of these can carry the field after this change:
- the built-in template generator (`scripts/regen-default-job-templates.mjs:42`, `frontmatterFor`), because built-in jobs gain `thinkingMode` only through the pilot spec, which must extend this generator and test generation through install and load;
- the old dashboard job editor (`dashboard/index.html:8656`, saved by `POST /jobs/:slug/save`), which already omits required fields (filed separately);
- `writeUserTemplate` (`jobMigrate.ts:124`).

For agentmd user jobs the field takes effect **in the manifest**; frontmatter is decorative there. An invalid value fails at load through the existing error path. **Round-trip test:** one fixture job carrying `thinkingMode` passes through legacy load, migration, manifest build, install, agentmd load and portable export/import, and keeps the value at every step. The install step uses a built-in-shaped fixture. Each read of this spec found one more hand-listed path, so the test is the guard, not the list.

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
| codex-cli | `-c model_reasoning_effort="<level>"` per D2, placed before `-m <model> <prompt>` (`:1094-1096`), including with the `--oss` local provider, exactly as the interactive builder does (`:496`) |
| gemini-cli, pi-cli, grok-build | `not-supported`, no change |

The rerouted-interactive path passes `thinkingMode` to `buildInteractiveLaunch`, which already supports it. That builder gains the same `applied`/`dropped` return values, from the same per-engine branches, so nothing is re-parsed from argv.

### 3. Wiring

`JobScheduler.spawnJobSession` adds `job.thinkingMode` to the `spawnSession` options at `JobScheduler.ts:3120`. `SessionManager.spawnSession` passes it to whichever builder runs. The `Session` object returned by `spawnSession` and `spawnReroutedInteractive` gains `launch?`, built **from the final spawned spec object**. It is captured from the exact argv and `-e` env flags passed to the tmux `execFileSync`, immediately before that call, on both lanes: headless (after `:4844` and `:4881`) and rerouted (after `:5282`, `:5295` and `:5328`). `recordStart` (`JobScheduler.ts:3157`) stores it next to the `framework` and `model` it already takes from the same session.

### 4. Launch record

```ts
launch?: {
  cliVersion: string | 'unknown';                  // parsed semver, ≤64 chars
  requested: { thinkingMode?: ThinkingMode };      // validated value only, never raw text
  applied: LaunchFeature[]; dropped: LaunchDrop[]; // closed enums, ≤8 entries each
  omitted?: number;                                // entries beyond 8 across both arrays, dropped from the record and counted here (unreachable while only one feature exists)
}
```

**Version helper: `readCliVersion(binPath)`.** It is async.

- **Cache:** it caches the version *string*, keyed on `realpath + size + mtime`, with a 1-hour TTL so that shims and wrappers whose own file never changes are re-read. An expired entry counts as a miss: the run records `unknown` and is patched when the probe settles. 
- **Probe:** async `execFile(bin, ['--version'])`, with a 2-second timeout, no shell, stderr discarded, and the child killed on timeout. It sets `CLAUDE_CODE_DISABLE_AUTOUPDATER=1`, as the retainer does (`ClaudeBinaryRetainer.ts:217`), runs in a neutral temporary cwd, and runs at most one probe per cache key at a time.
- **Never waits:** `recordStart` runs exactly when it does today, inside the spawn's `.then` (`JobScheduler.ts:3137`). That keeps `activeRunIds` and completion matching untouched. It uses the cached value or `unknown`. The probe starts with the spawn, and when it settles (bounded at 2 seconds) a new `recordLaunchVersion(runId, version)` patches the row, following the existing `recordReflection` / `recordEmailOutboxId` updaters. It copies the latest row for the run whole and changes only `launch.cliVersion`, never rebuilding from the start data, so a completion row is never overwritten. A failed probe is never cached as a value. The probed binary is the one that actually launches (the retained per-version copy, `headlessBinaryPath`, `SessionManager.ts:4650`), not the configured path.
- **Claude today:** `ClaudeBinaryRetainer` already resolves a version during spawn (from `package.json`, falling back to `--version`, `ClaudeBinaryRetainer.ts:186-213`). It caches a failed read as `null` without expiry, and returns no version for wrapper scripts. The helper uses `SessionManager.claudeLaunchVersions` (`:7030`) **only when it holds a non-null version** for the launched path. Otherwise, including every retainer fallback, it runs its own async probe as above.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Builder translates or drops `thinkingMode` | invariant | basis: enumerable-domain; evidence: the input is the 5-value `THINKING_MODES` enum and the output is each engine's fixed flag set, so every case is listed in the §2 table |
| Builder clamp rejects an unknown value | invariant | basis: enumerable-domain; evidence: any value outside the 5-value enum has no engine meaning, and the same clamp already guards `effort` (`validateEffortLevel`, `frameworkSessionLaunch.ts:1023`) |
| Pin beats `thinkingMode` | invariant | basis: enumerable-domain; evidence: two inputs with one fixed precedence, following the established compatibility policy of the interactive builder, where a direct pin wins and the thinking-mode branch is skipped, including the `off` env channel (`frameworkSessionLaunch.ts:349-394`). Headless mirrors it so one job behaves the same on both lanes. It is a chosen policy, made invariant for cross-lane consistency |
| Ratchet lint fails CI over the baseline | invariant | basis: external-constraint; evidence: 2.0 Rule 30 forbids engine special-casing outside adapters. The literal count is a chosen proxy for that rule, and the baseline grandfathers today's code. The invariant is only the enforcement: a deterministic CI comparison against a checked-in number, never a runtime action. Choosing the proxy and editing the baseline are reviewed-PR policy |
| Mechanism graduation verdict | judgment-candidate | **Floor:** the counts in the Maturation plan's graduation criterion; any `error` record or any argv/env mismatch fails. **Arbiter:** the recurring `feature-maturation-review`, whose model decides (Maturation Path). **Conservative default:** not graduated |

## Multi-machine posture

- **Job field.** It is part of the job definition. Definitions are machine-local today, and they move between machines only through the approval-gated private job transfer. The field travels with them between machines on this version or later. An older peer refuses a bundle that carries it (`unknown-manifest-field`), and an older loader withholds a job with the unknown key. Both fail closed. No new surface.
- **Launch record.** This is an **inherited surface, and this spec leaves its posture unchanged.** `launch` is a sub-field of the existing `JobRun` row, and that row is machine-local today (`{stateDir}/ledger/job-runs.jsonl`, `JobRunHistory.ts:11`; read locally by `/jobs/:slug/history`; not backed up). The spec introduces no new machine-local surface, so no justification key is claimed. The fact that the row can't be read across the pool is a pre-existing gap, filed as fb-ca7635e0-b76.
- **Version cache.** In-process memory only.

## Verify the state, not its symbol

- **`applied`.** The symbol is the builder's return value. The state it stands for is that the spawned argv/env carried the setting.
  - **Corroboration:** `launch` is derived from the same spec object that was spawned, after its last change. A unit test asserts that the argv or env contains each `applied` entry.
  - **Unmeasurable case:** a run that never reaches spawn gets no record, never a fabricated one.
- **Not claimed:** that the engine honoured the setting, or that it helped. `applied` means "sent". Benefit is measured only by the separate pilot spec. For `channel: env`, `applied` means "set by this launch". An identical value inherited from the server's own environment is not detected, and is out of scope.

## Testing

- **Unit:**
  - on the real spawn path (not only the builder's return value), the spawned argv/env contains each `applied` entry;
  - golden argv/env with the field absent, snapshotted before the change, for every engine, for both the headless and the interactive builders;
  - every mode on every engine, including the `off`/`max` remaps, the clamp, pin precedence, route fallback and the reroute path;
  - loader validation on legacy, manifest and frontmatter jobs;
  - the version helper: a cache-key change, TTL expiry, a timeout, a failure not being cached, a retainer `null` falling through to the probe, and a completion arriving before the probe settles;
  - a boundary-sized row (about 2,048 bytes) sheds the other optional fields first, then `launch`, and keeps every essential field;
  - the ratchet: over and under the baseline, and a rename lowering one file's count.
- **Integration:** a scheduler run with `thinkingMode: low` records `launch.applied` on claude-code and `dropped` on a stubbed gemini builder.
- **E2E:** the production init path runs a job, and `GET /jobs/:slug/history` shows `launch`.
- **Surface:** the dashboard does fetch run history (`dashboard/index.html:9004`, `dashboard/console/schedule.js:195`), but this change adds no presentation of `launch`. Readers that ignore unknown keys are unaffected (a unit test covers the console reader). Live-User-Channel Proof does not apply, because no user-visible surface changes.

## Maturation plan

- **test-agent-live:** a throwaway agent runs one job per installed engine (claude-code, and codex-cli where installed) with `thinkingMode: low`, one with `off`, and one Haiku-tier Claude job with `low` ("sent" is not "accepted", so each model tier gets a live launch). Its `GET /jobs/:slug/history` must show `launch.applied` with the expected value and channel, and its spawned argv/env must match.
- **dev-agent-live:** on Echo's lease holder, the D8 user job sets `thinkingMode: low` for 7 days. Every main-path job run, with or without the field, writes a `jobs.launchIntent` `fired` record to the feature-evidence log, and an `error` record when a launch record can't be built.
- **fleet:** the field and the record ship enabled in the release that carries them. The field is inert until a job sets it, and the record only describes launches. Built-in jobs gain `thinkingMode` only through the separate pilot spec.
- **graduation criterion:** the review model reads these counts from the feature-evidence log and the run history. The argv/env match itself is proved by the unit tests and the test-agent rung, not counted at the dev rung. Over the 7 days, the D8 job shows at least 40 `fired` records with `launch.applied` = `low` on its engine. Every other main-path job row shows `launch` with empty `applied` and `dropped`, apart from cap-shed rows. There are 0 `error` records. A known `cliVersion` appears on at least 90% of rows after their version patch. Fewer than 40 runs means `unknown`, never a pass.
- **dark-window:** none for the mechanism, which is live on release and inert. The dev-rung verdict is due at merge plus 14 days. If it is not met, the reason and a new date are recorded on the maturation track.
- **ladder:** not applicable: per-job opt-in field with no switch, evidence is jobs.launchIntent records

**Rollback:** remove the field before any downgrade; the default path is unchanged. **Migration parity:** one CLAUDE.md template line ("a job can set `thinkingMode` in its manifest to choose how hard the engine thinks"), plus an identical `migrateClaudeMd` insert sniffed on the phrase "a job can set `thinkingMode`". The bare word `thinkingMode` already appears in the topic-profile line (`PostUpdateMigrator.ts:801`).

## Open questions

*(none)*
