# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->

## What Changed

The **Release-Readiness Visibility** spec (`docs/specs/RELEASE-READINESS-VISIBILITY-SPEC.md`) shipped fully across three PRs (#433, #442, #443). Two silent self-driving-loop gaps are closed:

1. **Auto-draft for upgrade notes (Layer A).** `scripts/analyze-release.js` gained a `--draft-guide` mode that turns the classified commit-range into a starter `upgrades/NEXT.md`. Drafted content carries `auto-draft-unreviewed` markers; both `scripts/upgrade-guide-validator.mjs` (via the new `autoDraftReviewIssues` block in `validateGuideContent`) and `.github/workflows/publish.yml` refuse to ship while any marker remains. A reviewer clears each by replacing the marker with `<!-- reviewed-by: <name> @ <ISO-date> :hash=<sha256> -->` — the SHA captures the canonicalized section at review time, so a later edit invalidates the receipt and re-blocks publish.

2. **Release-readiness watchdog (Layer B).** A new `ReleaseReadinessSentinel` in `src/monitoring/ReleaseReadinessSentinel.ts`. When `monitoring.releaseReadiness.enabled: true` and the install has an analyzable instar git repo (`isAnalyzableRepo` in `src/monitoring/releaseReadinessWiring.ts`), the sentinel is constructed at server boot. The off-by-default `release-readiness-check` cron job drives it via `POST /release-readiness/tick`. The sentinel evaluates canonical `main` (bounded fetch, no `--depth=1` because that shallows the local repo — caught by the real-I/O E2E) and surfaces a stalled release as exactly ONE deduped, age-escalating Attention item keyed on the oldest unreleased commit SHA. Fail-loud: every evaluation error raises a low-priority Attention item, never a silent catch. New routes (bearer-gated): `GET /release-readiness`, `POST /release-readiness/tick`, `POST /release-readiness/rollback` (raises HIGH attention + audits + `rollbackHistory[]` — never a silent kill), `POST /release-readiness/enable`. State file: `.instar/state/release-readiness.json`.

3. **Canonical-ref scan for FeatureRolloutReconciler (Layer C).** `src/core/featureRolloutScan.ts` gained `scanSpecArtifactsCanonical` and `scanSpecArtifactsWithCanonical`. When `featureRollout.canonicalRefScan: true` and a canonical remote is configured, the spec scan reads `docs/specs/` and `.instar/instar-dev-traces/` from canonical `main` directly via `SafeGitExecutor` (`ls-tree` + `show`). A spec present on main is merged by construction — the old `approved && traceExists` inference is replaced with real ancestry. On any failure (no remote, network, parse) → degradation event + graceful fallback to the local scan. Never throws into boot.

The fix path for an existing silent stall: the watchdog opens an Attention item; auto-draft fills NEXT.md but BOTH publish gates refuse it until a human reviews each section (replacing the marker with a hash-locked receipt); rollback flips a state-file kill-switch loudly.

## What to Tell Your User

- **I'll notice if my own ship is stuck**: when changes pile up and a release stops going out, I now raise a single, calm flag on my attention list — and the longer it sits, the louder that flag gets. You don't have to remember to check whether I'm actually shipping; I'll tell you when I'm not.
- **The release notes draft themselves**: instead of waiting for someone to write release notes from scratch, the toolchain now sketches a starter version from the change list. A human still has to read and sign off on each section before it can publish — the safety net stays in place; it just isn't a blank page anymore.
- **A merged feature can no longer be invisible to my own systems**: my feature board used to read whatever was on my laptop, which sometimes meant brand-new merged features didn't show up. It can now read the real shared copy directly, so the newest work stops being the most-hidden work.

This change is off by default everywhere. I'll dogfood it on myself first.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Release-readiness watchdog | `GET /release-readiness` (status) · `POST /release-readiness/tick` (run once) · `POST /release-readiness/rollback` (loud disable) · `POST /release-readiness/enable` |
| Auto-draft an upgrade guide | `node scripts/analyze-release.js --draft-guide` (writes `upgrades/NEXT.md` with unreviewed markers) |
| Canonical-ref spec scan | Set `featureRollout.canonicalRefScan: true` and `featureRollout.canonicalRemote` in `.instar/config.json` |
| Enable the watchdog | Set `monitoring.releaseReadiness.enabled: true` in `.instar/config.json`; the `release-readiness-check` job runs every 6h (still ships disabled — flip it on per agent) |

## Evidence

The Layer B real-I/O E2E (`tests/e2e/release-readiness-live.test.ts`) reproduces the original silent-stall shape against a fixture instar repo (real git fetch + real `analyze-release.js` subprocess + real `merge-base`) and asserts that exactly one Attention item is raised for an aged, blocked backlog. The Layer A unit tests (`tests/unit/analyze-release-draft-guide.test.ts` and `tests/unit/upgrade-guide-autodraft-review.test.ts`) reproduce the placeholder-text bypass adversarial review caught (the analyzer's `'Review the commit for specifics'` fallback that previously could pass the section-presence gate) and confirm the new validator blocks it. The Layer C unit test (`tests/unit/featureRolloutScan-canonical.test.ts`) reproduces the exact bug — a spec deleted from the local working tree but committed to main — and confirms the canonical scan still detects it as merged. ~64 tests added across three layered tiers, all green.

Additionally, this very NEXT.md authoring revealed the meta-failure: the two PRs above merged but their publishes silently skipped because **NEXT.md didn't exist** — exactly the silent-skip mechanism Layer A + Layer B were built to surface. This guide is the unblock; once it publishes, the watchdog this guide describes goes live and can catch the same shape next time.
