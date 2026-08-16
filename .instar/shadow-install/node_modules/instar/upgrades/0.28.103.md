# NEXT — upcoming release notes

Entries here ship in the next release. Move them into the versioned upgrade
note (`upgrades/<version>.md`) at release-cut time.

---

### fix(monitoring): PromptGate token-burn — cache NO_PROMPT verdicts to stop idle-session re-classification loop

**What this fixes (plain English).** Every instar agent quietly watches its
own terminal output to detect when Claude Code is stuck at an interactive
prompt that only the user can answer. Part of that watcher uses Haiku to make
a final judgment call on output the simple regex filters can't classify. The
watcher was meant to make at most one of those Haiku calls per session every
5 minutes — but the rate-limit only kicked in *after* a real prompt was found.
For idle sessions sitting at the same "❯" output forever, the watcher kept
re-asking Haiku "is this session stuck?" every 5 seconds, got "no" every
time, and never updated the rate-limit. Across all agents on a single
machine, that was ~108,000 Haiku calls and ~3 billion tokens per day — more
than the rest of the machine's spend combined.

**What changes.** `InputDetector` now caches each NO_PROMPT verdict by a
SHA-256 fingerprint of the exact 20-line context the LLM saw. Same context
recurs → cache hit → no LLM call. Different context → cache miss → LLM is
consulted normally. Per-session cap of 32 fingerprints (FIFO eviction); cache
is cleared whenever input is sent to the session or the session is cleaned
up. Positive prompt detections are not cached (real prompts always get
fresh evaluation).

**Why this is safe.** Pure memoization in front of an existing LLM
authority — no new blocking surface, no new decision logic, no persistent
state. Worst-case failure mode is a wrong Haiku verdict on a specific
output snapshot being remembered for up to 32 subsequent outputs (mitigated
by FIFO eviction and `onInputSent` clearing). The cache is in-memory only,
disappears on restart, and the rollback is a two-file revert with no
migration cost. Side-effects review:
`upgrades/side-effects/prompt-gate-no-prompt-cache.md`. Signal-vs-authority
compliance: the LLM remains the authority; the cache only records its
previous output to avoid asking the same question twice. 7 new regression
tests pin the behavior (`tests/unit/PromptGate.test.ts`).

**Evidence.** Measurement before fix on 2026-05-15: 108,782 LLM calls /
3.03 billion tokens in 24h from the `InputDetector.llmDetect` path,
representing 73% of the machine's entire 24h token spend. Expected after
fix: one LLM call per distinct output snapshot per session, with idle
sessions producing one classification at most.

### feat(remediation): A47 — PrimaryAggregatorLease + failover (Tier-3 coordination scaffold)

New `src/remediation/PrimaryAggregatorLease.ts` implements the cross-machine primary-aggregator lease specified in SELF-HEALING-REMEDIATOR-V2-SPEC §A47 with the §A60 fencing-token hardening. Lease file at `.instar/remediation/primary-lease.json` carries `{leaderId, fencingToken (128-bit per A60), leaseExpiresAt, acquiredAt, hmac}` with the HMAC computed over a canonical-ordered body using the `audit-v1` leaf key from `RemediationKeyVault` (§A20). Default TTL 15 min, recommended renew cadence 5 min (§A47). Tiebreak on empty/expired state is deterministic by `sha256(machineId)` lex-min — the candidate with the lowest hash wins, so two simultaneous claims always converge to a single leader without coordination. Multi-write detection: if the on-disk fencing token diverges from the one this instance last issued, an entry is appended to `audit-anomaly.jsonl` and the instance fail-closes — `tryAcquire` and `renew` refuse until operator reset (per §A47 split-brain handling). Leader transitions emit `remediation.primary-aggregator.changed` on the lease's EventEmitter so consumers can drive role-switch. Forged lease files (HMAC mismatch) are treated as absent so the next `tryAcquire` re-establishes a signed lease without trusting the tamper. 14 unit tests cover empty-state acquire, held-by-other refusal, expired-lease takeover, renew extension, stolen-lease split-brain, fencing-token verify (positive + stale + wrong-length), deterministic tiebreak, forged-HMAC rejection, failover event, malformed-JSON handling, and split-brain reset. Coordination scaffold only — wiring into `NovelFailureReviewer` for actual cross-machine clustering ownership ships in a follow-up Tier-3 PR.

### feat(remediation): W-4 — db-corruption runbook + SemanticMemory.invokeFromRemediator (Tier-2)

New `src/remediation/runbooks/db-corruption.ts` wraps the existing SemanticMemory corruption-recovery surface so the Remediator can dispatch corruption events through the orchestrated path. Surface entry point `SemanticMemory.invokeFromRemediator(ctx)` re-opens the store (which runs integrity_check + probe-read + auto-quarantine + JSONL rebuild on detection) and returns a structured result. Per SELF-HEALING-REMEDIATOR-V2-SPEC §A9, verify asserts durability (`db.mode === 'durable'` AND `pragma integrity_check === 'ok'`) — not just liveness — so a future in-memory fallback is flagged `verify-failed` rather than passing silently. §A34 surface-alignment precondition satisfied: corruption-recovery is live on main (SemanticMemory.open() lines 178-243). The legacy in-line entry point inside `open()` stays unchanged as the CLI-path safety net. Prefilter excludes `'free-text'` per §A6; runbook is `essential: true` with `blastRadius: 'machine'` per §A36. 29 new unit tests pass.

### feat(remediation): W-3 — messaging-delivery-failed runbook + DeliveryRetryManager.runRecoveryCycle

New Tier-2 wrapper PR. `DeliveryRetryManager` gains two additive public methods per SELF-HEALING-REMEDIATOR-V2-SPEC §A34 R3 surface-alignment: `runRecoveryCycle()` (idempotent against the running 15s timer via a shared in-flight latch) and `invokeFromRemediator(ctx)` (Remediator surface entry-point returning ExecutionResult). The legacy timer-driven `tick()` is unchanged — same behavior, same return shape, plus an optional `skipped:true` marker when the latch short-circuits a concurrent caller. New `src/remediation/runbooks/messaging-delivery-failed.ts` runbook fires on `DELIVERY_FAILURE | TELEGRAM_429 | TELEGRAM_500` with structured provenance (§A6 — no free-text); priority 80; blastRadius `process`; essential `false` (messaging downtime is recoverable via the standard timer cadence, §A36 forbids essential=true on non-machine radius). Verify is a durable assertion per §A9 — queries the on-disk inbox and asserts ALL queued/undelivered messages have drained, not just one. 27 new tests (16 runbook + 11 manager) cover idempotence-against-timer (both directions), latch reset after cycle, durable-vs-live verify, end-to-end dispatch on TELEGRAM_429, and verify-failed audit trail when messages remain stuck.

### test(server): bearer-token auth verification on jobs endpoints

New integration test pins the existing `authMiddleware` gate on the four Phase 4 jobs endpoints (`/jobs/migration-status`, `/jobs/migration-confirm`, `/jobs/migration-abandon`, `/jobs/reconcile`). 15 cases cover unauthenticated, wrong-token, off-by-one near-miss, malformed header, non-Bearer scheme, and authenticated paths. Asserts INSTAR-JOBS-AS-AGENTMD spec §Decision Points "Dashboard write authorization — bearer auth extended to job-edit endpoints." Auth was already in place via global middleware; this test pins the property so a future refactor cannot weaken it silently.
### feat(scheduler): disabledAtBodyHash drift-detection helpers

New `src/scheduler/DisabledBodyDrift.ts` ships `bodyDriftedSinceDisable()`, `listDriftedDisabledSlugs()`, `stampDisabledAtBodyHash()`, `clearDisabledAtBodyHash()`. Surfaces "instar default has changed since you disabled it" indicators per INSTAR-JOBS-AS-AGENTMD spec §Dashboard UX. Reuses the same `hashBody()` from `AgentMdLockFile.ts` so disable-time hash semantics match lock-file body-hash semantics exactly. Pure helpers — Dashboard UI rewrite is the future consumer. 15 unit tests pass.
### feat(release): drift classifier — batched Haiku call populates significantChanges

New `scripts/classify-default-drift.mjs` is the release-time drift classifier per INSTAR-JOBS-AS-AGENTMD spec §Drift Classifier. Walks the templates, runs `git show` to diff against the previous release, calls Anthropic Haiku ONCE with all diffs in a single prompt, parses the strict-output regex, and writes `significantChanges: [...]` into `dist/jobs/instar.lock.json`. Injection-resistance per spec: classifier sees diffs only, never full body content; output is sort-order only, never suppression. When `ANTHROPIC_API_KEY` is absent (every build today), the script skips the LLM call and writes an empty array — release builds never fail because of classifier issues. 5 unit tests pass. To enable production classification: add `ANTHROPIC_API_KEY` to GHA Secrets.

