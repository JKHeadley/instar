---
status: draft
approved: true
approved-by: justin
approved-at: "2026-05-28T16:30:00Z"
author: echo
created: 2026-05-27
topic: 13201
eli16-overview: FAILURE-LEARNING-INGESTION-SOURCES-SPEC.eli16.md
parent-spec: FAILURE-LEARNING-LOOP-SPEC.md
lessons-engaged: "signal-vs-authority (sources are write-only, no authority); near-silent (no user messaging); no-manual-work (the feature's purpose); migration-parity (config + enum); 3-tier + wiring-integrity (per source, against REAL hooks); fail-open; LLM-supervised (tier0 justified); Bug-Fix Evidence Bar / silently-stopped-trio (every wiring claim re-grounded against code in v2)"
review-convergence: "2026-05-28T16:20:12.519Z"
review-iterations: 3
review-completed-at: "2026-05-28T16:20:12.519Z"
review-report: "docs/specs/reports/failure-learning-ingestion-sources-convergence.md"
---

# Failure-Learning Ingestion Sources Spec

**Status:** CONVERGED v3.1 (3 rounds + 1 corrective edit; review-convergence tagged). Author: echo · Created: 2026-05-27 · Topic: 13201
**Parent:** `docs/specs/FAILURE-LEARNING-LOOP-SPEC.md` (this fills its §4.2 #C/#D/#E/#F deferred <!-- tracked: failure-learning-ingestion-sources --> sources)

> **Convergence changelog (v2 → v3 — round-2 findings, all folded).** Round 2 (3 code-grounded reviewers) confirmed v2's corrected hooks are accurate but surfaced: **(BL)** extending `FailureCategory` breaks `tsc` because `FailureAnalyzer`'s `RECOMMENDATION_BY_CATEGORY` is a *total* `Record<FailureCategory,string>` — §7 now requires adding the 3 new recommendation templates + a totality test. **(BL→resolved) Self-reinforcing loop was only half-closed:** loop self-exclusion was specified on the `regression` source only, but a loop fix-PR can re-enter via `ci` (its PR fails CI) or `revert` — §4.3 now extends the loop-origin skip to ALL initiative-mapping sources and credits the diversity gate (constant `filedBy`) as the *primary* structural break; the `origin` propagation is now enumerated as the real 4-touchpoint change incl. the TaskFlow round-trip. **(MAJ→resolved) Diversity-gate combination (§5 NEW-1):** because revert opens `resolved` (status-filtered, §6.1) and degradation is `inferred` (analyzer-excluded), the only automatic sources feeding *active* clustering are `ci` + `regression` → `distinctSessions` maxes at 2 < 3, so **crossing the gate ALWAYS requires ≥1 human-filed record** — now stated as a property, not an open question. **(MAJ→resolved) Occurrence-retention rationale (§5 NEW-3):** the analyzer counts distinct on deduped `failure_records`, NOT `failure_occurrences`/`distinctCounts()` — so the cap is safe but the "window-alignment with analyzer lookback" justification was a phantom (removed), and the dead `distinctCounts()`/occurrences duplication is flagged as a parent cleanup. **(MIN)** observers fire before the early-returns; drop `queueMicrotask` for the precedent's synchronous post-persist call; reverse-lookup via `list()` (TaskFlow-safe) not the raw Map; `ON CONFLICT` clause sets `updated_at`; revert close tightened to initiative+causeCommitOid match; uniform secret-scrub on all four sources' `detail.full`; §6.1/§5 reframed as *implementing unbuilt parent requirements* (parent §4.4 M6 + concurrency M4), not parent-design changes (so no parent re-convergence). Full round-1+2 finding ledger: see the convergence report (Phase 4).

> **Convergence changelog (v1 → v2).** Round 1 (5 code-grounded internal reviewers) found that v1's two key wiring claims were **false against the code** and its poison-resistance story relied on a path the analyzer doesn't use. v2 folds all material findings: (BL) the two wiring claims are replaced with **real new additive hooks** (`DegradationReporter.addObserver()`, `InitiativeTracker.setRegressionEmitter()`) — §3.3/§3.4/§6; (BL) the source categories are added to the **`FailureCategory` enum** (they were silently clamped to `unknown`) — §7; (BL) **constant per-source `filedBy`** closes the flaky-CI poisoning path the analyzer's set-counting left open — §5; (BL) a **`failure_occurrences` retention cap** bounds the unbounded occurrence-table growth the high-frequency feeders cause — §5; (BL) **`origin` propagation through `createInitiative`** + a regression-source exclusion breaks the self-reinforcing loop — §4.3; (MAJ) revert **auto-close requires a reachability + diff cross-check** — §4.2; CI poller **per-tick write cap + `gh` arg-array/repo-regex hardening** — §4.1; new-record path becomes an **`ON CONFLICT` upsert** — §5; degradation is **explicitly dashboard-only** (the analyzer excludes `inferred`) — §4.4; a small **analyzer status-filter** keeps resolved reverts out of active clustering — §6.1. Full round-1 ledger: see the convergence report.

## 1. Problem

The Failure-Learning Loop shipped its first slice (v1.3.27) and is live + `capture-only` on agents — but **the ledger is empty** (`GET /failures/analysis` → `total: 0`). It learns only from what it's fed, and today the only feeds are the manual `bugfix-commit` trailer (#A) and the one-tap `POST /failures` (#B). So the loop is built, live, and **blind**: the Process Health tab reads "all quiet" indefinitely. This spec adds the four automatic sources the loop deferred <!-- tracked: failure-learning-ingestion-sources --> (§4.2 #C/#D/#E/#F) so failures land **without anyone typing anything** (the no-manual-work standard, which is the whole point of the loop).

## 2. Goals / Non-goals

**Goals**
- Each source files (or closes) a `FailureRecord` automatically, with honest, server-derived attribution.
- Every source is **off by default**, gated by its own config flag, and **fail-open** (a source erroring never breaks a build, a request, or another source/subsystem).
- Sources converge on a single dedup path; multiple sources naming the same failure produce ONE record, never duplicates, and never grow the occurrence table without bound.
- Near-silent: sources write to the ledger only; they never message the user.
- Reuse the existing `FailureLedger.open()` + `FailureAttributionEngine` + `InitiativeTracker` lineage; add attribution logic only where the engine genuinely lacks a path (CI/revert reverse-lookup).

**Non-goals**
- No new user-facing UI (the Process Health tab renders whatever lands in the ledger).
- No webhook server for CI (deferred <!-- tracked: failure-learning-ingestion-sources --> — the poller is the lower-surface first cut, §4.1).

**Scope note (corrected from v1's non-goal):** review showed the four sources cannot be built with *zero* changes to neighboring subsystems. v3 requires **small, additive** changes, each called out where it occurs and re-grounded against the real code: (a) extend the `FailureCategory` enum + its 4 reconcile sites incl. the total `RECOMMENDATION_BY_CATEGORY` map (§7); (b) add `DegradationReporter.addObserver()` (§3.4/§6); (c) add `InitiativeTracker.setRegressionEmitter()` + thread `origin` through `createInitiative` (the real 4-touchpoint change incl. TaskFlow round-trip, §3.3/§4.3) + `findByMergeCommit`/`findByPrNumber` reverse-lookups (§3.1); (d) add a status-filter to `FailureAnalyzer` + occurrence-retention to `FailureLedger` (§6.1/§5) — both of which **implement parent requirements that were specified but never built** (parent §4.4 M6 + concurrency M4), so no parent re-convergence. None re-architect; all additive and independently tested.

## 3. The four sources

`FailureLedger.open()`'s `source` enum already contains `'ci' | 'revert' | 'regression' | 'degradation'` (verified `FailureLedger.ts:39`). Each source is: **trigger → attribution → ledger action → dedup key → fail-open → config flag.** `filedBy` and category mapping are specified in §5/§7 (shared).

### 3.1 `ci` — CI failures (poller)

- **Trigger:** a `CiFailurePoller` (start/stop, reentry-guarded, fires after `listen` like `TokenLedgerPoller`) runs, at the reconciler's cadence (≥6h), the **same batched arg-array `execFileSync('gh', ['run','list','--repo',repo,'--limit',N,'--json',...])`** the reconciler already uses (`routes.ts:3736`) — **NORMATIVE: arg-array form, never a shell string; `repo` parsed from the git remote MUST be validated against `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$` before use** (security A1/B3). Time-window the query to the poll interval; cap runs processed per tick (§5).
- **Attribution:** failed run → `headBranch`/head-SHA → `mergeCommitOid`/PR → initiative via an **exact-OID** `InitiativeTracker` reverse-lookup (new `findByMergeCommit`/`findByPrNumber`, §6 — **round-2: implemented as a scan via `list()`, which triggers `refreshCacheFromTaskFlow()`, NOT a read of the raw `this.initiatives` Map, so it stays correct under TaskFlow; no index needed at current initiative scale**). Never a branch-name substring match. Mapped → `automatic` (confidence 0.9), UNLESS the mapped initiative's `origin` is `failure-learning-loop` → skip (loop self-exclusion, §4.3). Unmapped → `initiativeId: undefined`, `inferred`, `noFeatureLink`.
- **Flaky guard (adversarial B2):** a failed run is filed at `automatic` ONLY if it is **not** a re-run flake — i.e. the run's `conclusion` is `failure` AND it is not superseded by a later successful re-run attempt of the same run id. A run that later passes on re-run files (if at all) at `inferred` (below `attributionConfidenceFloor` 0.6 → excluded from analysis). The tab still shows it; the analyzer doesn't act on it.
- **Ledger action:** `open({ source:'ci', category: <job-name → enum via fixed allow-list, default 'unknown'>, summary:<redacted: workflow + conclusion>, detail:{ redacted:<job + conclusion>, full:<run url + first failing step, secret-scrubbed §5> }, causeCommitOid:<headSha>, prNumber, initiativeId, filedBy:'source:ci', attribution, attributionConfidence })`.
- **Dedup key:** `f('ci', headSha, category)`.
- **Fail-open:** `gh` missing/unauthed/rate-limited/non-JSON/oversize → log + skip the tick. Never blocks boot.
- **Config:** `failureLearning.sources.ci` (default `false`).

### 3.2 `revert` — reverted changes (commit-message detection)

- **Trigger:** at the existing reconciler commit-scan pass, detect `Revert "…"` commits and extract the reverted OID from the `This reverts commit <oid>.` body line.
- **Cross-check before any close (security B2 — near-blocker):** the parser MUST verify (1) the extracted OID is a **real reachable ancestor** (`git cat-file -e <oid>` + merge-base reachability), and (2) the revert commit's diff **actually touches an intersecting fileset** with the reverted commit. A hand-written `This reverts commit <oid>` that fails either check is treated as untrusted: it may **open** an `inferred` record but **MUST NEVER auto-close** another record. This mirrors the parent's `bugfix-commit` coveredFiles cross-check (§4.2#A).
- **Revert² (adversarial M2):** if the reverted OID is itself a revert commit, do not mis-attribute — chase to the root or skip; specify skip-on-revert-of-revert for v1 (a re-land is not a failure).
- **Attribution:** reverted commit's lineage → initiative = `automatic` when mapped + cross-check passes; else `inferred`.
- **Ledger action — close-or-open (resolved with Justin Q2):** if a matching **open** record exists **matched on initiative AND causeCommitOid** (round-2 NEW-4: tightened from initiative-only, so a minimal real revert can't close an unrelated record for the same initiative), **close it** (`update(... { status:'resolved' }, ifMatch=version)` via a **read-then-CAS-retry loop** — `update()` requires `ifMatch`, `FailureLedger.ts:469`), note "reverted by <oid>". If none matches, **open** one (`source:'revert'`, `category:'regression'`, `status:'resolved'` → status-filtered out of clustering per §6.1, so revert records are forensic-only, never analysis-driving). Never double-counts. `filedBy:'source:revert'`. Skip entirely if the mapped initiative's `origin` is `failure-learning-loop` (§4.3). Close is reversible + audited; residual close-griefing risk accepted per the §4.1 threat model.
- **Dedup key:** `f('revert', revertedOid)`.
- **Fail-open:** unparseable / no reachable OID / no initiative → log + skip.
- **Config:** `failureLearning.sources.revert` (default `false`).

### 3.3 `regression` — a shipped feature functionally broke (single chokepoint, REAL hook)

- **The subtlety (loop spec BL-1):** `pipelineStage:'regressed'` is already written by two writers (rollout backslide; merge-unreachability), **neither meaning "functionally broke."** This source must not fire on every `regressed` write.
- **The hook (corrected from v1's wrong `registerLedgerEmitters` claim):** add a new injected callback to `InitiativeTracker`, **`setRegressionEmitter(fn)`**, mirroring the existing `setDigestCacheInvalidator` pattern (`InitiativeTracker.ts:458`) — a single fire-and-forget callback, default no-op. `update()` (the single chokepoint both writers pass through, `:1000`) reads `existing` (prior stage) at `:1001` and sets `next.pipelineStage` (`:~1056`), so the edge `prior !== 'regressed' && next === 'regressed'` is computable. The emitter fires **synchronously after `persistThroughTaskFlow()` resolves, immediately before `return result` — mirroring the existing `digestCacheInvalidator()` call at `:1121`** (NOT `queueMicrotask`, which would contradict the cited precedent; fire-and-forget isolation comes from wrapping the body in try/catch so a ledger write can never reject `update()`). Keyed `(initiativeId, mergeCommitOid)` → idempotent, no re-fire on re-reconcile.
- **Loop self-exclusion (adversarial B3/B4):** the emitter MUST skip initiatives whose `origin` is `failure-learning-loop` (§4.3). **Note (round-2 correction): the origin-skip is a belt, not the primary break.** Because revert opens `resolved` records (status-filtered out of clustering, §6.1) and degradation is `inferred` (analyzer-excluded), the structural break against the self-reinforcing loop is the **diversity gate** (§5): automatic sources share a constant `filedBy`, so a loop's own activity can never alone manufacture an insight. The origin-skip prevents loop-origin initiatives from being *filed* at all by the initiative-mapping sources — see §4.3 (it now covers `ci` + `revert` + `regression`, not just `regression`).
- **Attribution:** the initiative = `automatic`; `causeCommitOid = mergeCommitOid`. `filedBy:'source:regression'`.
- **Filing policy by reason:** file `merge-unreachable` (a real integrity problem). File `backslide` only when `sources.regressionIncludesBackslide` is true (default `false` — a deliberate flag-flip is an operator decision, not a failure, adversarial M4); if ever enabled, backslide records are `inferred` (excluded from analysis).
- **Ledger action:** `open({ source:'regression', category:'regression', initiativeId, causeCommitOid:mergeCommitOid, summary, detail:{redacted:<reason>, full:<prior→new + reason>}, attribution:'automatic', filedBy:'source:regression' })`.
- **Dedup key:** `f('regression', mergeCommitOid)`.
- **Config:** `failureLearning.sources.regression` (default `false`); `sources.regressionIncludesBackslide` (default `false`).

### 3.4 `degradation` — runtime fallback events (dashboard-only, opt-in per subsystem)

- **The hook (corrected from v1's wrong `setRemediator` claim):** `DegradationReporter` has a **single** remediator slot already occupied by native-heal (`setRemediator`, `:390`) — it is NOT a multi-consumer hook. v3 adds a **real additive `addObserver(fn)`**: a listener array fanned out in both `report()` and `reportStructured()`, each observer wrapped in its own try/catch (fail-open per observer). **Round-2 correction: observers fire UNCONDITIONALLY — placed after the initial `console.warn` but BEFORE the `restartPending`/remediator early-returns (`:319/:324/:336`, `:369/:374`)** — otherwise a wired remediator or a restart-pending window would silently swallow the ledger feed. The existing remediator dispatch is unaffected. Wiring-integrity test (§11): native-heal still fires when an observer throws, AND an observer fires even when a remediator is present.
- **Trigger:** the observer receives `reportStructured` events `{ subsystem, errorCode, provenance, reason:{redacted,full}, monotonicTs }`; promote to a FailureRecord ONLY for subsystems on the allow-list (default `[]`).
- **errorCode cardinality guard (scalability M5 / security B4):** `errorCode` MUST be a bounded code, not free text; the observer clamps/normalizes (strip numeric/uuid suffixes) before the dedup key, so a subsystem cycling synthetic codes can't flood `failure_records`.
- **Explicitly dashboard-only (adversarial M3):** the analyzer filters to `automatic`/`one-tap` and **excludes `inferred`** (`FailureAnalyzer.ts:71`). Degradation records are `inferred` → they **never drive an insight**. This source feeds the Process Health tab + source-coverage stats ONLY. v2 keeps it (visibility value) but documents this plainly; it remains slice 3 and **may be deferred <!-- tracked: failure-learning-ingestion-sources --> indefinitely** if the dashboard signal doesn't justify the `addObserver` surface.
- **Ledger action:** `open({ source:'degradation', category:<per-subsystem mapped, default 'unknown'>, summary:<redacted>, detail:{redacted:event.reason.redacted, full:<secret-scrubbed event.reason.full>}, attribution:'inferred', filedBy:'source:degradation' })`.
- **Dedup key:** `f('degradation', subsystem, normalizedErrorCode)`.
- **Config:** `failureLearning.sources.degradation` — subsystem allow-list (default `[]`).

## 4. Shared design

### 4.1 Threat model / trust boundary (security D1)
The four sources take **no external request** — they are in-process feeds (poller, reconciler pass, injected callback, DegradationReporter observer) calling `FailureLedger.open()` directly, same trust domain as the ledger. The only adversary influence is **data-shaped**: an attacker controls *what gets observed* (commit messages, CI job/branch names, degradation reason text), never *whether the feed runs*. Every such surface is hardened per §3 (gh arg-array + repo regex; revert reachability + diff cross-check; CI job-name enum allow-list; errorCode clamp; constant per-source `filedBy`).

### 4.2 (folded into §3.2)

### 4.3 Loop self-exclusion (origin propagation — the real 4-touchpoint change)
Round 2 confirmed this is NOT a one-liner: there is **no `origin` field on `Initiative`/`InitiativeCreateInput` today** (the only `origin` in the tree is the unrelated agentmd `origin`). Threading it is four additive touchpoints, all of which the build must do (or the tag silently drops at the adapter/TaskFlow boundary — the exact "wired but not persisted" gap the loop exists to catch):
1. Add `origin?: 'failure-learning-loop'` to `LoopDeps.createInitiative`'s input type (`FailureLoopDriver.ts:44-51`) **and** have `actOnNewInsights()` actually pass it (`:89-96` passes no such field today).
2. Widen the `routes.ts:~4522` adapter (`createInitiative: async (i) => tracker.create(i)`) + `InitiativeCreateInput` to carry it.
3. Persist it on the `Initiative` record (`InitiativeTracker.ts:154` interface, `create()` ~`:973`).
4. **TaskFlow round-trip — verify, don't build (round-3 correction).** The TaskFlow store persists the whole `Initiative` as a lossless JSON blob (`stateJson = { initiative }`, `initiativeFromFlow` returns it verbatim, the store column is an opaque `JSON.stringify`/`parse` typed `unknown` — no field-level serializer, no schema strip). So `origin` round-trips through TaskFlow **for free** the moment it's on the `Initiative` interface (TP3) — there is NO serializer to modify. The only obligation here is a **wiring-integrity test** asserting `origin='failure-learning-loop'` survives `create()` → `get()` with TaskFlow enabled (guards against a future schema-tightening regressing it).

**Exclusion now covers ALL initiative-mapping sources** (round-2 fix — was `regression`-only): when a `ci`, `revert`, or `regression` source resolves a mapped initiative whose `origin` is `failure-learning-loop`, it skips filing (or files inert) — so a loop's own fix-PR failing CI, or a loop change being reverted, does not re-enter ingestion. The reverse-lookups (§3.1) read `origin` off the resolved initiative. **Wiring-integrity test:** a loop-created Initiative round-trips `origin='failure-learning-loop'` from `create()` → `get()` (incl. under TaskFlow), and a CI/revert/regression event mapped to it files nothing. Per §3.3, the diversity gate (constant `filedBy`) remains the *primary* structural break; this origin-skip is the belt.

### 4.4 Config block (additive to `failureLearning`, deep-merged via `ConfigDefaults` — see §8)
```
sources?: {
  ci?: boolean;                          // default false
  revert?: boolean;                      // default false
  regression?: boolean;                  // default false
  regressionIncludesBackslide?: boolean; // default false   (NB: corrected spelling)
  degradation?: string[];                // default []  — subsystem allow-list
  ciPollMinutes?: number;                // optional override; default = reconciler cadence
  ciMaxRunsPerTick?: number;             // default e.g. 50 — per-tick write cap
}
```

### 4.5 Attribution honesty + confidence
`automatic` only on clean server-derived git/CI lineage (ci-mapped, revert-mapped-and-cross-checked, regression). `inferred` for degradation + all unmapped/flaky cases (excluded from analysis). Each source sets `attributionConfidence` **explicitly** (automatic→0.9, inferred→0.2) rather than defaulting to 0 (security m1). Never fabricate `automatic`.

### 4.6 Supervision
All sources are **tier0** (P7 justification: they only FILE records via enum-clamped deterministic mappings — no policy/recommendation decision; the recommending analyzer is the parent's `tier1`). No LLM in any hot path.

### 4.7 Near-silence
No source emits to Telegram or the attention queue. The loop's existing (off-by-default) insight path owns all user-facing output.

## 5. Bounded writes (scalability blockers)

- **`failure_occurrences` retention (Blocker 1) — rationale corrected (round-2 NEW-3):** today `open()` inserts one occurrence row per call, unconditionally, with no prune — so high-frequency CI/degradation feeders grow the table without bound while the visible record count stays deduped. v3 adds a **bounded-retention policy**: cap occurrence rows per `dedupeKey` (keep the most recent N). **Correction:** the safety of pruning does NOT depend on aligning with "the analyzer's diversity lookback" — the analyzer computes diversity from the **deduped `failure_records`** (`new Set(cluster.map(r=>r.filedBy))`, `FailureAnalyzer.ts:84`), and **never reads `failure_occurrences` / `distinctCounts()` at all.** So the occurrence table is purely a **bounded forensic log** — pruning it cannot affect any analysis decision. Config knob for N; unit test: a hot dedupeKey does not grow `failure_occurrences` without bound. **(Parent cleanup flagged, not in scope here):** `FailureLedger.distinctCounts()` + the `failure_occurrences` table are currently *unused by the analyzer* — a latent duplication. Either the analyzer should use `distinctCounts()` (a deliberate parent decision) or the table is forensic-only. v3 treats it as forensic-only and notes this for a parent follow-up <!-- tracked: failure-learning-ingestion-sources -->; it does NOT silently ship two parallel diversity mechanisms.
- **`ON CONFLICT` upsert (Blocker 6):** the new-record path is `SELECT`-then-`INSERT` today — a cross-process race hits the UNIQUE constraint and the fail-open catch **drops** the record. v3 converts it to `INSERT … ON CONFLICT(dedupe_key) DO UPDATE SET occurrence_count = occurrence_count + 1, version = version + 1, updated_at = @updatedAt` (the `updated_at` set mirrors the existing UPDATE branch at `FailureLedger.ts:376-378`), so a lost race increments instead of dropping.
- **CI per-tick write cap (Major 3):** restore the parent's "recently-active branches" bound and cap runs processed per poll at `ciMaxRunsPerTick`, oldest/initiative-mapped first, overflow logged-and-counted (mirrors `RESTART_QUEUE_MAX_ENTRIES`).
- **Constant per-source `filedBy` (Blocker — the poisoning fix + the diversity-gate property, round-2 NEW-1 resolved):** every automatic source stamps a **constant** `filedBy` (`source:ci` / `source:revert` / `source:regression` / `source:degradation`). The analyzer computes session-diversity by `new Set(cluster.map(r => r.filedBy)).size` (`FailureAnalyzer.ts:84`), so a single automatic source's records share one `filedBy` → `distinctSessions = 1 < minDistinctSessions(3)` → **a single machine source can never manufacture an insight** (a flaky test across many commits still has `distinctSessions = 1`). **Multi-source combination (the resolved NEW-1 question):** the only automatic sources that feed *active* clustering are `ci` and `regression` — because `revert` opens `resolved` records (status-filtered out, §6.1) and `degradation` is `inferred` (analyzer-excluded). Two distinct automatic filedBys (`source:ci` + `source:regression`) → `distinctSessions` maxes at **2 < 3**. Therefore **crossing the diversity gate ALWAYS requires at least one human-filed record** (a `bugfix-commit` or one-tap `agent-diagnosed`). That is the intended quorum — machine signal needs human corroboration before it can auto-open a tracked item — and it is now a stated *property*, not an open question. The constant `filedBy` also makes a flood attributable to one source.
- **Cross-machine (Minor 9):** `open()`-time dedup is per-machine (each has its own SQLite file). v3 does NOT claim cross-machine convergence at `open()` time; multi-machine dedup is deferred <!-- tracked: failure-learning-ingestion-sources --> to the existing reconcile/git-sync layer. To avoid N× `gh` fleet load + cross-machine CI dup, the **CI poller runs only on the fenced-lease holder** (the cross-machine lease infra already exists) — polled once per fleet, not per machine.
- **Uniform secret-scrub (security C1 / lessons round-2):** best-effort token/key-pattern redaction is applied to **every** source's `detail.full` before storage (not just `ci`/`degradation`) — `revert` and `regression` `full` text too. `detail.full` never crosses HTTP (`toApiView` strips it), but it IS written to `logs/` + `failures.sqlite`, so those are documented as a **secret-bearing internal trust zone**; a thorough scrubber is a tracked deferral <!-- tracked: failure-learning-ingestion-sources --> (§12).

## 6. Wiring (TokenLedgerPoller pattern, gated)

Construct sources in `AgentServer` inside the existing `failureLearning.enabled` try/catch (`AgentServer.ts:561-593`), each additionally gated on its `sources.<x>` flag (AND, not OR); start pollers in the post-`listen` callback; stop on shutdown; each in its own try/catch (fail-open, no cascade).
- `ci`: a `CiFailurePoller` class sharing the reconciler's `gh` invocation; lease-gated (§5).
- `revert`: folded into the existing reconciler commit-scan pass (no new poller).
- `regression`: `InitiativeTracker.setRegressionEmitter(fn)` wired to a FailureLedger-side handler (a dedicated AgentServer wiring, NOT the SharedStateLedger `registerLedgerEmitters`).
- `degradation`: `DegradationReporter.addObserver(fn)` (the new additive API).

### 6.1 Analyzer status-filter — implements an UNBUILT parent requirement (not a parent-design change)
The parent loop spec §4.4 (M6) ALREADY specifies "archived/reverted-feature failures are decayed/excluded from active rates" — but `FailureAnalyzer.analyze()` has no status filter today (`FailureAnalyzer.ts:69-71`), so the parent requirement was specified-but-never-built. v3 adds the filter the parent already called for: `resolved`/`closed` records are excluded from active-rate clustering (still visible on the tab + in history), done in the analyzer's `.filter()` predicate (`list()`'s `status` param is single-valued equality, so the exclusion belongs in the predicate, not SQL). Because this realizes a parent requirement rather than changing parent design, **no parent re-convergence is needed** (round-2 lessons-aware confirmed). Small, additive, tested both sides. (Same framing applies to §5's occurrence retention — the parent promised bounded occurrences + `COUNT(DISTINCT)`; the code lagged.)

## 7. Category enum (folded blocker + the round-2 tsc fix)

The source categories `build-failure`, `test-failure`, `regression` are NOT in `FailureCategory` (`FailureLedger.ts:49`) → `coerceCategory` clamps them to `unknown`, defeating `byCategory` analytics and flattening the dedupeKey (build vs test on one commit collide). v3 **extends the enum additively** with `build-failure`, `test-failure`, `regression`, and reconciles **four** sites:
1. `coerceCategory`'s allow-list (`FailureAttributionEngine.ts:165`).
2. The schema default (`FailureLedger.ts:234` — TEXT column, no CHECK, so existing rows are unaffected; migration-free at the DB level).
3. The dashboard's `CATEGORY_WORDS` + `TYPE_WORDS` (`dashboard/process-health.js`) — which **already reference these labels** (the tab and ledger were out of sync; this aligns a pre-existing drift).
4. **`RECOMMENDATION_BY_CATEGORY` (round-2 BLOCKER — `FailureAnalyzer.ts:39`):** it is a **total `Record<FailureCategory, string>`**, so widening the enum **fails `tsc`** until all three new keys have entries. v3 adds recommendation templates for `build-failure` ("check the build config / dependency that broke"), `test-failure` ("require the 3-tier test set before merge"), and `regression` ("a shipped feature broke — add a regression guard for this path"). A **totality test** asserts every `FailureCategory` has a recommendation (so a future enum addition can't silently break this again).

CI job-name → category goes through a **fixed allow-list** to the enum (raw job name never echoed into the indexed `category` field; it belongs only in `detail`).

## 8. Migration parity (corrected mechanism)

`migrateConfig` no longer has per-feature blocks — `applyDefaults(config, getMigrationDefaults(...))` deep-merges (`PostUpdateMigrator.ts:~3957`, `ConfigDefaults.ts:288-373`, verified recursive incl. the `string[]` leaf case). So: add `sources` to the `failureLearning` block in `ConfigDefaults.ts`; the deep-merge adds it to existing agents existence-checked, without clobbering sibling keys. Test: existing `failureLearning` config + migration → `sources` added, nothing else changed.

**Agent Awareness (P5, MAJ-2):** add a short Capabilities / Registry-First note so the agent knows (a) the `failureLearning.sources.*` flags exist and what each does ("turn on CI failure capture", "why is my ledger empty"), and (b) the **`ci` source needs `gh` installed + authed, per-machine** — a disabled-because-no-`gh` source is invisible except in `/failures/analysis` source coverage. The enum extension also means the awareness note lists the new category values.

## 9. Open questions — resolved (Justin, 2026-05-28)

- **Q1 (CI cadence):** reuse the reconciler's ≥6h cadence, with optional `ciPollMinutes` override. **(approved)**
- **Q2 (revert close-vs-open):** split — close a matching open record if one exists, else open a `resolved` one. **(approved; hardened with the §3.2 cross-check)**
- **Q3 (regression backslide):** off by default (`regressionIncludesBackslide: false`); flag exists for opt-in. **(approved)**
- **Q4 (CI not authed):** silent no-op, visible only in `/failures/analysis` source coverage. **(approved; agent-awareness note §8 makes it discoverable)**

## 10. Slice plan — ONE tracked project (L16 / P10)

Registered as a single multi-slice **project** (so later slices can't be silently dropped — not a recurrence-risking deferral <!-- tracked: failure-learning-ingestion-sources -->; each slice ships gated-off + matures on the rollout board):

1. **Slice 1 — `ci` + `revert`** + the shared substrate they need: enum extension (§7), constant-`filedBy` (§5), occurrence retention + `ON CONFLICT` (§5), analyzer status-filter (§6.1), `InitiativeTracker.findByMergeCommit` lookup, config block + migration + agent-awareness. Highest value, deterministic, git-derived.
2. **Slice 2 — `regression`**: `InitiativeTracker.setRegressionEmitter` + the edge-trigger + `origin` propagation through `createInitiative` + loop self-exclusion. Isolated because the `regressed` ambiguity is the sharpest correctness hazard.
3. **Slice 3 — `degradation`** (dashboard-only): `DegradationReporter.addObserver` + allow-list + errorCode clamp. Lowest priority; may be deferred <!-- tracked: failure-learning-ingestion-sources --> indefinitely per §3.4.

## 11. Testing (3-tier + wiring-integrity, per source — NON-NEGOTIABLE)

- **Unit:** each source's detect→attribute→open mapping with a real in-memory ledger. Revert open-vs-close BOTH sides + the cross-check rejection (untrusted revert never auto-closes) + revert² skip. Regression `backslide`-vs-`merge-unreachable` filing BOTH sides + loop-origin exclusion. CI job-name→enum allow-list + flaky→`inferred`. Degradation allow-list (in promotes / out drops) + errorCode-cardinality clamp. Constant-`filedBy` → `distinctSessions=1` for a single-source cluster (the poison-resistance assertion). Occurrence-retention: a hot dedupeKey stays bounded. `ON CONFLICT`: two opens same dedupeKey → count=2, no dropped record. Analyzer status-filter: resolved records excluded from active clustering.
- **Integration:** each source through the real construction path, flags on/off → 503/no-op disabled, files enabled. CI poller with mocked `gh` (failed run → record; oversize/unauthed → no-op). Redaction: a degradation `reason.full` / CI step with a secret never crosses the wire.
- **E2E:** boot real server, sources enabled + seeded triggers (fake failed CI run, revert commit, `regressed` transition, mapped degradation) → records land + surface via `/failures` + the Process Health tab; `detail.full` never leaks.
- **Wiring-integrity (the silently-stopped-trio lesson — against the REAL hooks):** assert each source is actually constructed + started when its flag is on (not dead code); assert `DegradationReporter`'s native-heal remediator still fires when a failure observer throws; assert `InitiativeTracker.update()` actually invokes the regression emitter on a fresh transition AND that a thrown emitter never rejects `update()`.

## 12. Deferred <!-- tracked: failure-learning-ingestion-sources --> (tracked)

- **CI webhook** (push-based) — future, once the poller proves value; needs a public endpoint + secret.
- **Cross-source correlation** (a CI failure + its revert + a degradation about one root cause auto-linked) — the analyzer's job.
- **LLM categorization** of free-text summaries — kept deterministic (enum-clamp) for now.
- **Secret-scrubbing depth** — v1 does best-effort token/keypattern redaction before storing `full`; a thorough scrubber is its own concern. Until then, `logs/` + `failures.sqlite` are documented as a secret-bearing internal trust zone (security C1).
