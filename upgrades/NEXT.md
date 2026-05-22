# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**feat(docs-coverage-weekly): weekly audit job + GitHub Actions cron that surface accumulated docs drift.**

Companion to the per-PR docs coverage gate that shipped in v1.2.21. The per-PR gate catches regression, but coverage can stagnate at the floor indefinitely if every PR just barely scrapes by. This release adds the trend-surface piece: a weekly check that catches accumulated drift even when the per-PR gate is satisfied.

Two delivery surfaces, both light and both off the critical path:

1. **Job template** — `src/scaffold/templates/jobs/instar/docs-coverage-audit.md` ships as an agentmd job, `enabled: false` by default. Instar-developing agents (the ones with the instar source repo on their machine) can flip it to `true` in their local `.instar/jobs/instar/docs-coverage-audit.md`. Once enabled, the job runs every Monday at 10:00 local time, locates the instar source repo, executes the coverage script, compares to the prior week's baseline, and sends a Telegram heads-up if anything drifted in an interesting way. Most weeks stay silent — that means docs are keeping up.

2. **CI workflow** — `.github/workflows/docs-coverage-weekly.yml` runs every Monday at 10:00 UTC against the main branch. Posts the weekly report as a comment on a standing tracking issue tagged `docs-coverage`. Creates the issue on first run; appends weekly thereafter. Provides a durable, GitHub-native ledger of how coverage moves over time.

Both surfaces are signals, not authorities. Neither fixes docs autonomously. The per-PR gate from v1.2.21 remains the authoritative regression check; these surface the trend.

Spec: `docs/specs/docs-coverage-weekly.md`. ELI16: `docs/specs/docs-coverage-weekly.eli16.md`. Side-effects review: `upgrades/side-effects/docs-coverage-weekly.md`.

## What to Tell Your User

Nothing user-visible. The job is off by default and would only apply to agents that develop instar itself. The workflow runs in instar's own GitHub Actions, not the user's.

## Summary of New Capabilities

This release adds a single new job template (off by default) and a single new CI workflow. Both target the instar-developer use case rather than the end-user agent. No new agent runtime behavior.

## Evidence

The coverage script that both surfaces invoke was shipped and tested in v1.2.21. The job template was verified to parse with valid frontmatter. The workflow YAML validates against GitHub Actions schema. Both files were verified to install via existing pipelines: `installBuiltinJobs()` walks the templates directory on every install and update, and the workflow runs from `.github/workflows/` like every other workflow in the repo.
