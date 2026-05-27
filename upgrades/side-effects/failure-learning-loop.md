# Side-Effects Review — Failure-Learning Loop

**Version / slug:** `failure-learning-loop`
**Date:** `2026-05-26`
**Author:** `echo`
**Spec:** `docs/specs/FAILURE-LEARNING-LOOP-SPEC.md` (converged v4, 3 rounds; approved by justin 2026-05-26)
**Second-pass reviewer:** the 3-round convergence panel (security, scalability, adversarial, integration, lessons-aware) — see `docs/specs/reports/failure-learning-loop-convergence.md`

## Summary of the change

Builds the Failure-Learning Loop (instar-self-hosting dev-process forensics). First slice per spec §5 Q3. This artifact is cumulative across the build's atomic commits; each commit lists the decision points it touches.

## Decision-point inventory

### Commit 1 — FailureLedger spine (the dedicated indexed SQLite store)

- `FailureLedger` (`src/monitoring/FailureLedger.ts`) — **add** — new dedicated SQLite store for failure records. First-class indexed columns (`detected_at`, `category`, `initiative_id`, `build_skill`, `attribution`/`provenance`) per spec §4.2/§4.4 — NOT the TaskFlow `flows` blob (round-3 R3-integ-store decision), so analyzer group-bys are indexed.
- `FailureLedger.open()` — **add** — dedupeKey upsert (§4.2 M5): a repeat increments `occurrenceCount` + logs a bounded occurrence row rather than duplicating. Fail-open (§4.2 m9): storage error logs via `onError` and returns null, never throws into the observed commit/reconciler/route.
- `FailureLedger.update()` — **add** — **mandatory `ifMatch` OCC** (§4.2 M4): a stale version returns `{ok:false, conflict:true}`; no last-writer-win. Caller does bounded retry.
- `FailureLedger.distinctCounts()` — **add** — `COUNT(DISTINCT filed_by/cause_commit)` over the bounded `failure_occurrences` table — feeds the §4.4 source-diversity gate so a single session/commit can never manufacture support.
- `FailureLedger.toApiView()` (static) — **add** — strips `detail.full`; the ONLY record shape permitted across an HTTP boundary (§4.8 C7 — `full` is internal-only, never served by any route).
- Machine-scoped IDs (`FAIL-<machineId>-NNN`) via `failure_seq` table — **add** — prevents cross-machine ID collision (§4.2 M2).

**Over/under-block:** none — this commit is pure storage; no gating, no external calls, no mutation of source files. Reads/writes only its own SQLite DB.
**Level-of-abstraction fit:** sibling to `TokenLedger`/`DegradationReporter` in `src/monitoring/`; reuses `NativeModuleHealer.openWithHealSync` + WAL pragmas exactly as `TokenLedger`.
**Signal-vs-authority:** storage layer only — no authority. (The signal-only analyzer + by-construction authority guard land in later commits.)
**Rollback cost:** trivial — new file + new DB table; disabling the feature flag leaves the table inert.

### Commit 2 — FailureAttributionEngine (the fix→feature join)

