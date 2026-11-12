# Side-Effects Review — job launch intent and launch record (per-job thinking mode)

**Version / slug:** `job-launch-intent-record`
**Date:** `2026-11-11`
**Author:** `echo`
**Second-pass reviewer:** required (this touches the session spawn path). An independent reader other than the builder (GPT 6 Astra, with source access) performs it against this artifact and the final diff; its verdict is appended below by that reader, not by the builder.

## Summary of the change

Jobs gain an optional neutral `thinkingMode` (`off|low|medium|high|max`). Both launch builders (`buildHeadlessLaunch`, `buildInteractiveLaunch`) now clamp it to the enum, translate it per engine, and always return `applied` / `dropped`: Claude Code gets `--effort <level>` or, for `off`, `MAX_THINKING_TOKENS=0` (env); Codex gets `-c model_reasoning_effort="<level>"` (with the existing `off`→low, `max`→xhigh remap), placed before `-m <model> <prompt>`; Gemini, pi and Grok record `not-supported`; a valid direct `effort` pin wins and records `overridden-by-effort-pin`; an out-of-enum value records `invalid` with no raw text. The translation lives in two translator functions (Claude, Codex) used by both builders, so the interactive topic-profile path and the new headless path share one mapping. `SessionManager.spawnSession` passes the field to whichever builder runs, and builds `Session.launch` from the exact tmux argument list immediately before the `execFileSync` on both the headless and the rerouted-interactive lane (each `applied` entry is corroborated against the final argv / last `-e` value; if any is missing no record is written). `JobScheduler` passes `job.thinkingMode` on the main job path only, stores `launch` next to `framework`/`model` in `recordStart`, writes one `jobs.launchIntent` `fired` evidence row per main-path run (plus an `error` row when the session has no launch), and, after the start row exists, asks `SessionManager.probeLaunchVersion` for the launched binary's version and patches it with the new `JobRunHistory.recordLaunchVersion`. A new `src/core/cliVersionReader.ts` provides the cached/async version read. `launch` joins `TRUNCATABLE_FIELDS` last. The field is carried on every definition path (types, legacy `validateJob`, agentmd manifest type/validation/`manifestToJobDefinition`, frontmatter allow-list, `buildPerSlugManifest`, `InstallBuiltinJobs`, `jobMigrate.writeManifest`, portable `MANIFEST_KEYS`). A dev-rung counter (`src/scheduler/launchIntentEvidence.ts`) turns rows + evidence into the spec's graduation floor. A CI ratchet (`scripts/lint-framework-name-ratchet.mjs` + baseline, its own `scripts.lint` step) stops framework-id literals outside the adapters from growing. The CLAUDE.md template gains one Job Scheduler bullet, mirrored by an idempotent `migrateClaudeMd` insert.

Files: `src/core/frameworkSessionLaunch.ts`, `src/core/SessionManager.ts`, `src/core/types.ts`, `src/core/cliVersionReader.ts` (new), `src/core/JobPortableBundle.ts`, `src/core/PostUpdateMigrator.ts`, `src/scheduler/JobScheduler.ts`, `src/scheduler/JobRunHistory.ts`, `src/scheduler/JobLoader.ts`, `src/scheduler/AgentMdJobLoader.ts`, `src/scheduler/buildPerSlugManifest.ts`, `src/scheduler/InstallBuiltinJobs.ts`, `src/scheduler/launchIntentEvidence.ts` (new), `src/commands/jobMigrate.ts`, `src/scaffold/templates.ts`, `scripts/lint-framework-name-ratchet.mjs` (new), `scripts/framework-name-ratchet-baseline.json` (new), `package.json` (one lint step). Size: about 900 added lines of source and script across 18 files, plus the 13 frozen test files (3,223 lines) committed separately and unchanged.

Proportion: Tier 2, spec converged in 3 review rounds after a scope cut; frozen tests took five independent reads. Build: one test commit and one implementation commit.

## Decision-point inventory