### feat(scheduler): agentmd two-rename atomic save helper

New `src/scheduler/AgentMdAtomicSave.ts` ships the canonical "md-first, manifest-last" two-rename commit sequence per INSTAR-JOBS-AS-AGENTMD spec §Design Principle 2. SIGKILL between rename A (body) and rename B (manifest) leaves a consistent strictly-progressed state. The helper returns structured failure info for each stage so a Phase 4 Dashboard UI consumer can drive recovery. Companion `listStagedNewFiles()` + `discardStagedFile()` are sized for the future reconcile() boot lifecycle. 8 unit tests pass. No caller wired yet — Phase 4 Dashboard UI rewrite is the consumer.
### feat(scheduler): reconcile() boot lifecycle + GET /jobs/reconcile endpoint

New `src/scheduler/AgentMdReconcile.ts` exports `reconcileAgentMdTree()` — boot-time consistency check that surfaces five finding kinds per INSTAR-JOBS-AS-AGENTMD spec §Runtime: orphan manifests, shadow .md files, missing-from-jobs.json entries, staged .new files (from interrupted atomic saves), and case-collisions. New `GET /jobs/reconcile` HTTP endpoint returns the structured report for Dashboard Issues-card consumption. 10 unit tests. Pure function — no auto-remediation; the operator decides what to do via Dashboard actions.
### test(scheduler): 200-job loader cold/warm boot perf benchmark

New integration test asserts INSTAR-JOBS-AS-AGENTMD spec §Performance Budgets at 200 jobs: cold-boot <1500ms, warm-boot <500ms. Fixture generated deterministically at test-setup time (no fixture files committed to the repo). Measured times logged to stdout for CI runner debuggability. Currently observed: cold ~15ms, warm ~16ms — orders of magnitude under budget; spec's ceilings give substantial headroom for slower CI hardware.

### fix(server): File Viewer extends never-editable to .instar/jobs/instar/

The Dashboard file editor's never-editable list now includes `.instar/jobs/instar/`. Per INSTAR-JOBS-AS-AGENTMD spec §Decision Points: that namespace is owned by the update process and any direct edit would (a) be overwritten on next update and (b) break the body-hash verification. Operators who want to customize a shipped default use the override flow (fork to `.instar/jobs/user/`). The CLAUDE.md doc string emitted by PostUpdateMigrator is updated to list the new entry alongside `.claude/hooks/`, `.claude/scripts/`, `node_modules/`. One new e2e test case in `tests/e2e/file-viewer-e2e.test.ts`.
### feat(scheduler): migration telemetry to job-runs.jsonl (Seamless Migration Guarantee invariant 8)

New `src/scheduler/MigrationLedger.ts` writes a single `migration.completed` or `migration.aborted` event per migrator run to `.instar/ledger/job-runs.jsonl`. `PostUpdateMigrator.autoMigrateLegacyJobsJson` emits the event on every terminal path (success, jobsMigrate abort, thrown exception). The event records per-entry outcomes (normalized to `migrated | forked | renamed | skipped | failed | deferred-in-flight`), backup path, instarVersion, and trigger. `findCompletedFor(stateDir, version)` is the canonical signal for "did migration finish for this release" — usable by the release-cut gate when it ships. Co-locates with the existing JobRun ledger via a `kind` discriminator field; non-migration consumers ignore the new rows. 8 unit tests pass.

### test(release): npm-pack smoke test for shipped templates + bundled public key

New integration test asserts the published tarball contains ≥14 prompt-type default templates, the source-tree and dist/-copied release public keys, and either a real signed lock-file or a clean absence (no malformed placeholders). Closes the INSTAR-JOBS-AS-AGENTMD spec §Security Model threat row "Build pipeline: source-tree templates not packaged."

### test(scheduler): frontmatter interpolation breakout test

New unit test asserts that `JobScheduler.buildPrompt()` for agentmd jobs does NOT interpolate any frontmatter field into the prompt. Six cases cover shell injection, template injection, prompt injection, null-byte/control characters, body-verbatim presence, and slug regex defense-in-depth. Per INSTAR-JOBS-AS-AGENTMD spec §Security Model "Frontmatter-field interpolation breakout" threat row. The structural defense already exists in code; this test pins it so a future refactor cannot introduce interpolation silently.

### feat(scheduler): runtime invariant gate for legacy-jobs.json auto-migration

`PostUpdateMigrator.autoMigrateLegacyJobsJson` now re-verifies Seamless Migration Guarantee invariants 1, 2, 4 against the staged state AFTER `jobsMigrate` completes but BEFORE the auto-migration is considered final. Per spec §Gate wiring. Any verification failure triggers a fail-closed rollback via `jobsMigrate({ abandon: true })` (invariant 9). The migrator surfaces the failure to the update report so the operator sees what fired.

New module `src/scheduler/MigrationInvariants.ts` exports `snapshotUserNamespace()`, `verifyMigrationInvariants()`, and `canonicalScheduleHash()`. 14 unit tests cover every invariant pass/fail/skip path. Invariant 6 (in-flight protection) is structurally satisfied at update-apply time (no jobs run mid-update) and is deliberately NOT wired here — that needs `JobScheduler.activeRuns()` on the agentmd path, follow-up work.

### feat(server): Phase 4 — Dashboard migration endpoints for jobs-as-agentmd

Three new HTTP endpoints surface the migration state so the Dashboard frontend can render confirm / abandon buttons:

- `GET /jobs/migration-status` — returns `{ hasLegacyJobsJson, hasMigrationComplete, hasMigrationAbandoned, canConfirm, canAbandon, scheduleEntryCount }`.
- `POST /jobs/migration-confirm` — writes `.instar/jobs/.migration-complete.json`. The release-cut gate consumes this marker to allow `jobs.json` deletion. Refuses when the abandonment marker is present (operator must re-run migrate first).
- `POST /jobs/migration-abandon` — invokes `jobsMigrate({ abandon: true })` to roll back.

This is the backend half of Phase 4. The Dashboard UI rewrite (Jobs tab, Issues card, drift digest, unfork action with backup, interactive three-choice prompt) lands as a follow-up multi-PR effort against these endpoints.

## What Changed

### feat(memory): Pre-compaction memory flush (OpenClaw import T1.1)

Adds an opt-in pre-compaction memory flush that saves durable facts to `.instar/memory/` files before Claude Code compacts the session context. The user-visible win: fewer "didn't I just tell you that?" moments after long conversations.

When Claude Code emits its `PreCompact` hook, instar reads the last 30 KB of the session transcript, calls the shared intelligence provider (subscription path, zero per-call cost on the default config) with a fact-extraction prompt, and writes up to 5 durable facts to per-fact files under `<projectDir>/.instar/memory/learning_precompact_*.md`. An audit entry goes to `<projectDir>/.instar/audit/pre-compaction-flush.jsonl` for every fire — success, skip, or error. Default `enabled: false`; opt in via `preCompactionFlush.enabled: true` in `.instar/config.json` after reviewing the audit log shape.

- New `src/core/PreCompactionFlush.ts` — single class for the full flush lifecycle.
- New 16-test unit suite at `tests/unit/PreCompactionFlush.test.ts` covering all 9 outcomes plus parsing variants, slug coercion, and audit shape.
- Wired into `src/commands/server.ts` as a second listener on the existing PreCompact event (the CompactionSentinel listener is unchanged).
- Spec: `docs/specs/OPENCLAW-IMPORT-PRE-COMPACTION-FLUSH-SPEC.md` + ELI16 companion + side-effects review at `upgrades/side-effects/openclaw-import-pre-compaction-flush.md`.

Driven by Telegram topic 9003 on 2026-05-13 (OpenClaw imports Round 2, T1.1).

### feat(memory): Pre-prompt memory recall (OpenClaw import T2.2)

Adds an opt-in bounded memory-recall pass that runs before every UserPromptSubmit. Imports OpenClaw's `before_prompt_build` hook pattern in shape: a typed primitive with cache, circuit breaker, and hard caps, wrapped behind Claude Code's UserPromptSubmit hook surface.

When you submit a prompt, the hook POSTs to `/internal/prompt-recall`, the server runs `PromptBuildRecall.recall()` against `SemanticMemory` (≤2 s, capped at 5 entries / 1200 chars), and the hook emits the result as a `<active_memory_recall>` block. Claude Code injects the block as additional context for the upcoming turn. Result: consistent grounding before every reply, replacing the patchwork of per-skill memory checks.

- New `src/core/PromptBuildRecall.ts` — pure class with cache + circuit breaker + result formatter.
- New `POST /internal/prompt-recall` route.
- New `.claude/hooks/instar/before-prompt-recall.js` — Claude Code UserPromptSubmit hook script. Operators copy into their agent's `.claude/hooks/instar/` and wire into `.claude/settings.json` per the ELI16 instructions.
- 15 unit tests in `tests/unit/PromptBuildRecall.test.ts` cover every `source` outcome (disabled / no-memory / fresh / empty / cached / circuit-open / timeout / error) plus cache TTL, circuit-breaker open/close lifecycle, and caps.
- Default `enabled: false`; opt in via `promptBuildRecall.enabled: true` in `.instar/config.json`.

