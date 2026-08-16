# Side-Effects Review — project-scope Phase 1b PR 2 (Drift cache + cost ledger)

**Version / slug:** `project-scope-phase1b-pr2`
**Date:** `2026-05-11`
**Author:** `echo`
**Second-pass reviewer:** `required (new persistent-state + cost-control surface)`

## Summary of the change

Second PR of Phase 1b. Ships the two persistent-state primitives the drift
checker has been operating without since PR 1:

- A verdict cache with mtime fast-path that avoids redundant LLM calls
  when the spec and its referenced files haven't changed.
- A daily-rotated cost ledger that enforces the $1/day per-agent
  spend ceiling the spec requires.

Both classes are usable on their own; `ProjectDriftChecker` now accepts
them as optional config and wires them in around the LLM call. When
neither is passed (the PR 1 contract), behavior is unchanged.

The `POST /projects/:id/drift-check` HTTP endpoint and the per-project
mutex around it ship in PR 3 alongside the round runner. PR 2 is the
data-plane piece; PR 3 is the routing.

Spec source: `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.4 ("Cache key",
mtime fast-path, "Cost ceiling").

New files:
- `src/core/ProjectDriftCheckerCache.ts` (~230 lines) — sha256-keyed
  in-memory verdict cache. Mtime fast-path checks file mtimes against
  the recorded entry before computing the cache key; full-hash path is
  fallback. 24h TTL. Disk-backed snapshot at
  `.instar/drift-verdict-cache.json` so the cache survives restarts
  without a cold first-call after sleep/wake. Snapshot is corruption-
  tolerant (corrupt file → start fresh, will be overwritten on next put).
- `src/core/DriftSpendLedger.ts` (~240 lines) — daily-rotated append-only
  JSONL ledger at `.instar/drift-spend-YYYY-MM-DD.jsonl`. Each `reserve()`
  appends a `{recordId, projectId, estimatedCost, actualCost: null,
  timestamp}` row under an advisory file lock on
  `.instar/local/drift-spend.lock` (proper-lockfile, same options as
  the rest of the codebase). `reconcile(recordId, actualCost)` appends
  a superseding row. `spentToday()` returns the de-duplicated tally.
  `pruneOlderThan()` removes files outside the 30-day retention window
  (via `SafeFsExecutor.safeRmSync`, NOT raw `fs.rmSync`).
- `tests/unit/ProjectDriftCheckerCache.test.ts` (13 cases) — hit/miss,
  mtime fast-path (match, content-change miss, set-shrink invalidation),
  cache-key invalidation on every input (templateVersion, modelId,
  specBody, file content, file rename), TTL expiry, invalidate(),
  disk persistence across instances, corrupt-snapshot tolerance,
  `computeCacheKey` determinism + instability semantics.
- `tests/unit/DriftSpendLedger.test.ts` (13 cases) — default cap matches
  spec, reserve + tally, strict-greater-than boundary at the cap
  (equal-to-cap allowed), reconcile supersedes (no double-count),
  idempotent reconcile, negative/non-finite rejected, JSONL row count
  + shape after reserve+reconcile, lock-coordinated `spentToday`,
  concurrent reserves serialize, `pruneOlderThan` removes old files,
  corrupt row tolerance, `OverBudgetError` exposes cap/spent/estimated.

Modified files:
- `src/core/ProjectDriftChecker.ts` (~+80 lines) — config accepts
  optional `cache` and `ledger`. Order of operations inside `run()`:
  (1) all input validation (unchanged from PR 1) → (2) cache lookup
  (skip LLM on hit) → (3) ledger reserve (return over-budget on cap)
  → (4) LLM call → (5) on success, cache.put + ledger.reconcile.
  LLM-failure verdicts (schema-fail, timeout) are NOT cached; input-
  validation verdicts (over-budget, deleted-files, path-jail-fail) are
  cheap to recompute and don't benefit from caching.
- `tests/unit/ProjectDriftChecker.test.ts` (+5 cases) — cache hit avoids
  LLM, content change forces re-run, over-budget short-circuits before
  the LLM, reserve+reconcile round-trip, LLM-failure not cached.

## Decision-point inventory

- **Cache hit short-circuit** (`ProjectDriftCheckerCache.lookup`) —
  **add** — on hit, returns the cached verdict directly, bypassing
  the LLM. Cache key is `sha256(promptTemplateVersion + modelId +
  specBodySha + sortedFileHashes)`; mtime fast-path bypasses the hash
  but checks `(templateVersion, modelId, all file mtimes)`. Cache
  invariants — TTL, hash key on file content, mtime equality — are
  exercised by 13 unit tests.
- **Daily cap rejection** (`DriftSpendLedger.reserve` → throws
  `OverBudgetError`) — **add** — if `spent + estimated > cap`, throw.
  `ProjectDriftChecker` catches it and returns
  `manual-review-required(over-budget)`. Strict greater-than boundary
  matches the spec (iter-2 correction).
- **Verdict NOT cached on LLM failure** (`run` post-call) — **add** —
  schema-fail / timeout / failed-citation-verification all return
  before the cache write; only `no-drift`, `minor-drift`,
  `premise-violated` reach the put path. A second call gets a fresh
  LLM attempt rather than the previously-cached failure verdict.

All three decisions are conservative: hit-on-content-match (never
hit on stale content), reject-at-strict-cap (never overshoot), no
cached failure (always re-try).

## Over-block vs under-block analysis

### Cache

Over-block risk: returning a stale verdict. The cache key includes the
full sha256 of every relevant input, so a stale verdict can only be
served if (a) file content is unchanged AND (b) within TTL AND (c)
modelId + templateVersion match. The mtime fast-path only fires when
the recorded mtimes match the current stat() results — `touch` without
content change does NOT cause a hit; it forces a full-hash fall-back
that then matches (correct outcome). The 24h TTL is the durable floor
even when nothing else moves.

Under-block risk: cache miss when it should have hit. Acceptable —
correctness costs an extra LLM call. The mtime fast-path is a
performance optimization, not a correctness invariant.

### Ledger

Over-block risk: rejecting a call that wouldn't actually exceed the
cap. Pre-reserve uses the `estimatedCostPerCallUsd` constant (default
$0.01) rather than the call's real cost; in the worst case we
over-reserve and over-block. Acceptable because the cap is the AGENT
ceiling, not a hard per-call limit. Reconcile lowers the recorded
spend back to actual, so subsequent calls aren't penalized.

Under-block risk: under-counting. The strict `>` boundary lets
`spent + estimated == cap` pass; that's the documented behavior, not
a bug. A reservation that's never reconciled (caller crashed) stays as
the pending estimate and contributes to the cap until UTC rollover —
fail-safe rather than fail-open.

The cap is per-machine. On multi-machine setups, the spec documents
the worst-case as `N × cap` per day; the true atomic cross-machine
cap is a same-PR tracked deferred child (`drift-spend-cross-machine`)
referenced in the spec. PR 2 does not change that posture.

## Signal vs authority audit

Neither primitive holds authority. They're persistence + cost-control
plumbing. The drift verdict is still a signal; the cache returns a
prior signal, the ledger throws on overshoot but the resulting verdict
(`manual-review-required(over-budget)`) is again just a signal. The
round-runner in PR 3 holds authority for round-start, combining drift
+ artifact checks.

## Interactions with existing systems

- **`ProjectDriftChecker`.** Both fields are optional — passing
  neither preserves the PR 1 contract exactly. Passing one but not
  the other is supported (cache-only / ledger-only).
- **`proper-lockfile`.** Already a dep (used by AgentRegistry,
  SharedStateLedger, PlatformActivityRegistry). Same `LOCK_OPTIONS`
  shape, same stale-detection convention.
- **`.instar/local/`.** Lock file lives under this machine-local
  subdirectory by spec — same convention as `round-runner.lock` (the
  PR 3 chokepoint). Not git-synced, so two machines don't fight over
  a 0-byte lockfile in the sync layer.
- **`SafeFsExecutor`.** Used for `pruneOlderThan` rather than direct
  `fs.rmSync`, matching the lint-no-direct-destructive contract.
- **Backup / snapshot.** The spec lists
  `.instar/drift-spend-*.jsonl` in the snapshot-include set (so a
  restore can see the prior day's spend); this PR creates the files
  that the existing snapshot job already names — no snapshot code
  change needed.

## Rollback cost

- **Cache.** Revert restores PR 1 behavior. The snapshot file at
  `.instar/drift-verdict-cache.json` becomes orphaned but harmless
  (no other code reads it).
- **Ledger.** Revert restores PR 1 behavior. The JSONL files at
  `.instar/drift-spend-*.jsonl` are orphaned; the existing
  snapshot/cleanup tooling still sweeps them via retention rules.
- **No schema migrations.** Both primitives are file-backed,
  forward-compatible. Older agent versions that don't know about
  these fields ignore them.

## What this PR explicitly defers

Per spec § Phase 1.4 and § Phase 1.5, these belong to drift but ship
in PR 3 (round runner) alongside the consumer that needs them:

- `POST /projects/:id/drift-check` HTTP endpoint with per-project
  mutex. PR 2 ships the primitive; PR 3 ships the route + server
  wiring (cache + ledger instantiation on `AgentServer` startup,
  injection into the routes ctx, mutex map keyed by `projectId`).
- Integration into `ProjectRoundRunner.preflight()` step 10 ("Drift
  check: load cached verdict if fresh + present + all hashes match;
  otherwise run drift").
- Multi-machine "documented worst case is `N × cap` per day"
  visibility — surfacing the per-machine spend in the digest or
  dashboard.

## Verification

- `npm run lint` — passes (tsc + lint-no-direct-destructive).
- `npx vitest run tests/unit/ProjectDriftChecker.test.ts
  tests/unit/DriftSpendLedger.test.ts
  tests/unit/ProjectDriftCheckerCache.test.ts` — 76/76 pass.
- PR 1's 45 existing tests still green; the 5 new cache+ledger
  integration tests assert the contract changes.