- Builder translate-or-drop (`frameworkSessionLaunch.ts` translators) — **add** — enumerable 5-value enum × fixed flag set, an invariant.
- Builder clamp of out-of-enum values (`clampThinkingMode`) — **add** — mirrors `validateEffortLevel`.
- Direct effort pin vs `thinkingMode` — **pass-through / extended** — the interactive builder's existing precedence (pin wins, including over the `off` env channel) now also holds on the headless builder and is recorded.
- Job loaders' closed-key validation — **modify** — one new allowed key (`thinkingMode`) in the frontmatter allow-list and the portable manifest key set; legacy and manifest validation refuse an out-of-enum value by name.
- Launch record corroboration (`SessionManager.captureLaunchRecord`) — **add** — signal only: it decides whether a record is written, never whether the spawn happens.
- Ratchet lint in CI — **add** — deterministic comparison with a checked-in baseline; no runtime authority.
- Graduation counter (`evaluateLaunchMechanismGraduation`) — **add** — a floor for the `feature-maturation-review` model (judgment-candidate per the spec), conservative default `unknown`, never an authority.

## 1. Over-block

- A job with a typo'd `thinkingMode` (legacy `jobs.json` or manifest) is now withheld at load with an error naming the field, the existing behaviour for any invalid field. A built-in template with an invalid value is reported by `installBuiltinJobs` and not installed. Intended.
- The ratchet can fail CI for a PR that adds a framework literal for a reason a reviewer would accept. The remedy is moving the branch into the adapter or a reviewed baseline edit; the lint message says so.
- If an `applied` entry cannot be found in the final tmux argv/env, no launch record is written. That never blocks the spawn; it shows up as an `error` evidence row. No legitimate launch is refused.

No other over-block identified.

## 2. Under-block

- The ratchet misses constants, concatenation and `startsWith` (stated in the script header). It is a floor.
- `applied` means "sent", not "honoured". A model that ignores `--effort` is invisible here; benefit is measured only by the separate pilot spec (`job-thinking-mode-pilot`).
- For `channel: env`, an identical value inherited from the server environment is not distinguished from one this launch set (out of scope per the spec).
- Corroboration of an argv entry checks for the value token (or a `key="value"` assignment) anywhere in the launch argv after the binary, not its exact flag pairing; the exact pairing is proved by the unit tests (T2, T3) and the e2e (T10).
- The graduation counter accepts any row with `truncated: true` as a legitimate missing launch, because the row has no per-field shed record (KNOWN LIMIT recorded in T12); T6 proves `launch` is shed only after the other optional fields.

## 3. Level-of-abstraction fit

Translation sits in each engine's builder, the existing per-engine seam, keyed by builder identity (no new framework-id literal anywhere: the ratchet total is 1130 before and after). The record is captured at the single tmux exec point of each lane, the only place where "what was spawned" is true. Version reading reuses the Claude retainer's version when it holds a non-null one, and otherwise probes the same retained binary that launched. No parallel gate is introduced.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface at runtime beyond the existing invalid-manifest refusal.

The launch record, the evidence rows and the graduation counter are signals. The only deterministic authorities are enum validation at load (same class as every other manifest field) and the CI ratchet (a build-time comparison, never a runtime action). Nothing here can stop a session from launching: record capture, evidence and the version probe are wrapped so a failure only loses the record.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The translate/clamp/pin choices are enumerable-domain invariants (spec "Decision points touched"). The one judgment point, the mechanism graduation verdict, is declared in the spec with its floor (the counter in `launchIntentEvidence.ts`), its arbiter (`feature-maturation-review`) and its conservative default (not graduated); the counter returns `unknown`, never `pass`, on too little evidence.

## 5. Interactions

- **Topic-profile `thinkingMode` / `effort` (interactive builder):** same mapping functions as before, now via the translators; argv/env with the field absent are byte-identical (T1 goldens for both builders × 5 engines), and the existing `frameworkSessionLaunch-thinkingMode` / `-effort` suites pass unchanged. The interactive builder's return type gains `applied`/`dropped`; existing callers read only `argv`/`envOverrides`.
- **`PipeSessionSpawner` and other `buildHeadlessLaunch` callers:** pass no `thinkingMode`, so they get empty arrays and an unchanged argv.
- **Codex rate-limit model swap, route fallback (D4), pinned-account env:** all happen before the tmux call, so the record describes what launched (T3 fallback cases, T9 JobModelRoute case).
- **The 2,048-byte row cap:** `launch` is shed last among optional fields (T6); `recordLaunchVersion` is a no-op on a shed row (T5).
- **Completion matching / `activeRunIds`:** `recordStart` runs at the same point as before; the probe is started after it and never awaited (T5 deferred-probe cases, including completion landing first).
- **Script, triage and spawn-error runs:** they do not pass the field and carry no `launch` or evidence (T9).
- **Triage spawn path (`spawnProjectedSession`) and topic sessions:** their launch commands are unchanged. Because triage and other non-job headless spawns go through `spawnSession`, their in-memory `Session` object now also carries `launch`, and a `launchBinaries` entry is kept for them (bounded at 512, FIFO). Only the scheduler's main path writes a run-history record or probes the version.
- **Double-fire:** none; each main-path run writes exactly one `fired` row (T9).

