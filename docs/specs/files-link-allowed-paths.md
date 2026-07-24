---
title: "files/link honors the shared allowed-path policy (drifted-duplicate fix)"
slug: "files-link-allowed-paths"
author: "Echo"
parent-principle: "Structure beats Willpower"
status: "approved"
approved: true
approved-by: "Drive 11 pre-approved autonomous session (topic 29723, operator-authorized 2026-07-23); fixes the /api/files/link 403 bug hit live during the dashboard verification loop (cycle 24, logged as a queued small fix) — reversible, behavior-restoring, per the drive's decision delegation"
review-convergence: "2026-07-24T12:58:00Z"
review-iterations: 1
review-completed-at: "2026-07-24T12:58:00Z"
cross-model-review: "Live repro on the deployed server (default config 403s .claude/CLAUDE.md); line-by-line comparison of the inline check vs validatePath Layer 4; full file-viewer e2e suite green post-refactor (96 tests)"
eli16-overview: "files-link-allowed-paths.eli16.md"
single-run-completable: true
---

# files/link Honors the Shared Allowed-Path Policy

Status: implemented in the same PR (behavior-restoring fix + policy unification)

## Problem (live repro, 2026-07-23 Drive 11 cycle 24)

`GET /api/files/link?path=.claude/CLAUDE.md` returned
`403 Path not in allowed directories` on a server whose file-viewer config was
the DEFAULT `allowedPaths: ['./']` — the widest possible setting. Every link
request failed; the dashboard deep-link feature was dead under its own default.

## Root cause — a drifted duplicate of the policy

The link route carried its own inline allowed-path check instead of flowing
through `validatePath`. The duplicate drifted from the canonical Layer-4
logic in three ways:

1. It never learned the `'.'`/`'./'` project-root convention — so `'./'`
   (the default) matched nothing (`'.claude/CLAUDE.md'.startsWith('./')` is
   false), and every request 403'd.
2. It matched prefixes without a segment boundary (`docs` would admit
   `docs-secret/…`).
3. It skipped the absolute-path and traversal rejections entirely (with
   `allowedPaths: ['.']`, `'../…'` passed the inline check because `'..'`
   starts with `'.'`). Low severity — the route emits a URL, not file
   content — but wrong.

This is the exact failure mode "Structure beats Willpower" names: the policy
lived in two places, and the copy rotted.

## Design

Extract Layers 1–4 (normalize, reject absolute, reject traversal,
never-served deny, allowedPaths match) into ONE exported pure helper,
`checkRelativePathAllowed(requestedPath, config)`. Both `validatePath` and
the link route flow through it. The inline duplicate is deleted.

## Non-goals

- No change to Layer 5 (symlink resolution / post-realpath re-checks) —
  the link route still does not resolve files (it emits a URL; the read
  endpoints enforce the full stack on access).
- No config or response-shape changes.

## Verification

- Unit (`tests/unit/fileRoutes-link-allowed-paths.test.ts`): both sides of
  every boundary — root conventions `'./'`/`'.'`, scoped path self+children,
  segment boundary, absolute/traversal/never-served rejections, normalized
  output; route-level regression pin (default config → 200, was blanket 403);
  bad paths still 403; missing param still 400.
- Full file-viewer e2e suite green post-refactor (96 tests across the three
  file-route suites) — `validatePath` behavior preserved.
