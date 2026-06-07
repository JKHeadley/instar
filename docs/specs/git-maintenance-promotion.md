---
title: Git Maintenance Promotion
status: converged
review-convergence: "2026-06-06T22:35:00-07:00"
approved: true
eli16-overview: git-maintenance-promotion.eli16.md
---

# Git Maintenance Promotion

## Problem

Agent homes accumulate local runtime artifacts, generated state, machine-local config, and old recovery files. When those paths enter git tracking, ordinary work becomes risky: agents cannot tell clean source changes from local operational residue, git-sync becomes noisy, and review history hides real behavior changes inside cleanup churn.

Codey dogfooded a local git hygiene classifier and maintenance script that separated source, identity, runtime, generated, sensitive, and unknown paths. It safely removed ignored runtime artifacts from git tracking with `git rm --cached` while leaving files on disk, then produced a clean audit report.

## Goal

Promote that proven local capability into the shared Instar distribution so every agent can self-audit git hygiene, and existing agents receive the scripts and scheduled job on upgrade.

## Design

- Ship `git-hygiene-classify.mjs` and `git-maintenance.mjs` as framework-neutral templates under `.instar/scripts`.
- Install both scripts during fresh init and existing-project refresh.
- Deploy both scripts during post-update migration so existing agents receive classifier improvements.
- Add a built-in AgentMD `git-maintenance` job that runs audit mode and writes durable reports.
- Keep repair mode explicit: `--apply` only removes files from the git index when they are already covered by ignore rules; it never deletes files from disk.
- Extend built-in manifest generation to include AgentMD job templates.
- Update the infrastructure overseer prompt so the new job is reviewed with other plumbing.

## Acceptance Criteria

- Fresh installs receive both executable scripts.
- Existing agents receive both executable scripts after migration.
- The built-in `git-maintenance` AgentMD job is installed with a per-slug manifest.
- The default scheduled behavior is audit-only and non-blocking.
- Lint and focused tests pass.
- The side-effects review confirms the classifier remains a signal, not a brittle blocking authority.

## Non-Goals

- This is not a secret scanner. It detects suspicious paths, not secret contents.
- This does not auto-commit, auto-push, or auto-rewrite arbitrary repositories.
- This does not auto-add ignore rules for every unknown path.