Spec: `docs/specs/OPENCLAW-IMPORT-BEFORE-PROMPT-BUILD-SPEC.md` + ELI16 companion + side-effects review at `upgrades/side-effects/openclaw-import-before-prompt-build.md`.

Driven by Telegram topic 9003 on 2026-05-13 (OpenClaw imports Round 2, T2.2).

### feat(remediation): Tier-2 live-mode flip — DegradationReporter wired to Remediator (§A57)

This is the **Tier-2 live-mode** milestone PR per `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A57 ("Tier 2 unlocks live mode (silence on verified success per outcome matrix)"). The F-3 `setRemediator()` hook that has shipped unused since the foundation phase finally has a consumer.

New module `src/remediation/RemediatorBootstrap.ts` exposes a single async entry point `bootstrapRemediator({ stateDir, machineId, ... })` that constructs the full Tier-2 dispatch graph and registers the runbooks present on main:

- F-1 `RemediationKeyVault` via the 4-backend probe (returns `{disabled, reason: 'no-secret-backend'}` if no backend is configured — operator continues with the legacy alert path).
- F-4 `MachineLock`, `IntentJournal`, `AuditWriter` (with an audit-token verifier wired against the vault's audit-context leaf).
- F-5 `TrustElevationSource` with both `TelegramApprovalChannel` and `CliApprovalChannel` so A53's different-kind second-channel rule is structurally satisfiable; primary channel is configurable.
- F-8 `Remediator` with all the above injected.
- Registers `nodeAbiMismatchRunbook` (W-1) and `messagingDeliveryFailedRunbook` (W-3) — the wrapper PRs that are on main today. Logs and skips W-2 supervisor-preflight and W-4 db-corruption — those wrappers haven't merged yet; bootstrap will pick them up when they land.

`src/commands/server.ts` calls the bootstrap after `degradationReporter.connectDownstream()` IFF `config.remediator?.enabled === true`. **Default is FALSE** — even with all wiring in place, the Remediator stays observe-only until each operator explicitly flips the flag. The in-line healers (`NativeModuleHealer.openWithHeal`, supervisor `preflightSelfHeal`, `DeliveryRetryManager.tick()`) remain the safety net regardless of Remediator state, exactly as before.

One-line type widening on `src/monitoring/DegradationReporter.ts`: `RemediatorLike.dispatch` returns `Promise<unknown>` instead of `Promise<void>` so the real F-8 `Remediator.dispatch()` (which returns `Promise<DispatchOutcome>`) typechecks at the integration point. Runtime semantics unchanged — the reporter never inspected the dispatch result; the audit log is the canonical record.

16 new tests: `tests/unit/RemediatorBootstrap.test.ts` (12 — disabled cases, full wiring, runbook registration assertions, A6/A36 validation propagation, internal helpers); `tests/integration/remediator-live-mode.test.ts` (4 — matching event → verified-healthy audit entry; non-matching → no-matching-runbook; legacy alert path preserved when flag false; W-1 prefilter structural assertion).

Operators opt in by adding `"remediator": {"enabled": true}` to `config.json`. The rollout is staged by design: each operator chooses when to flip the flag.

Side-effects review: `upgrades/side-effects/tier2-degradation-reporter-live-wire.md`.


### feat(remediation): W-2 — supervisor-preflight runbook

Wraps the existing `ServerSupervisor.preflightSelfHeal` (private, multi-step) as a single ApprovedRunbook (§A34 R3). Adds public `invokeFromRemediator(ctx)` entry point that verifies the capability-context HMAC and delegates to the existing private preflight. Legacy entry point unchanged.

- `src/remediation/runbooks/supervisor-preflight.ts`: id `supervisor-preflight`, priority 90, surface `supervisor`. Matches `BIND_FAILURE | CRASH_LOOP | SUPERVISOR_DEGRADED` with structured provenance (free-text refused per §A6). Verify is the durable §A9 assertion — lifeline state.json exists + reports healthy. blastRadius `machine`, essential `true` (§A36).
- 12 unit tests across `tests/unit/runbooks/supervisor-preflight.test.ts` and `tests/unit/ServerSupervisor-invokeFromRemediator.test.ts`.

A15 lag note: F-6 (supervisor handshake) merged today (#205). W-2 ships behind a `wrappers-active-after` config flag defaulting to false until F-6's 7-day seasoning passes.

Side-effects review: `upgrades/side-effects/w2-supervisor-preflight-runbook.md`.

### feat(remediation): F-8 rest — capability-token + probe-source + trust-elevation enforcement (Tier-2)

Completes F-8 from `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` (§A3, §A23, §A40, §A42, §A52, §A57 Tier-2 carve-outs). The Tier-1 Remediator skeleton from PR #201 deferred enforcement; this PR wires it.

New module `src/remediation/RemediationContext.ts` — exports `signRemediationContext(ctx, keyVault)` and `verifyRemediationContext(ctx, keyVault)`. The signed body covers `{attemptId, runbookId, expiresAt, monotonicDeadline}` via HMAC-SHA256 against the per-runbook capability leaf (F-1 `keyVault.deriveLeafKey('capability', runbookId)`). Verification uses `crypto.timingSafeEqual` so the surface side has no timing channel on the comparison. Forging a ctx for runbook A using a legitimately issued ctx for runbook B fails because the verify recomputes the leaf from `ctx.runbookId`.

Extension on `src/remediation/Remediator.ts`:
- `RemediatorOptions` adds `trustSource?`, `serverSupervisor?`, `probeSourceRegistry?` — all optional, so existing Tier-1 tests continue to work unchanged.
- `Remediator` now `implements RegisteredRemediator`: `getCapabilityLeafKey()`, `onRestartComplete()`, plus a new `requestPlannedRestart()` that signs the payload with the capability leaf and hands to `supervisor.handleRestartRequested()` (F-6 wire path).
- Constructor calls `supervisor.registerRemediator(this)` when wired so the handshake file is written before any restart-requested can fire.
- New `canTransition(runbookId, transition, context)` method consults `trustSource.canTransition()` when wired; falls back to `{allowed: true, reason: 'no-trust-source-wired'}` when unset (Tier-1 backward compat).
- `dispatch()` signs the issued `RemediationContext` via `signRemediationContext()` so surfaces can verify §A3 capability.
- `dispatch()` now enforces §A40 + §A52 for `provenance: 'probe-id'` events when a `probeSourceRegistry` is wired: unsigned envelope → audit projection records `probe-event-unsigned`; bad signature → `probe-signature-invalid`; out-of-scope subsystem → `probe-subsystem-out-of-scope`. None of these dispatch a runbook.
- New exports: `ProbeSourceRegistry` interface, `ProbeSignatureEnvelope` type, `canonicalProbeEnvelopeBody()` helper, `DefaultProbeSourceRegistry` impl backed by keyVault.

Extension on `src/memory/NativeModuleHealer.ts`:
- `invokeFromRemediator(ctx, keyVault?)` — new optional second arg. When wired AND `ctx.hmac` is present, verifies the capability HMAC at entry. Invalid → falls back to in-line legacy heal path (via existing `healBetterSqlite3()`) with `remediation.surface.invalid-context` warning and `details.invalidContext: true` on the result. When `keyVault` is unwired (existing W-1 callers), the legacy behavior is unchanged.
- `RemediatorInvocationContext` extended with optional `hmac` + `expiresAt` fields (structurally compatible with the Remediator's `RemediationContext`).
- New optional `InvocationContextKeyVault` type for the structural dep — `src/memory/*` still doesn't import `src/remediation/*` at runtime.

Extension on `src/monitoring/DegradationReporter.ts`:
- `NormalizedDegradationEvent` adds optional `source.probeSignature` carrying the §A40 envelope. Additive; legacy emit-sites + non-probe provenances leave the field unset.

New module `src/monitoring/probes/__shared.ts` — exports `ProbeVerifyScope` type, `readVerifyScope()` helper, and `subsystemInScope()` predicate for the §A52 scope-binding contract.

Extension on `src/monitoring/probes/LifelineProbe.ts`:
- Exports `__verifyScope = ['lifeline'] as const satisfies ProbeVerifyScope`. F-8-rest smoke-test migration; full fleet migration is Tier-3 work.

21 new tests across `tests/unit/RemediationContext.test.ts` (7), `tests/unit/Remediator-enforcement.test.ts` (10), `tests/unit/NativeModuleHealer-context-enforcement.test.ts` (4). All 57 pre-existing Tier-2 / W-1 / Tier-1 tests pass unchanged.

Side-effects review: `upgrades/side-effects/f8-rest-enforcement.md`.

### feat(core): F-7 — PostUpdateMigrator atomic-step + announceOnce primitives (Tier-2)

Ships F-7 from `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` (§R1 Upgrade invariants + §A35 backup/sync wiring + §A50 hook-shape corrections + §A57 Tier-2). Two new primitives plus the A35 const-literal hook-shape changes.

New module `src/core/MigratorStepEngine.ts`:

- **`MigratorStepEngine`** — register named, idempotent atomic steps with a semver `version: string`. `runPendingSteps(fromVersion, toVersion)` executes every step whose `version <= toVersion` and isn't yet recorded. Ledger at `<stateDir>/migrator-steps-completed.json` keyed by `<version>:<step-name>`. Failed steps record `outcome: 'failed'` and do NOT roll back prior steps or block subsequent steps — each step is atomic and self-contained per spec. Atomic temp-file → fsync → rename writes.
- **`AnnouncementManager`** — `announceOnce(announcementId, message, channel)` returns `true` if announced now, `false` if already shown. Ledger at `<stateDir>/announcements-shown.json` keyed by announcementId. Ledger is recorded BEFORE the sink fires so a flaky sink cannot cause duplicate emission. Default sink writes to stderr; callers can pass a Telegram/dashboard sink.

Extension on `src/core/PostUpdateMigrator.ts`: new `registerStep(step)` + async `runPendingSteps(from, to)` methods delegate to a lazy `MigratorStepEngine`. The existing `MigratorConfig` constructor + all 15 existing `migrate*` methods + `migrate()` orchestrator are unchanged — F-7 is strictly additive.

A35 hook-shape changes:

- `src/core/GitStateManager.ts` — `DEFAULT_GITIGNORE` const literal now contains the five remediation runtime path globs (`remediation/system-reviewer-state-*.json`, `remediation/inbox-*.jsonl`, `remediation/audit-projection-*.jsonl`, `remediation/cross-process-attempts-*.jsonl`, `remediation/llm-raw-*.jsonl`). Exported `REMEDIATION_GITIGNORE_ENTRIES` as the canonical list. Fresh `instar git init` writes these out; existing `.gitignore` files are unchanged (the F-7 atomic step is responsible for patching them post-update).
- `src/core/BackupManager.ts` — new exported const `REMEDIATION_EXCLUDED_PATH_PREFIXES` (the five remediation path prefixes). New optional 5th constructor arg `isRemediationEnabled?: () => boolean` parallels the existing `isIntegratedBeingEnabled` gate. When the gate returns true, the prefixes drop any user-added `includeFiles` entry whose path starts with a remediation prefix from the resolved include list. When false/absent (the default for every existing caller), behavior is identical to pre-F-7. No new plugin/register API per §A50.

18 new tests across `tests/unit/PostUpdateMigrator-atomicStep.test.ts` (8), `tests/unit/AnnouncementManager.test.ts` (5), `tests/unit/PostUpdateMigrator-a35-remediationPaths.test.ts` (5). Covers: step runs once and records completion; subsequent runs skip; failed step records failure and doesn't block other steps; future-version step skipped without ledger entry; state persists across instances; semver compare; announceOnce true-then-false; independent ids; persistence; sink-throw does not cause re-emission; input validation; remediation entries in `DEFAULT_GITIGNORE`; exclusion-prefix gate ON/OFF/absent. All 76 pre-existing `PostUpdateMigrator-*` tests and 47 `BackupManager*` tests pass unchanged.

No production wiring yet. Tier-2 surfaces (W-2..W-4, S-1..S-3) will register their own steps via `migrator.registerStep(...)` and surface migration outcomes via `announcer.announceOnce(...)`.

Side-effects review: `upgrades/side-effects/f7-post-update-migrator-atomic-step.md`.

### feat(remediation): F-5 — TrustElevationSource + AutonomyProfileLevel wiring (Tier-2 foundation)

First Tier-2 foundation module from `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` (Trust elevation policy section + amendments A11, A22, A25, A41, A53, A57, A59). Three new modules under `src/remediation/`:

- `src/remediation/TrustElevationSource.ts` — authoritative gate for runbook lifecycle transitions. Implements the asymmetric trust-elevation table: pessimistic-quarantine always-allowed (`live→quarantined` succeeds at any profile), `collaborative` trust minimum for upward transitions, 48h fresh-trace + 1-week dry-run history for `registered→live`, two-distinct-kind-channel rule for essential `quarantined→live` (A53), and source-only refusal for `proposal→registered`, `live→deprecated`, `deprecated→removed`. Exposes `canTransition(runbookId, transition, context)` returning `{allowed, reason}` and `requireSecondChannel({runbookId, essential})` for A53 enforcement. Re-exports the canonical `AutonomyProfileLevel` from `src/core/types.ts` so the remediator side has a single import path for trust policy.
- `src/remediation/channels/TelegramApprovalChannel.ts` — F-5 stub `TrustedApprovalChannel`. Exposes the shape the real A41 Telegram-countersignature verification will plug into; deterministic seeded-map for test fixtures. Channel `kind: 'telegram'`.
- `src/remediation/channels/CliApprovalChannel.ts` — F-5 stub `TrustedApprovalChannel` for the `instar doctor confirm-unquarantine` signed-CLI second-factor path (A53 option 1). Channel `kind: 'cli'`. The kind-distinct pair `(telegram, cli)` is the minimal A53-compliant essential-runbook configuration.

No consumers in this PR. The dispatcher (F-8 Tier-2 wiring) and the un-quarantine endpoint (`POST /remediation/unquarantine/:runbookId` per A25) consume F-5 in follow-up work. 25 unit tests in `tests/unit/TrustElevationSource.test.ts` cover every row of the trust-elevation table plus the stub-channel verification fixtures.

Side-effects review: `upgrades/side-effects/f5-trust-elevation-source.md`.

### feat(remediation): F-6 — ServerSupervisor ↔ Remediator handshake (Tier-2)

Extends `src/lifeline/ServerSupervisor.ts` with the HMAC-signed Remediator handshake described in `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` (§A15 partial-upgrade rule, carried-forward §Supervisor coordination) and `docs/specs/SELF-HEALING-REMEDIATOR-V3-CONSOLIDATED-SPEC.md` (§3 state-file taxonomy, §9 Tier-2 sequencing). After this PR ages ≥ 7 days on main (A15 lag rule), wrapper PRs W-2..W-4 can begin to merge.

New public surface on `ServerSupervisor`:

- Static `HANDSHAKE_PROTOCOL_VERSION = 1`.
- Types: `RestartRequestedPayload`, `RestartRequestedReply`, `RegisteredRemediator`.
- `registerRemediator(remediator)` — writes `<stateDir>/state/supervisor-handshake.json` (`{version, supervisorBuildId, writtenAt}`) so cross-process Remediators can detect the supervisor's protocol version without an in-process handle.
- `handleRestartRequested(payload)` — verifies in order: registration → required-field shape → handshake-version equality (A15) → 5-minute staleness window → blastRadius allowlist (`process | machine` only; `fleet` is refused for Tier-2) → HMAC via `crypto.timingSafeEqual` against the Remediator's capability-context leaf key (F-1 RemediationKeyVault). On accept, tracks the request and initiates the existing `performGracefulRestart` cycle.
- Pending-request notification fires `remediator.onRestartComplete({requestId})` on the next healthy tick after a serverRestarting → healthy transition (idempotent).
- Exported helper `canonicalRestartRequestedBody(payload)` — deterministic length-prefixed byte serialization that both sides use as HMAC input. Co-located in the supervisor file so the wire format has one canonical owner.

The existing `private preflightSelfHeal()` is unchanged in behavior (W-2 will wrap it). The existing `restart-requested.json` file path is unchanged in this PR — the in-process handshake is the Tier-2 canonical surface; HMAC migration for the file shape is deferred to a follow-up alongside the AutoUpdater path.

9 new unit tests in `tests/unit/ServerSupervisor-handshake.test.ts`: accept on valid HMAC; reject forged HMAC; reject stale request (> 5 min); reject `blastRadius: 'fleet'`; reject handshake-version mismatch with the A15 message; `onRestartComplete` fires once after the healthy tick (and only once on subsequent ticks); reject when no Remediator registered; `supervisor-handshake.json` written on registration; reject malformed payload. Existing supervisor preflight + serverDown-rate-limit tests unaffected.

Side-effects review: `upgrades/side-effects/f6-supervisor-handshake.md`.

### feat(remediation): W-1 — node-abi-mismatch runbook + NativeModuleHealer.invokeFromRemediator (FINAL Tier-1 PR)

Ships the first dispatchable runbook for the F-8 Remediator and the matching surface entry-point per `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` (§A6, §A9, §A21, §A28, §A36, §A45, §A55, §A57). After this PR, Tier-1 is complete and the Remediator is dispatchable end-to-end via test fixtures.

Two new modules:

- `src/remediation/runbooks/node-abi-mismatch.ts` — first `ApprovedRunbook`. Matches `errorCode: 'NATIVE_MODULE_ABI_MISMATCH'` with `provenance ∈ {native-binding, subsystem-explicit}` (NOT `free-text` per §A6). `match()` narrows to better-sqlite3 specifically. `surfaceCallable` delegates to `NativeModuleHealer.invokeFromRemediator`. `verify()` opens an in-memory sqlite handle and runs `PRAGMA integrity_check`; returns the §A21 verified-healthy / verify-failed / verify-inconclusive taxonomy with probe error → inconclusive (never failed). Marked `essential: true` with `blastRadius: 'machine'` (§A36 validator accepts this).
- `src/memory/NativeModuleHealer.ts` extended — adds `invokeFromRemediator(ctx)` as a parallel entry point alongside the unchanged `openWithHeal` CLI safety net. Honours `ctx.abortSignal` and `ctx.monotonicDeadline`. Rebuilds via `npm rebuild --ignore-scripts --build-from-source better-sqlite3 --prefix <installPrefix>` (§A28 + §A45 — never bare `npm rebuild`, always pinned to a single package, always from source). Reads `package-lock.json`'s `resolved` URL + `integrity` hash pre-rebuild and records it on the result (§A45 secondary check). Computes sha256 of the rebuilt `.node` binary post-rebuild and emits `details.rebuiltBinarySha256` for §A28 cross-process binary-divergence detection. The legacy `healAttempted` once-per-process guard is shared with `openWithHeal` so the two entry points cannot both spawn a rebuild within one process lifetime (the §A2 lock-bound co-existence invariant at the process level).

Public exports added: `RemediatorInvocationContext`, `RemediatorExecutionResult` (structurally compatible with F-8's `RemediationContext` / `ExecutionResult`).

24 new unit tests across `tests/unit/runbooks/node-abi-mismatch.test.ts` (12) and `tests/unit/NativeModuleHealer-invokeFromRemediator.test.ts` (12). Covers: prefilter contains structured provenance only (§A6); registry validator accepts essential+machine (§A36); match() narrows to better-sqlite3; verify() returns each of the three §A21 outcomes; surfaceCallable wires to NativeModuleHealer; npm rebuild uses `--ignore-scripts` + `--build-from-source` + single-package name (§A28 + §A45); sha256 recorded on success (§A28); abort signal honoured; monotonic deadline respected; once-per-process guard short-circuits second invocation with previousOutcome; end-to-end Remediator.dispatch wires runbook → healer → verify and writes the expected audit-projection entries; legacy `openWithHeal` entry point unaffected.

No production wiring yet — `DegradationReporter.setRemediator()` is still uncalled. Tier-2 work plugs the dispatcher into the reporter pipeline.

Side-effects review: `upgrades/side-effects/w1-node-abi-mismatch-runbook.md`.

### feat(remediation): F-8 — Remediator orchestrator skeleton (Tier-1 subset)

Ships the Tier-1 subset of F-8 from `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` (§A2, §A4, §A6, §A21, §A36, §A57). New module `src/remediation/Remediator.ts` exposes the orchestrator class plus public types `ApprovedRunbook`, `RemediationContext`, `ExecutionResult`, `VerifyOutcome`, `BlastRadius`, `Reversibility`, `DispatchOutcome`.

`Remediator.registerRunbook()` enforces two registry-load-time gates:
- §A6: refuses any prefilter that includes `provenance: 'free-text'` (structured sources only).
- §A36: refuses `essential: true` unless `blastRadius === 'machine'`.

`Remediator.dispatch()` composes the F-1..F-4 primitives:
- Match candidate runbooks via `eventPrefilter` (errorCode + provenance) + `match()`; pick highest priority.
- Compute `tupleHash = sha256(runbookId + signatureHash)`, check existing in-flight locks (§A2 covered-by-inline detection).
- Acquire `MachineLock` (HMAC-signed via F-1 leaf key for the `inflight` context).
- Declare intent via `IntentJournal` BEFORE running the surface.
- Build a `RemediationContext` carrying `attemptId, runbookId, lockHandle, auditToken (F-1 audit-context leaf), abortSignal, expiresAt, monotonicDeadline`.
- Race `surfaceCallable + verify` against an `AbortController` timer (§A4 deadline enforcement); on timeout returns `aborted-deadline` and releases the lock.
- §A21 strict verify typing: probe error or verify-THROW maps to `verify-inconclusive`, never `verify-failed`.
- Audit-append via F-4 `AuditWriter` at every state transition.

Tier-2 carve-outs (deferred per A57): trust elevation source, probe authentication (A40/A52), surface-side capability-token HMAC enforcement (A3/A23/A42), supervisor handshake (A15), signed-manifest registry validation (A56/A66), child-process SIGTERM/SIGKILL escalation (W-1's concern).

No production consumer in this PR — the dispatcher is constructible but not yet wired into `DegradationReporter.setRemediator()`. W-1 (NativeModuleHealer wrapper) is the first caller.

12 new unit tests in `tests/unit/Remediator.test.ts` cover: register-valid, register-rejects-free-text (§A6), register-rejects-essential-on-non-machine (§A36), no-matching-runbook + audit entry, full success-path with lock+intent+verify+release, covered-by-inline (§A2) for pre-existing same-tuple lock, aborted-deadline (§A4) on hanging surface, verify-NEVER-called on surfaceCallable failure, verify-inconclusive distinct from verify-failed (§A21), verify-THROW → verify-inconclusive, audit entries land in `audit-projection-<machineId>.jsonl`, forged-token entries route to `audit-rejected.jsonl`.

Side-effects review: `upgrades/side-effects/f8-remediator-skeleton.md`.

### fix(security): API safety guard — subscription-by-default enforcement

`src/commands/server.ts` had one silent-fallback path that could engage billed Anthropic API mode without explicit user consent: if the Claude CLI was unavailable and `ANTHROPIC_API_KEY` happened to be set in the environment, instar would silently use the API "as a last resort." That trade-off ("degrading to heuristics is worse than using whatever LLM is available") encoded a values choice the principal rejects. Removed.

Selection logic moves to a new pure function `src/core/selectIntelligenceProvider.ts`. API mode now requires BOTH `intelligenceProvider: "anthropic-api"` AND `intelligenceProviderConfirmed: true` in config.json. Server startup with API mode active prints a visible yellow boxed billing banner. An `ANTHROPIC_API_KEY` in env without the two-flag opt-in is surfaced as a warning and explicitly ignored.

- New `src/core/selectIntelligenceProvider.ts` — pure selection function; 14 unit tests in `tests/unit/selectIntelligenceProvider.test.ts` exhaustively cover the selection table.
- `src/commands/server.ts` replaces the inline 70-line selection block (formerly lines 2050–2114) with a `selectIntelligenceProvider()` call plus warning/banner rendering.
- Spec: `docs/specs/API-SAFETY-GUARD-SPEC.md` + ELI16 companion at `API-SAFETY-GUARD-SPEC.eli16.md`. Side-effects review: `upgrades/side-effects/api-safety-guard.md`.

Driven by Telegram topic 9003 on 2026-05-13: "By default Instar should only run on subscription."

### F-1 — RemediationKeyVault (Tier-1 foundation for Self-Healing Remediator)

- **Adds** `src/remediation/RemediationKeyVault.ts` — per-context, per-scope HKDF-SHA256 leaf-key derivation with a 4-backend secret store (OS keychain, hardware enclave stub, cloud KMS stub, env-passphrase + AES-256-GCM flatfile).
- Per amendments A20, A23, A39, A42, A51, A54, A58, A62 of `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md`.
- **No runtime consumers yet.** F-2+ wires capability tokens, probe authentication, in-flight lockfiles, the cross-process attempt ledger, and the audit-token writer onto the leaf-key surface.

### feat(monitoring): F-3 — DegradationReporter normalization shim (Self-Healing Remediator v2 foundation)

Adds the F-3 milestone of the Self-Healing Remediator v2 foundation (per `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A5, §A33, §A50). `DegradationReporter` gains a back-compat shim that converts legacy `DegradationEvent` quintuples into a new `NormalizedDegradationEvent` (`{subsystem, errorCode, provenance, reason: {redacted, full}, timestamp, monotonicTs}`) using the F-2 `Redactor` and `ErrorCodeExtractor`. All ~103 legacy `.report(...)` emit sites continue to work unchanged; they normalize to `provenance: 'free-text'` and (per §A6) cannot match any runbook prefilter — they will route to `no-matching-runbook` once F-8 ships the Remediator dispatcher.

New surface on the reporter:
- `reportStructured(event)` — go-forward emit API for callers that already have a NormalizedDegradationEvent.
- `setRemediator(remediator)` — registration hook for the F-8 dispatcher (no consumer wired in this PR).
- `_normalize(legacy)` — pure transform exposed for testability.
- `_setRestartPending(true|false)` — supervisor-controlled flag that re-routes events to a durable JSONL queue at `<stateDir>/remediation/degradations-queue.jsonl` (1000 entries / 5 MiB cap, drop-and-counter on overflow per §A5).

New `scripts/lint-degradation-emit-sites.js` — warning-only catalogue of legacy vs structured emit sites. Exits 0 always; F-8 may upgrade to blocking once a deprecation timeline is agreed.

9 new unit tests appended to `tests/unit/degradation-reporter.test.ts` covering normalization, structured-emit provenance preservation, Remediator routing, backward compat, RestartPending enqueue/replay, queue-cap drop-counter, secret redaction, and errorCode extraction.

Side-effects review: `upgrades/side-effects/f3-degradation-reporter-shim.md`.

### feat(monitoring): F-2 — Redactor + ErrorCodeExtractor (Self-Healing Remediator v2 foundation)

Adds two foundation modules from the Self-Healing Remediator v2 spec (§A1 manifest, F-2): `src/monitoring/Redactor.ts` and `src/monitoring/ErrorCodeExtractor.ts`. The Redactor centralizes content sanitization (home-directory paths, bearer tokens, Telegram bot tokens, emails, UUIDs, long hex strings, IPv4/IPv6, and ≥6-digit numeric IDs). The ErrorCodeExtractor enforces the §A6 errorCode-provenance contract: returns `{code, provenance}` where provenance is `native-binding | probe-id | subsystem-explicit | free-text`, following a priority ladder. A static `isAllowedForRunbookMatch` predicate gives the runbook registry validator a single call to refuse matchers that would consume free-text-provenance events — the §A6 structural defense against attacker-shaped error-text. Neither module has any consumer in this PR; F-3 (DegradationReporter migration) and the W-* runbook wrappers wire them up in follow-up PRs. 46 new unit tests across `tests/unit/Redactor.test.ts` (25) and `tests/unit/ErrorCodeExtractor.test.ts` (21).

Side-effects review: `upgrades/side-effects/f2-redactor-errorcode-extractor.md`.


### feat(remediation): F-4 — MachineLock + IntentJournal + audit infrastructure

Foundation Tier-1 building blocks for the Self-Healing Remediator v2 (§R1 + A2/A24/A29/A42/A43/A46/A63). Four new modules under `src/remediation/`:

- `MachineLock.ts` — HMAC-protected in-flight lock with heartbeat sequence-number envelope, SIGKILL-grace stale-reclamation, and in-memory cache that re-stats every read (A46).
- `IntentJournal.ts` — Append-only intent-declaration log at `<stateDir>/remediation/intent-journal-<machineId>.jsonl`. Writes are O_APPEND + `fsync`.
- `audit/AuditWriter.ts` — Verified-append audit log. Forged-token entries route to `audit-rejected.jsonl` (A12); timestamp-regression entries also routed to rejected (A42). In-memory tail of last 1,000 entries (A29).
- `audit/AuditProjection.ts` — Read view exposing `Map<runbookId, AuditEntry[]>` for the churn detector and SystemReviewer clustering.

No surface wires into these primitives yet. The Remediator dispatcher (F-8), runbooks (W-*), and the primary-aggregator lease (A47 Tier-3) consume them in subsequent PRs.

Tests: 13 new cases across `tests/unit/MachineLock.test.ts`, `tests/unit/IntentJournal.test.ts`, `tests/unit/AuditWriter.test.ts`. Side-effects review: `upgrades/side-effects/f4-machine-locks-intent-journal-audit.md`.

### feat(instar-dev): ELI16 overview required for every approved spec

`/instar-dev`'s pre-commit gate and `/spec-converge`'s convergence-tag writer now both refuse to advance a spec that ships without a plain-English ELI16 overview. Topic 3079 on 2026-05-13 surfaced this directly: "I can't digest this without an ELI16 overview. That should be required for every spec."

This release adds a deterministic structural gate. The overview lives at `docs/specs/<slug>.eli16.md` by default (or any path declared via the spec's `eli16-overview:` frontmatter field) and must be at least 800 characters of real content. Stubs are refused. Both gates share `scripts/eli16-overview-check.mjs` so the rule is uniform across convergence-time and commit-time enforcement.

- New shared check module `scripts/eli16-overview-check.mjs` exposes `resolveEli16Path()` and `checkEli16Overview()` with `MIN_ELI16_CHARS = 800` floor.
- `scripts/instar-dev-precommit.js` adds Step 7 after spec-tag verification: refuses commit if the referenced spec has no ELI16 companion or the companion is a stub.
- `skills/spec-converge/scripts/write-convergence-tag.mjs` adds a pre-check before stamping `review-convergence`: refuses to mark a spec converged without an ELI16 companion.
- New template at `skills/instar-dev/templates/eli16-overview.md`. Updated `skills/instar-dev/SKILL.md` Phase 0 and `skills/spec-converge/SKILL.md` Phase 5.
- 11 new unit tests in `tests/unit/eli16-overview-check.test.ts` — all passing.

Side-effects review: `upgrades/side-effects/eli16-overview-required-gate.md`.

## Evidence

This release bundles several fix-tagged entries. Reproduction + observed before/after for each:

- **PromptGate token-burn (this release's headline fix).** Reproduced on 2026-05-15 by sampling `~/.claude/projects/<path>/*.jsonl` for sessions whose first user message contains `"analyzing terminal output from a Claude Code"` (the InputDetector LLM prompt). Across the active agents on a single machine: 108,782 LLM calls, ~3.03 billion tokens consumed in a single 24-hour window from this single code path — about 73% of the machine's total token spend. Hourly rate held at ~4,500 calls/hour. After fix: idle sessions produce at most one LLM call per distinct terminal-output snapshot per session, expected to reduce this path's call rate by roughly 50–100× depending on output churn. Verification protocol: re-sample JSONLs in 30-minute windows after the upgrade lands; the headline metric (calls per hour from the stall-triage path) must drop dramatically across all active agents.

- **File Viewer never-editable extension.** Reproduced by attempting to edit a file under `.instar/jobs/instar/` from the Dashboard before the change — the edit appeared to succeed in the UI but was overwritten on the next update. After fix: the Dashboard refuses the edit at the API layer with a clear message that this namespace is owned by the update process.

- **API-billing safety guard.** Reproduced by setting an Anthropic API key in environment and triggering the legacy auto-fallback path — billing silently switched off the Claude subscription. After fix: the auto-fallback is removed; metered mode requires a two-step opt-in and prints a yellow boxed banner at every server startup.

- **Bug-fix entries that did not require new live reproduction.** Several `### fix(...)` entries below were captured in unit tests at write time and reproduce deterministically in CI; the specific test names are in the corresponding side-effects artifact for each fix. These are not reproduced in isolated dev shells (the build pipeline runs them every commit), and "Not reproducible in dev — covered by deterministic CI tests" is the explicit evidence claim for those entries.

## What to Tell Your User

**W-2 — Supervisor self-heal runbook.** The existing 6-step server-supervisor preflight (Node version, shadow install, native module, lifeline lock, settings.json) can now be invoked by the Remediator as a single approved runbook with full HMAC verification and audit. Ships behind a config flag pending the 7-day seasoning window.

**Pre-compaction memory flush (opt-in).** When your agent has a long conversation with you, sometimes the Claude Code context compaction in the middle smooths out specific facts you mentioned earlier — and the agent ends up "forgetting" what you told it. This release adds a fix: right before compaction, instar quickly looks at the recent conversation, asks the LLM "what here is worth remembering durably?", and writes the answers to memory files. Compaction proceeds normally; the new memory files survive. Result: fewer "didn't I just tell you that?" moments after a multi-hour session. The feature ships off by default — just ask your agent to turn on the pre-compaction memory flush, and the audit log will record every fire for the first few sessions so you can confirm the behavior matches expectations. The flush runs on your subscription path; no extra charges.

**Pre-prompt memory recall (opt-in).** Your agent's responses sometimes feel inconsistent — sometimes it perfectly recalls something you told it last week, sometimes it answers as if it has no memory at all. The cause: some skills check memory before replying, others don't. This release adds a single bounded recall pass that runs before every reply, so the "did I check my notes?" question is always answered the same way. Cap: under two seconds of search, at most five memory entries, around 1200 characters of injected context. Uses local memory only — no LLM cost, no network. Default off; ask your agent to turn on pre-prompt memory recall (it will install the small Claude Code hook for you and walk you through what to expect). The ELI16 doc covers the exact setup.

**F-8 rest — Self-healing orchestrator now enforces its security guards (still off by default).** The self-healing skeleton from earlier work now actually CHECKS the signatures it was contractually supposed to check. Three guards turned on: (1) when the orchestrator hands a repair surface a context object, that object is cryptographically signed so the surface can refuse to act on a forged hand-off; (2) error reports claiming to come from a specific probe must now carry that probe's signature AND the error's subsystem must lie inside the probe's declared coverage list; (3) trust-elevation moves like "promote runbook from registered to live" now ask the F-5 policy module for permission before changing state. Still nothing user-visible because no live runbook is plugged into the running pipeline yet — that wiring lands in W-2..W-4.


**F-5 — Trust gate for the self-healing system (still off by default).** The self-healing system now has the policy module that decides which "lifecycle moves" a runbook is allowed to make. A runbook is a small repair playbook (like W-1's "rebuild SQLite when Node was upgraded"). Each runbook starts as a draft, gets promoted to live after at least a week of dry-run, can be quarantined if it misbehaves, and stays quarantined until a human un-quarantines it. This release adds the policy module that enforces those moves: the agent will refuse to promote a runbook to live unless your trust profile is at least "collaborative" AND the runbook has a fresh-and-multi-week dry-run record. Un-quarantining an essential runbook (one that could change machine-level state) requires TWO independent approval channels — for example one approval over Telegram AND one signed locally through the instar doctor command. Same compromise can't forge both. The opposite direction — pulling a misbehaving runbook OUT of live and into quarantine — is always allowed, no approval required, because the safer move never needs more trust. Still nothing user-visible yet; no real repair runbook is plugged into live mode, and the dispatcher that actually consults this policy ships in follow-up work.

**Stronger API-billing safety.** Instar will no longer silently switch from your Claude subscription to the metered Anthropic API just because your CLI broke and you happen to have an API key in your environment. The default has always been subscription-only; this fix removes the one path that could quietly bill you. If you actually want metered API mode, you now have to explicitly say so — your agent will walk you through a two-step confirmation, and every server startup in that mode prints a yellow boxed banner so it's impossible to miss. No setup needed for the subscription path — that is the default and it stays the default.

**F-2 — Redaction + errorCode normalization.** The self-healing system is getting a safety layer underneath it. Every error report now gets stamped with where the error name came from — a trusted system field, a verified probe, an explicit subsystem call, or just parsed text. Only the trusted sources can trigger automated repair. The same release adds a single place that scrubs personal paths, tokens, emails, and IDs out of every error report before it leaves the agent.

**F-4 — Coordination + audit primitives.** This release adds plumbing for a self-healing system that is not yet active. Nothing changes about how the agent behaves today.

**F-8 — Self-healing orchestrator skeleton.** The piece that decides which repair runs when, makes sure only one repair runs against the same problem at a time, and forcibly stops a repair that takes too long. Wired into the existing audit log, intent journal, and lock primitives from earlier foundation work. Still no user-facing change yet — there are no actual repair playbooks plugged in. The first real playbook (rebuilding the SQLite native module after a Node upgrade) arrives in the next foundation PR. The skeleton fails fast at startup if a playbook is mis-configured (e.g., declared "essential" but only affecting a single process), so misbehaving playbooks can't sneak past review.

**W-1 — First self-healing playbook lands (still off by default).** The first concrete playbook the self-healing system can run is now in the codebase: it rebuilds the SQLite native module when Node gets upgraded and the existing module no longer loads. There are two safety bands that wrap it: only structured, trusted error reports can trigger it (parsed error text alone is not enough), and the rebuild itself uses locked-down npm flags so it can never accidentally re-run every other package's install scripts or pick up a poisoned prebuilt binary. After the rebuild, the system verifies it actually worked by opening a fresh SQLite handle and asking the database to integrity-check itself — anything other than a clean "ok" is recorded as failed rather than success. Nothing changes for you today: the playbook is constructible but isn't yet plugged into the live error pipeline, that wiring is the next-tier work. The existing automatic in-process rebuild path (the one that already silently fixes this when you hit it from the CLI) continues to work unchanged.

**F-1 — Cryptographic foundation for self-healing.** Nothing user-visible yet. If you are running on headless Linux without the libsecret library, your agent will let you know what environment variable to set before any later self-healing feature actually turns on. macOS and Linux with libsecret have nothing to do.

**ELI16-overview gate.** When your agent hands you a spec for approval, you'll now always get a plain-English overview alongside the dense technical document. The instar repo refuses to commit any code change whose driving spec lacks a readable companion file. The technical spec becomes the appendix; the overview is the entry point. No setup required; the new behavior takes effect on the next agent update.

**F-7 — Smarter upgrade migrations.** Instar can now run small, named "atomic steps" on each update — like "add this new entry to the agent's ignore list" or "back up this newly-introduced state file." Each step is recorded once it runs, so the next update doesn't redo it. If one step fails, it just records the failure and keeps going with the others; nothing rolls back. The same release adds a new "say this once" notice primitive so the agent can surface a migration result to you exactly once and never again, even after restarts. Nothing visible today — Tier-2 work is the first consumer. The same release also pre-loads ignore-list entries for the self-healing system's per-machine scratch files so they never get accidentally synced across your machines.

## Summary of New Capabilities

- **`PreCompactionFlush`** (T1.1) — opt-in pre-compaction memory flush; reads transcript tail, calls shared intelligence for fact extraction, writes per-fact files to `.instar/memory/learning_precompact_*.md`, audit-logs every fire. Default `enabled: false`; flip in config to opt in. Hard caps: 5 facts/flush, 500 chars/fact body, 30 KB transcript budget.
- **`PromptBuildRecall`** (T2.2) — pre-prompt memory recall primitive. Synchronous `recall()` against SemanticMemory; cache + circuit breaker + caps (5 entries / 1200 chars / 2s timeout). Surfaces every outcome via typed `source` field (fresh / cached / empty / disabled / no-memory / timeout / circuit-open / error).
- **`POST /internal/prompt-recall`** (T2.2) — Claude Code UserPromptSubmit hook calls this to get the injected `<active_memory_recall>` block before the agent's reply.
- **`.claude/hooks/instar/before-prompt-recall.js`** (T2.2) — bundled UserPromptSubmit hook script. Best-effort: any error path exits 0 with no injected content. Operators copy into their agent and wire into `.claude/settings.json`.

- **`signRemediationContext()` / `verifyRemediationContext()`** (F-8 rest) — HMAC-SHA256 over `{attemptId, runbookId, expiresAt, monotonicDeadline}` using the per-runbook capability leaf. `crypto.timingSafeEqual` on verify; rejects missing-hmac / wrong-runbookId / forged / length-mismatch cases.
- **`RemediationContext.hmac` field** (F-8 rest) — Added to the public type. Optional on the interface for structural compatibility; production dispatch always populates it.
- **Probe-source binding enforcement** (F-8 rest / §A40 / §A52) — `Remediator.dispatch()` rejects `provenance: 'probe-id'` events that are unsigned / forged / out-of-declared-scope when a `ProbeSourceRegistry` is wired. Reasons (`probe-event-unsigned`, `probe-signature-invalid`, `probe-subsystem-out-of-scope`) land in the audit projection.
- **`ProbeSourceRegistry` interface** (F-8 rest) — `{getScope(probeId), verify(probeId, body, signature)}`. `DefaultProbeSourceRegistry` impl wires the F-1 `keyVault.deriveLeafKey('probe', probeId)` for verify + an inline scope map.
- **`canonicalProbeEnvelopeBody()`** (F-8 rest) — Deterministic length-prefixed byte serialization the probe (signer) and Remediator (verifier) both use as HMAC input.
- **`__verifyScope` probe export** (F-8 rest / §A52) — Per-probe const-literal scope declaration. F-8-rest migrates `LifelineProbe` as the smoke-test; full fleet migration is Tier-3.
- **`Remediator.canTransition()`** (F-8 rest) — Wires the F-5 `TrustElevationSource.canTransition()` through the orchestrator. Falls back to `{allowed: true, reason: 'no-trust-source-wired'}` for Tier-1 compatibility.
- **`Remediator.requestPlannedRestart()`** (F-8 rest) — Signs the F-6 `RestartRequestedPayload` with the capability leaf for `runbookId` and hands to `supervisor.handleRestartRequested()`.
- **`Remediator` implements `RegisteredRemediator`** (F-8 rest) — `getCapabilityLeafKey()` + `onRestartComplete()` close the F-6 handshake loop.
- **`NativeModuleHealer.invokeFromRemediator(ctx, keyVault?)` §A3 enforcement** (F-8 rest) — Optional second arg. When wired, verifies the ctx HMAC at entry; invalid → falls back to in-line legacy heal + emits `remediation.surface.invalid-context` warning.


- **`TrustElevationSource`** (F-5) — Authoritative policy module for runbook lifecycle transitions. Encodes the asymmetric trust-elevation table from the v2 spec: `live→quarantined` always-allowed (pessimistic), upward transitions require `collaborative` trust + the spec's freshness / history / approval-channel conditions, `proposal→registered` / `live→deprecated` / `deprecated→removed` are source-change-only (always refused programmatically).
- **`TrustedApprovalChannel` interface** (F-5) — Abstract approval-channel contract from A59. `verifyApproval({proposalId?, runbookId?, action, messageId?})` returns `{approved, principalUserId?, reason?}`. Concrete implementations carry a `kind` discriminator so A53's "different-kind second channel" rule for essential un-quarantines can be enforced at the source layer.
- **`TelegramApprovalChannel` stub** (F-5) — `kind: 'telegram'`. Stub for A41 Telegram-countersignature flow; the real cryptographic-binding-payload verification (proposalId + user_id principal + replay watermark) ships in a follow-up that wires into the existing Telegram relay pipeline.
- **`CliApprovalChannel` stub** (F-5) — `kind: 'cli'`. Stub for A53 option-1 signed-CLI second-factor path (`instar doctor confirm-unquarantine`); the real local-doctor-key signing ships in a follow-up.
- **`AutonomyProfileLevel` re-export** (F-5) — `src/remediation/TrustElevationSource.ts` re-exports the canonical type from `src/core/types.ts` so remediator-side trust policy has a single import path.
- **`RemediationKeyVault`** (F-1) — HKDF-SHA256 leaf keys scoped to one of five contexts (`capability`, `probe`, `inflight`, `ledger`, `audit`) and an opaque scope id.
- **4-backend secret store** (F-1) — OS keychain preferred; hardware-enclave and cloud-KMS stubbed; env-passphrase + AES-256-GCM flatfile fallback.
- **Install nonce** (F-1) — 256-bit random anchor stored under `ai.instar.remediation.install-nonce`; auto-initialized on first boot, fail-closed if missing.
- **ELI16-overview gate** — Structural enforcement at both convergence-time and commit-time. Specs handed for approval always carry a plain-English companion.
- **Shared check module** at `scripts/eli16-overview-check.mjs` — `resolveEli16Path()` and `checkEli16Overview()` with 800-char minimum-length floor.
- **Template for ELI16 overviews** at `skills/instar-dev/templates/eli16-overview.md`.
- **Forward-only enforcement** — only specs newly committed-against after this ships have to satisfy the gate.
- **`selectIntelligenceProvider()`** — single chokepoint enforcing subscription-by-default for the shared LLM provider; refuses silent API fallback; requires two explicit flags for API opt-in; prints a billing banner when API mode is active.
- **NormalizedDegradationEvent contract** (F-3) — `{subsystem, errorCode, provenance, reason: {redacted, full}, timestamp, monotonicTs}` — the go-forward event shape; F-3 ships the additive type plus the legacy → normalized shim.
- **`DegradationReporter.reportStructured(event)`** (F-3) — go-forward emit API for callers that already produced a NormalizedDegradationEvent.
- **`DegradationReporter.setRemediator(remediator)`** (F-3) — registration hook for the F-8 dispatcher; no consumer wired in this PR.
- **Durable RestartPending queue** (F-3) — `<stateDir>/remediation/degradations-queue.jsonl`, 1000 entries / 5 MiB cap, drop-and-counter on overflow (per spec §A5).
- **`scripts/lint-degradation-emit-sites.js`** (F-3) — warning-only catalogue of legacy vs structured emit sites; exits 0 always.
- **Centralized content redaction** (F-2) — `new Redactor().redact(text)` / `.redactFields(obj, fields)` — wired into DegradationReporter in F-3.
- **Structured errorCode extraction with provenance** (F-2) — `ErrorCodeExtractor.extract({ nativeError, probeEmission, subsystemExplicit, freeText, verifyProbeSignature })`.
- **Runbook-match provenance gate** (F-2) — `ErrorCodeExtractor.isAllowedForRunbookMatch(extracted)` — refuses free-text-provenance matchers.
- **In-flight tuple lock** (F-4) — Prevents two heal paths from racing on the same problem.
- **Intent journal** (F-4) — Durable log of "what an attempt declared it was about to do."
- **Audit-writer + projection** (F-4) — Verified-append audit log + read view consumed by later remediation modules.
- **`Remediator` class** (F-8 Tier-1) — Orchestrator skeleton that matches normalized degradation events to registered runbooks, acquires a per-tuple in-flight lock, declares intent, runs the surface callable with deadline enforcement, races verify, and audit-logs every state transition.
- **`ApprovedRunbook` contract** (F-8) — Public type with `eventPrefilter`, `match`, `preconditions`, `surfaceCallable`, `verify`, `blastRadius`, `reversibility`, `expectedRuntimeMs`, optional `essential`. Registry-load-time validators refuse free-text-provenance prefilters (§A6) and `essential` on non-machine blast radius (§A36).
- **`RemediationContext`** (F-8) — Capability-token-shaped context handed to surfaces: `attemptId`, `runbookId`, `lockHandle`, `auditToken` (from F-1 audit-context leaf), `abortSignal`, `expiresAt`, `monotonicDeadline`. Surface-side HMAC enforcement is Tier-2.
- **§A4 deadline enforcement** (F-8) — `AbortController` race against `expectedRuntimeMs`; surfaces that hang are aborted, lock is released, outcome is `aborted-deadline`.
- **§A21 verify taxonomy** (F-8) — `verified-healthy | verify-failed | verify-inconclusive`. Verify-THROW and surface-throw map to `verify-inconclusive` and `verify-failed` respectively; only a clean structured failure increments churn.
- **§A2 covered-by-inline** (F-8) — Pre-existing in-flight lock with same tuple short-circuits dispatch with the existing attemptId.
- **`nodeAbiMismatchRunbook`** (W-1) — First dispatchable `ApprovedRunbook` in `src/remediation/runbooks/node-abi-mismatch.ts`. Matches `NATIVE_MODULE_ABI_MISMATCH` errorCode with structured provenance only (§A6); narrows to better-sqlite3 in `match()`; verifies via `PRAGMA integrity_check` (§A9 durability assertion); `essential: true` + `blastRadius: 'machine'` (§A36).
- **`NativeModuleHealer.invokeFromRemediator(ctx)`** (W-1) — Parallel entry point alongside the unchanged `openWithHeal` CLI safety net. Rebuilds via `npm rebuild --ignore-scripts --build-from-source better-sqlite3` (§A28 + §A45 — never bare `npm rebuild`, never picks up a poisoned prebuild binary). Records sha256 of the rebuilt `.node` binary for cross-process binary-divergence detection.
- **Public types `RemediatorInvocationContext` / `RemediatorExecutionResult`** (W-1) — Structurally compatible with F-8's `RemediationContext` / `ExecutionResult` so the runbook's `surfaceCallable` typechecks without a hard import dependency from `src/memory/*` onto `src/remediation/*`.
- **§A21-conformant verify probe** (W-1) — Opens an in-memory better-sqlite3 handle and runs `integrity_check`. `ok` → `verified-healthy`; non-`ok` row → `verify-failed`; constructor or pragma throw → `verify-inconclusive` (probe error, never failed).
- **`MigratorStepEngine`** (F-7) — Atomic-step primitive: register named, idempotent migration steps versioned by semver. `runPendingSteps(from, to)` executes pending steps once per version with a `<stateDir>/migrator-steps-completed.json` ledger keyed by `<version>:<step-name>`. Failed steps record outcome `failed` but do not block subsequent steps.
- **`PostUpdateMigrator.registerStep` / `.runPendingSteps`** (F-7) — Additive methods on the existing class; existing 15 `migrate*` methods + `migrate()` orchestrator unchanged. Tier-2 surfaces register their own steps via this API.
- **`AnnouncementManager.announceOnce(id, message, channel)`** (F-7) — Show-once primitive backed by `<stateDir>/announcements-shown.json`. Returns true on first call, false on subsequent. Ledger written before sink fires, so a flaky sink cannot cause duplicate emission.
- **`REMEDIATION_GITIGNORE_ENTRIES`** (F-7/A35) — Five remediation runtime path globs embedded into `GitStateManager.DEFAULT_GITIGNORE` const literal and exported as the source-of-truth list for the F-7 gitignore atomic step.
- **`REMEDIATION_EXCLUDED_PATH_PREFIXES` + `isRemediationEnabled` gate** (F-7/A35) — `BackupManager` exclusion list with feature-flag gating that parallels the existing `isIntegratedBeingEnabled` pattern. Gate ON drops any user-added `includeFiles` entry that begins with a remediation prefix; gate OFF/absent preserves them for back-compat.
- **W-2 supervisor-preflight runbook** — Remediator can now orchestrate the existing ServerSupervisor.preflightSelfHeal as an essential runbook.
