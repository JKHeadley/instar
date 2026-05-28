# Side-Effects Review — Release-Readiness Visibility, PR-2b (Layer B core: sentinel + I/O wiring)

**Spec:** docs/specs/RELEASE-READINESS-VISIBILITY-SPEC.md §4.2 (converged + approved).
**Scope of THIS commit:** the dependency-injected `ReleaseReadinessSentinel` (pure decision logic) and `releaseReadinessWiring` (its real git/analyzer/state/Attention I/O bridge), plus their tests. **This commit does NOT yet wire the sentinel into server startup or add the HTTP routes** — so on this commit the sentinel is constructed nowhere (it is not yet live). The server construction + `GET /release-readiness` + `POST /release-readiness/rollback` + config defaults + job template + migrations + integration/E2E land in the following commit on this same (unmerged) branch. Calling this out explicitly to avoid the PR #334 failure mode (sentinels merged as dead code with a false "wired" claim) — nothing here is claimed to be live.

## What changed

- **`src/monitoring/ReleaseReadinessSentinel.ts`** — EventEmitter with injected deps. `tick()` (detect → surface → auto-resolve → reap), `resolveEpisodesInRange()` (publish-finalize hook; ancestry-based so it's correct under oldest-SHA churn), `priorityForAge()`, `reap()`. Blocked-predicate is decoupled from NEXT.md state (commits-with-blocked-guide OR coverage-gaps) so Layer A's auto-draft can't silence the alarm. One deduped signal keyed on the oldest-unreleased-commit SHA; age-scaled priority; 12h hysteresis; fail-loud (every evaluation error → low-priority Attention, never a silent catch). Tier 0.
- **`src/monitoring/releaseReadinessWiring.ts`** — `buildReleaseReadinessDeps()` (real I/O), `isAnalyzableRepo()` (repo-gate), `resolveCanonicalRemote()` (allow-list), `loadReadinessState`/`saveReadinessState` (atomic via temp+rename — no destructive-lint verb), `makeAttentionPoster`.

## Side-effects analysis

**Reach.** Both modules are new, imported by nothing yet. Zero runtime effect on any existing path at this commit. No config, route, job, or migration is introduced here.

**Repo-gated dev-environment scope (spec refinement, documented).** The sentinel analyzes the instar git repo via `analyze-release.js`. That repo only exists in the dev/maintainer environment (Echo's agent home IS the instar checkout). A plain npm-installed agent has no instar repo to analyze. `isAnalyzableRepo()` is the gate the server will consult: on a non-analyzable install the sentinel is simply not constructed (inert) — it never posts a spurious Attention item about a missing repo. This is consistent with the spec's "ships off by default; Echo dogfoods first," and makes explicit a reality the spec under-specified.

**Security / input safety.** All git goes through `SafeGitExecutor` (execFileSync, no shell). The canonical-remote allow-list is anchored on `github.com` host (`^(https://github\.com/|git@github\.com:)JKHeadley/instar(\.git)?$`) — a look-alike host like `git@evil.com:JKHeadley/instar.git` does NOT match (iter-3 adversarial V3); a configured override to a non-canonical URL is permitted but flips `canonicalRemoteOverridden`, which the server will surface as a HIGH-priority signal. The analyzer is spawned via `execFile(process.execPath, [...])` (argv array, no shell). State load tolerates corruption (returns a fresh state rather than throwing into the tick).

**Fail-open vs fail-loud.** The sentinel's contract is fail-loud: `tick()`'s top-level catch and the per-stage `failLoud()` convert fetch/analyzer errors into low-priority Attention items (deduped per failure episode). This is verified by unit tests, and is the core anti-pattern guard (a silent catch would re-create the bug being fixed).

**Rollback.** Deleting the two modules + their tests fully reverts; nothing imports them yet.

## Testing

- Unit (21 green): `ReleaseReadinessSentinel.test.ts` (13 — thresholds, silent-below-threshold, single deduped signal, escalation, coverage-gap blocking, decoupled-from-guide, auto-resolve, fail-loud×2, hysteresis, resolveEpisodesInRange, stale-reap, disabled-no-op); `releaseReadinessWiring.test.ts` (8 wiring-integrity — allow-list, repo-gate, override detection, auto-detect, state round-trip+corruption, all deps are real callables, guideBlocksPublish truth table).
- Integration (HTTP routes) + E2E (feature-alive: reproduce the original stall → one Attention item) land with the server-wiring commit, which is where they become meaningful (a route/E2E can't exist before the route does).
