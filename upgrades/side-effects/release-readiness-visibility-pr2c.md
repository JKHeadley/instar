# Side-Effects Review — Release-Readiness Visibility, PR-2c (Layer B wired live)

**Spec:** docs/specs/RELEASE-READINESS-VISIBILITY-SPEC.md §§4.2 / 4.3.1 / 4.2.7 / 7 / 10.
**Scope of this commit:** make Layer B actually live — server construction (gated on an analyzable instar repo + config), the four HTTP routes, the off-by-default cron job, config defaults + migrations (config + CLAUDE.md), and the integration + real-I/O E2E that prove it. Plus the four new rollback/enable/snapshot/disabled methods on the sentinel that PR-2b's commit couldn't fully ship without the routes.

## What changed

- **`src/commands/server.ts`** — constructs `ReleaseReadinessSentinel` IFF `config.monitoring.releaseReadiness.enabled` AND `isAnalyzableRepo(repoPath)` (default repoPath = process.cwd()). NOT `start()`ed — the off-by-default cron job is the cadence (one tick per cron). On an inert install (no instar repo or feature off) the sentinel is null and the routes 503 — never a spurious signal.
- **`src/server/AgentServer.ts` + `src/server/routes.ts`** — `releaseReadinessSentinel` plumbed through `AgentServerOptions` → `RouteContext`. Four routes added: `GET /release-readiness` (read-only snapshot + `X-Readiness-Source` header), `POST /release-readiness/tick` (the cron entry point), `POST /release-readiness/rollback` (loud — raises a HIGH Attention item + audits, can't silently mute the alarm; iter-3 V5), `POST /release-readiness/enable` (re-arm).
- **`src/monitoring/ReleaseReadinessSentinel.ts`** — added `disabled` to `ReadinessState`, `tick()` no-ops when disabled (writes a `tick-skipped-disabled` audit), and added `snapshot()` / `rollback({sessionId, sourceIp})` / `enable()` methods. Rollback resolves all open episodes, persists the `rollbackHistory` audit, and posts the HIGH "alarm disabled" Attention item before saving state.
- **`src/monitoring/releaseReadinessWiring.ts`** — **production-bug fix discovered by the E2E**: the spec's `--depth=1` fetch SHALLOWS the local repo, which breaks `git log <tag>..ref` in `analyze-release.js` (commit count silently becomes 0 → the sentinel goes silent on a real backlog — the exact failure mode the spec exists to fix). Dropped `--depth=1`; `--no-tags --no-recurse-submodules` keeps incremental fetches bounded without shallowing. **This is the kind of bug only the E2E could catch — unit tests with stubbed deps would have passed.**
- **`src/core/types.ts`** — `MonitoringConfig.releaseReadiness` block (kill switch + thresholds + hysteresis + TTL + fetch timeout + canonical-remote + repoPath overrides).
- **`src/config/ConfigDefaults.ts`** — default block under `monitoring.releaseReadiness` (ships OFF). Existing agents pick it up automatically: `applyDefaults` adds missing keys, never overwrites — migration parity is automatic.
- **`src/core/PostUpdateMigrator.ts`** — `migrateClaudeMd` appends a Release Readiness section to existing agents' CLAUDE.md, content-sniffed on the `/release-readiness` marker (Agent Awareness Standard).
- **`src/scaffold/templates.ts`** — new agents get the same paragraph in the rendered CLAUDE.md.
- **`src/scaffold/templates/jobs/instar/release-readiness-check.md`** — declarative cron job, `enabled: false`, schedule `0 */6 * * *`, model `haiku`. Body curls `POST /release-readiness/tick`; reports nothing (the sentinel owns all signalling).

## Side-effects analysis

**Reach.** All new code is gated. The sentinel is constructed only when (a) config enables it AND (b) `isAnalyzableRepo(repoPath)` returns true. On an npm-installed agent with no instar repo, the sentinel stays null and the routes 503 — zero behavior change. The job ships `enabled: false`. The CLAUDE.md migration is content-sniffed (idempotent).

**Rollback semantics (iter-3 V5).** `POST /release-readiness/rollback` cannot be a silent kill: it ALWAYS raises a HIGH-priority Attention item ("Release-readiness alarm disabled by session X at T"), writes a `rollbackHistory[]` entry to the readiness state, and emits a `rollback` audit line. A compromised/confused session calling rollback is loudly visible. `enable` re-arms cleanly.

**Production bug caught.** The `--depth=1` shallow-fetch bug (now fixed) would have silently broken the watchdog on every install after the first fetch — the alarm would have been *quiet for the exact reason it was built*. Caught by the real-I/O E2E (fixture git repo + real `analyze-release.js` subprocess + real fetch). Without that test, we would have shipped the failure mode the spec exists to fix.

**Sentinel-vs-cadence design.** Spec §4.2.1 said "host: a new declarative job." The class also exposes `start()`/`stop()` (self-ticking via setInterval) for tests + alt wiring. The SERVER does NOT call `start()` — the cron job is the single cadence driver, calling `POST /release-readiness/tick`. This avoids double-ticking and gives operators full control via the job's `enabled` flag.

**Migration parity.** Config defaults: handled automatically by `applyDefaults` (existing agents get the missing `monitoring.releaseReadiness` block on next migration). CLAUDE.md: explicit `migrateClaudeMd` block (Agent Awareness). Job template: shipped via the existing `InstallBuiltinJobs` always-overwrite path (operator `enabled` override is preserved per-slug). All three migration-parity standard surfaces covered.

**Rollback if reverted.** Reverting this PR removes the sentinel construction, routes, job template, config block, and CLAUDE.md mention. On existing agents post-revert: the config key + CLAUDE.md section become orphaned but harmless (no code references them). The state file `.instar/state/release-readiness.json` is left in place (cheap, ignored).

## Testing

Full layered coverage, all green (47 tests across 7 files this PR):
- **Unit (40):** `analyze-release-ref-flag` (4), `analyze-release-draft-guide` (8), `upgrade-guide-autodraft-review` (7 — marker blocks, hash-locked receipts pass/block on tamper/age/missing-hash), `ReleaseReadinessSentinel` (13 — thresholds, dedupe, escalation, decoupled-from-guide, auto-resolve, fail-loud, hysteresis, resolveEpisodesInRange, stale-reap), `releaseReadinessWiring` (8 — allow-list, repo-gate, override detection, state round-trip, deps-are-real, guide-blocks truth table).
- **Integration (5):** real routes + real sentinel + controllable deps. Proves: route is 200 not 503 (alive), 503 when sentinel null (correctly inert), blocked+aged backlog → exactly one Attention signal (the original silent-stall bug reproduced + surfaced), clean backlog → no signal, rollback is loud and reversible.
- **E2E (2):** real `fixture` instar repo + real canonical remote + REAL git fetch + REAL `analyze-release.js` subprocess + REAL `merge-base`. Drives `sentinel.tick()` end-to-end and proves the wiring works against real I/O. Caught the `--depth=1` shallowing bug.
