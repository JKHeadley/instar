---
title: Git hygiene sentinel for agent-local Instar state
parent-principle: "Structure beats Willpower"
approved: true
eli16-overview: git-hygiene-sentinel.eli16.md
review-convergence: "2026-06-05T19:25:13.297Z"
review-iterations: 2
review-completed-at: "2026-06-05T19:25:13.297Z"
review-report: "docs/specs/reports/git-hygiene-sentinel-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "codex-auth-apikey-forbidden"
---

# Git Hygiene Sentinel for Agent-Local Instar State

## Problem

Instar agents can accumulate local runtime state under `.instar/` and adjacent
agent config files. Some of that state is durable source-like state that should
sync. Some of it is generated, private, machine-local, or secret-bearing. A broad
`git add .instar` collapses that distinction and can repeatedly stage already
tracked runtime files even after a `.gitignore` is corrected.

The observed failure in the Codey checkout was a repository with many tracked
local artifacts: Telegram inbound files, sessions, reports, local config,
machine identity, and similar runtime state. The near-term repair can clean one
checkout, but the product needs to stop future agents from recreating the same
class of history.

## Constitutional Fit

Parent principle: **Structure beats Willpower**.

The fix turns "remember not to stage local runtime state" into a structural
GitSync boundary. Agents should still maintain clean checkouts, but the product
must not rely on attention or local `.gitignore` hygiene when a broad sync path
can enforce the rule mechanically.

## Scope

This change updates the git-sync staging path and file classifier only:

- Classify known Instar agent-local runtime directories as generated/excluded.
- Classify known Instar agent-local secret/config paths as never-sync.
- Match classifier patterns against both basenames and repo-relative paths.
- Before `GitSyncManager` stages files, ask `git status --porcelain -z` for the
  requested path scope and classify each dirty path.
- Skip non-delete dirty paths whose classification is `exclude` or `never-sync`.
- Allow deletions of excluded/secret paths so a cleanup commit can untrack bad
  historical files.
- Keep old add/diff behavior when Git reports no dirty entries for the requested
  path scope.

## Non-Goals

- Do not rewrite existing repository histories.
- Do not push repaired branches automatically.
- Do not make `.instar/config.json`, `.claude.json`, `.mcp.json`, agent tokens,
  machine identities, Telegram inbound files, sessions, reports, or shadow
  installs syncable.
- Do not change conflict resolution behavior for files that are already staged
  by another caller.
- Do not replace external secret scanning tools.

## Acceptance Criteria

- `.instar/config.json`, `.instar/config.json.*`, `.instar/identity.json`,
  `.instar/agent-tokens/`, `.instar/cloudflared-*.yml`, `.claude.json`, and
  `.mcp.json` classify as `secret` / `never-sync`.
- `.instar/messages/`, `.instar/reports/`, `.instar/sessions/`,
  `.instar/shadow-install*`, `.instar/telegram-inbound/`, and `.instar/views/`
  classify as generated / excluded.
- A git-sync commit over `.instar/` stages legitimate state such as
  `.instar/jobs.json` while skipping local secret/runtime paths.
- Deletions remain stageable even when the deleted path would otherwise be
  `exclude` or `never-sync`.
- `git status --porcelain -z` output is parsed without trimming, because leading
  spaces are meaningful status bytes.
- Rename/copy entries in `git status --porcelain -z` stage the destination path,
  not the source path.
- Focused unit tests for `FileClassifier` and `GitSyncManager` pass.
- TypeScript typecheck passes.

## Direction of Failure

If the classifier over-blocks a legitimate local state file, that file remains
local and unsynced; GitSync emits a degradation report with the skipped path and
reason. This is preferable to committing local secrets or high-churn runtime
state.

If the classifier under-blocks a new local runtime path, the previous risk
remains for that path only. The remedy is additive: add the path pattern to
`FileClassifier` and test it.

## Rollback

Rollback is a pure code revert of `FileClassifier`, `GitSync`, and the related
unit tests. No schema or migration is introduced.
