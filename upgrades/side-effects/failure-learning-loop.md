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