- `FailureAttributionEngine` (`src/monitoring/FailureAttributionEngine.ts`) — **add** — pure logic with injected deps (`getInitiative`, `commitTouchedFiles`) so it's unit-testable without a live tracker/git.
- `attributeBugfixCommit()` — **add** — parses the `Fixes-Feature:` trailer (a HINT), then CROSS-CHECKS the fix commit's touched files against the initiative's `coveredFiles`. Verified overlap → `automatic` (0.9); real-initiative-but-no-overlap → `inferred` (mis-blame guard, §4.2 M7); unknown initiative → `inferred`; **trailer omission → `inferred` + `noFeatureLink` coverage bucket** (measured, not silently dropped, §4.2 #A).
- `validateAgentDiagnosed()` — **add** — initiative MUST exist (server-side validation, A2); a caller-supplied `causeCommitOid` is recorded but NEVER upgrades the verdict to `automatic` (stays `one-tap`, B6).
- `coerceCategory()` (static) — **add** — clamps category to the fixed enum; free-text / injected category strings collapse to `unknown` (§4.4 untrusted-text discipline).

**Over/under-block:** the cross-check is the anti-over-attribution control — a forged trailer can't earn `automatic`. Under-block risk (a real fix with a missing trailer) is handled by the visible `noFeatureLink` bucket, not silent loss.
**Level-of-abstraction fit:** pure engine; the route/poller layer (later commit) injects the real InitiativeTracker lookup + `git show --name-only`.
**Signal-vs-authority:** produces a verdict (signal); does not mutate anything.
**Rollback cost:** trivial — new pure-logic file, no wiring yet.

### Commit 3 — trace v2→v3 toolchain enrichment (the dev "receipt")

- `skills/instar-dev/scripts/write-trace.mjs` — **modify** — ADD optional `--build-skill`, `--review-skills`, `--convergence-report`, `--convergence-iterations` args + a `buildToolchain()` helper that writes a `toolchain` block (spec §4.1). **Additive + backward-compatible:** with no new args the output is byte-identical v2 (version stays 2, no toolchain). With them, version→3 + toolchain.
- **Claims vs verified (§4.1 BL-3):** `buildSkill.version` is pinned to a **content hash of the named skill's SKILL.md** (server-derived → `verified:true`), not a caller string; `convergence.verified` is true only if the report file **actually exists**; `reviewSkills[].verified:false` (caller-asserted outcome). The analyzer keeps verified vs claimed in separate buckets.
- **Hot-path (§4.1 M2):** caller passes literals; the only I/O is hashing one SKILL.md + one `existsSync` — O(1), no git/discovery/parse. **Fail-open:** `buildToolchain()` is wrapped — any error returns `undefined` (toolchain omitted), never blocks the commit.
- **Scope (§3 BL-3):** repo-local edit; NOT shipped to deployed agents (skills/instar-dev/ isn't in npm `files`), so NO PostUpdateMigrator entry — toolchain provenance is instar-self-hosting only.

**Over/under-block:** none — the gate (`instar-dev-precommit.js`) reads `phase`/`coveredFiles`/`artifact`/`specPath` only, never `version`/`toolchain`, so the bump is invisible to it (verified). 
**Level-of-abstraction fit:** the receipt-writer enriches what it already stamps; no new tool.
**Signal-vs-authority:** records provenance claims; no authority.
**Rollback cost:** trivial — revert the script; existing v2 traces remain valid (readers ignore `toolchain`).

### Commit 4 — /failures route module + FailureLedger.analyze() + integration tests

- `FailureLedger.analyze()` (`src/monitoring/FailureLedger.ts`) — **add** — indexed group-by SQL (NOT cache-rebuild+JS-filter, round-3 R2-scale): counts by category, toolchain-blame by build_skill restricted to `provenance='verified' AND attribution='automatic'`, unknown-toolchain by author (coverage-integrity signal, R2-sec-omit), no-feature-link count, + coverage (total vs attributed).
- `createFailureRoutes()` (`src/server/failureRoutes.ts`) — **add** — route module following the `topicIntentRoutes` 503-stub pattern (mounted unconditionally; 503s every route when disabled so the surface always exists). `GET /failures` (+ `/:id`, `/analysis`, `/insights`) serve `toApiView` ONLY — `detail.full` never crosses the boundary (§4.8). `POST /failures` (the one mutating route) requires `X-Instar-Request: 1` (intent marker, §4.2#B — NOT claimed as a transport boundary), server-validates the initiative via the attribution engine, stamps `filedBy`, and stays `one-tap` (never upgrades, B6).
- `tests/integration/failure-routes.test.ts` — **add** — 7 supertest cases over real HTTP: 503-when-disabled, alive-200, redaction (full never leaks), intent-header required, nonexistent-initiative rejected, one-tap recorded + filedBy + queryable, 404.

**Over/under-block:** the route is mounted unconditionally (surface always probeable) but every handler 503s when the ledger is null — no half-alive state. POST is gated by intent header + server-side initiative validation.
**Level-of-abstraction fit:** sibling route module (like `topicIntentRoutes`/`worktreeRoutes`); deps injected (ledger + engine) — boot-wiring in AgentServer is the next commit.
**Signal-vs-authority:** read surface + a validated one-tap write; no gating/authority over other systems.
**Rollback cost:** trivial — unmount the router; the ledger table is inert.
**Deferred (next commit, same branch):** AgentServer boot-wiring (construct FailureLedger + AttributionEngine behind `failureLearning.enabled`, inject InitiativeTracker `getInitiative` + git `commitTouchedFiles`, `app.use`) so the feature is alive on the production init path (the Phase-1 E2E).

### Commit 5 — AgentServer boot-wiring + config (feature alive on the prod path)

- `src/core/types.ts` — **add** — `MonitoringConfig.failureLearning?` (enabled + the §4.4 diversity gates + §4.3 confidence floor + `insightTelegramEscalation`). Reached via `config.monitoring.failureLearning` (same home as `sessionReaper`).
- `src/config/ConfigDefaults.ts` — **add** — `failureLearning` default, **ships OFF** (`enabled:false`, minSupport 4, minDistinctSessions/CauseCommits 3, attributionConfidenceFloor 0.6, insightTelegramEscalation false). ConfigDefaults + Config tests still green (27) — migrateConfig adds it for existing agents via existence-check (later commit covers PostUpdateMigrator if needed; ConfigDefaults covers fresh init).
- `src/server/AgentServer.ts` — **modify** — mount `createFailureRoutes(...)` UNCONDITIONALLY right after `topicIntentRoutes` (surface always exists → 503-stub when off). When `monitoring.failureLearning.enabled`, construct the `FailureLedger` (db at `<stateDir>/failure-ledger.db`) + `FailureAttributionEngine` wired to `options.initiativeTracker.get()` (→ InitiativeView) and a git `show --name-only` `commitTouchedFiles` (5s timeout, returns [] on error). Wrapped in try/catch so a wiring failure logs + degrades, never crashes boot.

**Over/under-block:** mounted unconditionally but inert when off (503-stub); construction is flag-gated + try/caught. `commitTouchedFiles` is only exercised by the bugfix-commit source (not the live POST path yet), and fails safe to [].
**Level-of-abstraction fit:** boot-wiring mirrors the `topicIntentRoutes`/`specReviewRoutes` mount blocks exactly; deps from `options` (config, initiativeTracker) already present.
**Signal-vs-authority:** wiring only.
**Rollback cost:** trivial — flag stays false (default); unmount is a one-line revert. Typecheck clean; 26 failure tests + 27 config tests green.
**Deferred (next, same branch):** the Phase-1 "feature alive" E2E that boots AgentServer with the flag ON and asserts /failures returns 200 (not 503) on the production init path; Process Health dashboard tab; the analyzer + closed loop; discoverability (capabilities + Registry-First + generateClaudeMd) + board self-registration.

### Commit 6 — refactor routes inline (the /tokens convention) + discoverability

- **Why:** the `capabilities-discoverability` lint scans `routes.ts` text for `router.<verb>('/prefix'` — surfaced capabilities must be INLINE in routes.ts (the `/tokens` convention), not a separate module. The commit-5 separate `failureRoutes.ts` tripped the lint (red suite). Refactored to match the established pattern.
- `src/server/routes.ts` — **modify** — inline `GET /failures`, `/:id`, `/analysis`, `/insights` + `POST /failures` next to `/tokens`, backed by `ctx.failureLedger` + `ctx.failureAttributionEngine` (503-stub when null). Added the two optional fields to `RouteContext`. Same logic as the deleted module (toApiView-only, X-Instar-Request gate, server-validated one-tap).
- `src/server/AgentServer.ts` — **modify** — construct `FailureLedger` + `FailureAttributionEngine` as instance fields next to `tokenLedger` (the blessed pattern: ledger built in AgentServer, passed via `routeCtx`), wired to `initiativeTracker.get()` + git `show --name-only`. Removed the commit-5 `app.use(createFailureRoutes)` block + import.
- `src/server/failureRoutes.ts` — **DELETE** — logic moved inline; no separate module.
- `src/server/CapabilityIndex.ts` — **add** — `failureLearning` capability entry (prefix `/failures`, enabled-from-config, endpoints) → surfaced in `/capabilities` (Agent Awareness Standard).
- `src/scaffold/templates.ts` — **add** — Registry-First row routing "why do features keep breaking? / failure rate by build skill?" → `/failures/analysis`.
- `tests/integration/failure-routes.test.ts` — **rewrite** — now exercises the REAL `createRoutes()` production path (not a bare module), 7 cases. **Verified: 117 tests green incl. the capabilities-discoverability lint; typecheck clean.**

**Over/under-block:** routes 503 when the ledger is null (feature OFF), 200 when on — no half-alive state. Capability entry reports `enabled` from config so /capabilities tells the truth.
**Level-of-abstraction fit:** now matches `/tokens` exactly (inline route + ctx-injected ledger constructed in AgentServer).
**Signal-vs-authority:** read surface + validated one-tap write; no authority.
**Rollback cost:** trivial — flag default false; routes 503 inert.
**Deferred (next, same branch):** Phase-1 "feature alive" E2E (boot AgentServer flag-ON → 200); Process Health dashboard tab; the analyzer + closed loop (InsightRecord + by-construction guard); generateClaudeMd capability section; migrateConfig for existing agents; board self-registration.

### Commit 7 — the closed loop: analyzer + InsightRecord + by-construction guard + verify

- `FailureLedger` (`src/monitoring/FailureLedger.ts`) — **add** — `failure_insights` table (content-stable `identity_key` UNIQUE → upsert never re-announces) + InsightRecord type + `upsertInsight`/`getInsight`/`getInsightByIdentity`/`listInsights`/`updateInsight` (mandatory ifMatch). [Round-3-of-build self-catch: the INSERT initially omitted `target_category`/`baseline_rate` — a fresh insight read back `targetCategory:undefined`, which made `runVerification` skip it; caught by the failing test, fixed.]
- `FailureAnalyzer` (`src/monitoring/FailureAnalyzer.ts`) — **add** — deterministic category-cluster detection gated on support + SOURCE DIVERSITY (≥minSupport ∧ ≥minDistinctSessions ∧ ≥minDistinctCauseCommits, computed conservatively from deduped records → biases toward NOT firing). Template-keyed recommendations per category (never free-LLM text). Signal-only. Idempotent (stable identityKey).
- `FailureLoopDriver` (`src/monitoring/FailureLoopDriver.ts`) — **add** — the closed loop. **BY-CONSTRUCTION AUTHORITY GUARD (BL-2):** its injected `LoopDeps` are ONLY `addAction` + `createInitiative` — it is given NO proposal-creation capability, so the auto-implement path is unreachable for anything it produces, regardless of `evolutionApprovalMode`. `actOnNewInsights()` opens an Evolution Action + a draft Initiative (needs-user) per discovered insight. `runVerification()` is the active confounder-aware verify: counts NEW (post-fix, baseline-excluded) category failures vs baseline → effective / ineffective(reopen, capped→inconclusive) / insufficient-exposure(extend-once→inconclusive); labeled correlational.
- `src/server/routes.ts` — **modify** — `/failures/insights` now serves real `ctx.failureLedger.listInsights()`.
- `tests/unit/FailureLoop.test.ts` — **add** — 7 tests: analyzer fires on diversity / does NOT fire on single-session×4 / idempotent; **by-construction test asserts addProposal + processProposalAutonomously are NEVER called with autonomous-mode ON, and zero loop-created proposals**; verify drop→effective and no-drop→reopen→capped-inconclusive.

**Over/under-block:** the diversity gate prevents false patterns (under-fires by design); the by-construction guard makes over-reach (auto-implement) structurally impossible.
**Signal-vs-authority:** analyzer = signal; loop opens human-approved tracked items only; NEVER mutates a skill/spec/proposal.
**Rollback cost:** trivial — insights table is additive; loop only runs when the (off-by-default) analyzer job invokes it.
**Verified:** 7 closed-loop + 9 ledger + 7 route tests green; typecheck clean.
**Deferred (next, same branch):** analyzer job template (off by default); generateClaudeMd capability section; migrateConfig; board self-registration; Phase-1 boot E2E; Process Health dashboard tab (tracked fast-follow on the rollout board — data fully exposed via /failures API + /capabilities; feature ships dark).
