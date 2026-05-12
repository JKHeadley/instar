# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Project-scope Phase 1b PR 2 — drift cache + cost ledger

Second PR of project-scope Phase 1b. Adds two persistent-state
primitives the drift checker has been operating without since v0.28.93:

- **Verdict cache** — `ProjectDriftCheckerCache`. 24-hour TTL,
  mtime-fast-path before computing the cache key, disk-backed
  snapshot at `.instar/drift-verdict-cache.json` so the cache
  survives restarts. When file mtimes match the recorded entry and
  template version + model id are unchanged, the prior verdict is
  returned without re-hashing or calling the model. When content
  changes, the cache key shifts and the LLM is consulted again.

- **Cost ledger** — `DriftSpendLedger`. Daily-rotated append-only
  JSONL at `.instar/drift-spend-YYYY-MM-DD.jsonl` enforcing the
  spec's $1/day per-agent spend cap. Strict-greater-than boundary
  (equal-to-cap is allowed; one cent over is not). Pre-reservation
  rows are append-only and reconciled with the actual spend after
  the call. Lock-coordinated on `.instar/local/drift-spend.lock`
  via proper-lockfile (same convention as AgentRegistry and
  SharedStateLedger). 30-day retention; older files are pruned
  through `SafeFsExecutor.safeRmSync`.

Both are optional fields on `ProjectDriftChecker`'s config. The
v0.28.93 contract — neither cache nor ledger — is preserved
exactly when neither is passed. Wiring into the round runner
(consumer) ships in the next PR.

## What to Tell Your User

- **Drift checks won't burn budget**: I now have a daily spending cap
  on the model calls that power drift checks, plus a cache so I don't
  pay for the same check twice. You don't have to do anything; it just
  works. If I ever hit the daily limit, I escalate to you rather than
  silently overspending.

## Summary of New Capabilities

- `ProjectDriftCheckerCache` class — sha256-keyed verdict cache with
  24-hour TTL, mtime fast-path, and disk-backed snapshot at
  `.instar/drift-verdict-cache.json`. Avoids redundant LLM calls when
  spec + referenced files are unchanged.
- `DriftSpendLedger` class — daily-rotated JSONL cost ledger
  (`.instar/drift-spend-YYYY-MM-DD.jsonl`) enforcing a $1-per-agent
  per-UTC-day spend cap. Lock-coordinated via proper-lockfile. Exposes
  `reserve()`, `reconcile()`, `spentToday()`, `pruneOlderThan()`,
  and the `OverBudgetError` thrown class.
- `ProjectDriftChecker` config now accepts optional `cache`, `ledger`,
  and `estimatedCostPerCallUsd` fields. Backwards-compatible: passing
  neither preserves the v0.28.93 contract.
