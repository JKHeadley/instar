# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->

## What Changed

`SourceTreeGuard` gained a narrow, opt-in escape hatch for data-pull git operations on the instar source tree. The Release-Readiness Visibility watchdog (Layer B) and the FeatureRolloutReconciler canonical-ref scan (Layer C) both need to `git fetch` canonical `main` into the agent's own instar checkout to do their job — and the agent home IS by-definition an instar source tree. The guard's existing policy ("refuse non-readonly git ops on the source tree" — the 2026-04-22 incident class) caught the watchdog's first real tick on Echo: it correctly fail-louded with `release-readiness-eval-failure-fetch` and Layer C gracefully fell back to the local scan + emitted a degradation event. The architecture surfaced its own integration gap on day one of dogfooding — the principle of "speak up when you skip" worked exactly as designed.

This PR closes the gap principledly: `SafeGitOptions.sourceTreeReadOk?: boolean` (default false) + a closed allowlist `SOURCE_TREE_READ_TIER_VERBS = ['fetch']` lets a specific caller opt into bypassing `SourceTreeGuard` for read-tier git ops. `git fetch <remote> <branch> --no-tags --no-recurse-submodules` writes only to `FETCH_HEAD` and the object database; it does NOT modify the working tree or any committed ref, so from the source-protection standpoint it is read-tier. The bypass is per-call, audit-logged, and the allowlist is small + closed.

Both Layer B (`releaseReadinessWiring.fetchCanonical`) and Layer C (`featureRolloutScan.scanSpecArtifactsCanonical`) opt in at the callsite, so when the watchdog runs against the agent's own instar checkout the canonical-ref fetch goes through.

## What to Tell Your User

- **I can actually watch myself now**: the release watchdog I shipped a moment ago hit its first real safety guard the second I turned it on — and instead of going quiet, it raised a calm flag and explained exactly what was wrong. That self-catch was the architecture working as designed. This update closes the loop so it can fetch the canonical copy it needs without bypassing the broader safety policy.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Opt-in data-pull git on the instar source tree | Pass `sourceTreeReadOk: true` to `SafeGitExecutor.run`/`execSync`/`spawn` (verbs limited to `fetch`) |

## Evidence

Caught live on Echo during the dogfood handoff: with `monitoring.releaseReadiness.enabled: true`, the first tick failed at `fetch` with `SourceTreeGuardError: Refusing to run releaseReadinessWiring:fetch against the instar source tree`. The watchdog correctly raised exactly one LOW-priority Attention item (`release-readiness-eval-failure-fetch`, deduped across re-ticks) and recorded each failure in `logs/sentinel-events.jsonl`. Layer C correctly logged `feature-rollout canonical scan degraded: canonical-ref scan failed (SourceTreeGuardError) — falling back to local scan`. After this PR lands + republishes, the same tick on the same setup proceeds through fetch successfully and produces real backlog signal (or silence below the age threshold). Unit tests (5 in `tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts`) cover the truth table: default-blocks on source, opt-passes on source, non-allowlist-still-blocks on source, allowlist-set is closed.
