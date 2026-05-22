# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = new capability (ORG-INTENT drift detection — Phase 4, code already on main but unreleased due to a rebase artifact). -->

## What Changed

**chore(release): cut Phase 4 of the ORG-INTENT runtime project.**

Phase 4 (periodic drift detection) merged on main in PR #319 but did not publish to npm at that time. The Phase 4 NEXT.md content was absorbed into `upgrades/1.2.26.md` (the heal-fix release) during the rebase that resolved the conflict between my branch and the just-cut release. The Phase 4 CODE — `OrgIntentDriftAnalyzer`, the `GET /intent/org/drift` route, the weekly audit job template, and the CLAUDE.md migration — has been sitting on main since PR #319 merged but is not yet on npm.

This PR is a fresh NEXT.md to trigger the publish workflow. No code changes — Phase 4 is already in the tree.

After this publishes, the complete four-phase ORG-INTENT runtime project will be available on npm:

- Phase 1 (v1.2.23): gate-time enforcement of constraints.
- Phase 2 (v1.2.24): session-start injection of the three-rule contract.
- Phase 3 (v1.2.25): deterministic tradeoff helper.
- Phase 4 (this release): periodic drift detection + weekly audit job.

Spec: `docs/specs/ORG-INTENT-DRIFT-DETECTION-SPEC.md`.
ELI16 companion: `docs/specs/ORG-INTENT-DRIFT-DETECTION-SPEC.eli16.md`.
Side-effects review: `upgrades/side-effects/org-intent-drift-detection.md`.

## What to Tell Your User

The drift detection capability that was supposed to ship in the prior release was a release-pipeline misfire — the code landed but the publish skipped. This release re-cuts that work so the new endpoint and the weekly audit job become available via `npm install instar`. No behavior change from the prior release if you don't act on it; if you have an `ORG-INTENT.md` authored and want the weekly drift check, enable the new `org-intent-drift-audit.md` job.

## Summary of New Capabilities

(All shipped in PR #319 — this release just publishes them.)

- **GET /intent/org/drift** — HTTP route returning a drift digest derived from recent Coherence Gate review history.
- **`analyzeOrgIntentDrift()` exported function** — pure logic helper.
- **Weekly drift audit job template** — `.instar/jobs/instar/org-intent-drift-audit.md`, off by default.
- **Migration parity** — CLAUDE.md gains Phase 4 curl line automatically on next update.

## Evidence

All test evidence is in PR #319's release notes (now in `upgrades/1.2.26.md`). This PR is a no-op release cut.