## 6. External surfaces

- `GET /jobs/:slug/history` rows gain an optional `launch` object, frozen per spec D5; enums are additive-only and readers must tolerate unknown values (T9 unknown-enum case). The console history reader ignores it (T13). The dashboard adds no presentation of it.
- `logs/feature-evidence.jsonl` gains `jobs.launchIntent` rows (`fired` per main-path run, `error` when no record).
- Job definitions accept `thinkingMode`. An older instar ignores it in `jobs.json` (unknown keys are not validated there) and the job runs at the engine default; an older agentmd loader withholds a job whose frontmatter carries the key (closed frontmatter set); an older peer refuses a portable bundle carrying it (`unknown-manifest-field`). All fail closed or degrade to today's default.
- The CLAUDE.md template gains one Job Scheduler bullet; existing agents get the identical line via `migrateClaudeMd`, sniffed on the phrase "a job can set `thinkingMode`" (T11).
- Each recorded launch may run one extra `<bin> --version` child (2 s cap, SIGKILL on timeout, no shell, neutral temp cwd, auto-updater suppressed), at most one per binary at a time. A real version is cached for an hour, keyed on the binary's resolved path, size and mtime; a bare command name (`codex`, `pi`) is resolved on PATH first so it gets a key. A probe that returns no parseable version is not cached, so an engine whose `--version` prints no semver probes once per run. When the Claude retainer already knows the version no child runs.
- No operator-facing actions are added.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## Framework generality

The change routes through the framework abstraction rather than around it. The job carries one neutral `thinkingMode`; `frameworkSessionLaunch.ts` hands it to a per-engine translator that both launch builders share, and no caller branches on the engine name (the new framework-name ratchet holds the count of engine-id literals outside the adapters at 1,130, the same as before).

- **claude-code:** `--effort <level>`, or `MAX_THINKING_TOKENS=0` (env) for `off`. A direct effort pin wins and is recorded as `overridden-by-effort-pin`.
- **codex-cli:** `-c model_reasoning_effort="<level>"` placed before `-m <model> <prompt>`, with the existing `off`→`low` and `max`→`xhigh` remap; the record keeps both what was asked for and what was sent.
- **gemini-cli, pi, grok:** no reasoning-effort control today, so the request is recorded as `dropped: not-supported` and the launch is unchanged. A future engine gains the field by adding one translator; until it does, it gets the same honest `not-supported` record rather than a guessed flag.
- **Launch record:** built from the final tmux argument list on both the headless and rerouted-interactive lanes, so it is engine-neutral; the version probe runs `<bin> --version` for whatever binary launched.
- The golden test locks today's argv for every engine with the field absent, so no engine's default launch changes.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Job field:** part of the job definition, which is machine-local today and moves between machines only through the approval-gated private job transfer; the field travels with it on this version or later (older peers fail closed, above).
- **Launch record:** inherited surface, posture unchanged — a sub-field of the machine-local `JobRun` row (`{stateDir}/ledger/job-runs.jsonl`, read locally by `/jobs/:slug/history`). The pool-wide read gap is pre-existing and filed as fb-ca7635e0-b76.
- **Version cache and launch-binary map:** in-process memory, machine-local by design (they describe this machine's binaries).
- **Evidence rows:** machine-local feature-evidence log, as every other feature.
- No user-facing notices, no URLs, no durable state that could strand on topic transfer. No status surface (`/status`, `/health`, `/capabilities`, `/channels`) changes. `Session.launch` is a new optional field on headless and rerouted session objects, so any route that serialises a session can now include it; it carries no secret (engine flags and a version only).

## 8. Rollback cost

Pure code change: revert and ship a patch. The default argv/env is byte-identical to before (T1), so reverting changes nothing for jobs without the field. Rows already written with `launch` stay readable by old code, which ignores unknown keys. Before a downgrade, remove `thinkingMode` from any job (an older agentmd loader withholds a job whose frontmatter carries it; in `jobs.json` it is ignored and the job runs at the default). The CLAUDE.md bullet left on agents is descriptive text only.

## Conclusion

The build follows the converged spec and the frozen acceptance tests without changing either. Changes from the pre-build draft: the translation was factored into shared translators so the graduation counter can check native values without new framework literals; record capture corroborates every `applied` entry against the final tmux arguments instead of trusting the builder; and the downgrade wording was corrected (legacy loaders ignore unknown keys, the agentmd frontmatter set withholds). `writeUserTemplate` stays excluded because agentmd frontmatter is decorative (the manifest is the authority), and `addJob` (`instar job add`, `src/commands/job.ts`) is excluded because it builds a new legacy entry from a fixed set of CLI flags with no `thinkingMode` flag; a job gains the field by editing its definition, which the loaders above validate. Clear to ship once the independent second pass concurs.

## Confinement note

Under `options.confinement` the CLI starts through `/usr/bin/env -i <allowlist>`, so the tmux `-e` flags never reach it. The record's env corroboration reads those allowlist pairs instead. `MAX_THINKING_TOKENS` is not on the allowlist, so a confined spawn with `thinkingMode: off` writes no launch record (honest absence, with a warning) rather than a false `applied`. No job reaches this path today: the scheduler passes `confinedTools`, not `confinement`.

## Second-pass review (if required)

**Reviewer:** GPT 6 Astra (codex, read-only, source access) and Fable 5.2 (claude -p, Read/Grep/Glob), each from a sealed brief, independently of the builder. Records: `docs/efforts/engine-optimization/step3/code-review/` in the agent home (astra.md, fable.md, astra-r2.md, astra-r3.md).

- **Round 1:** both CONCERN, no blockers. Fixed: built-in manifest `thinkingMode` lost on reinstall (both reviewers); bare PATH binary never cached, plus this artifact's cache claim (both); legacy `execute.type: script` rows counted as main-path runs (Astra); confined `env -i` spawn recording an env value the CLI never sees (Fable); a failed probe downgrading a known version (Fable nit); this artifact's triage and status-surface wording (Fable nits). Regression tests: `tests/unit/job-launch-review-fixes.test.ts`.
- **Declined, with reasons both reviewers' round-2 reader accepted:** `null` stays "absent" (topic profiles store a cleared pin as `null` and share the clamp); the CLAUDE.md insert is not gated on the Job Scheduler heading (frozen `job-launch-awareness` requires insertion without it); the ratchet offset (frozen T8 requires baseline == real counts).
- **Round 2 (Astra):** CONCERN on one point: the PATH lookup took the first existing file, not the first executable one. Fixed (`isExecutable`, default `X_OK` + regular file) with a test.
- **Round 3 (Astra, narrow):** **Concur.** "The PATH fix addresses the reported mismatch ... No regression found in these changes."

Left as is: `LaunchThinkingMode` mirrors `ThinkingMode` (documented at its definition) to keep `types.ts` free of an import from `topicProfileValidation`.

## Class-Closure Declaration

- **unbounded-self-action — closure: n/a.** This is a one-shot per job launch, not a self-triggered loop. After a run the scheduler was already starting, it runs one bounded `--version` probe (2 s cap, SIGKILL, at most one in flight per binary, real versions cached for an hour). Nothing retries or re-triggers the probe, and the probe never starts a session.

## Evidence pointers

- Frozen tests: `tests/unit/job-launch-*.test.ts`, `tests/unit/JobRunHistory-launch-cap.test.ts`, `tests/unit/framework-id-ratchet.test.ts`, `tests/unit/console-history-reader-unknown-keys.test.ts`, `tests/integration/job-launch-*.test.ts`, `tests/e2e/job-launch-lifecycle.test.ts` (snapshot sha256 c39426f4…), all green.
- Ratchet: `node scripts/lint-framework-name-ratchet.mjs` → 1130 literals across 148 files, equal to frozen main.
