<!-- bump: patch -->

# `instar dev:claim-check` — pre-build parallel-claim advisory

## What to Tell Your User

Nothing user-visible. A new developer command helps parallel agent sessions avoid building the same fix twice.

## Summary of New Capabilities

- `instar dev:claim-check <paths...> [--keywords <words...>]` — run BEFORE starting a build: lists open PRs and recently-merged PRs (default 2-day window, `--merged-days`) touching the paths you intend to build on, plus `docs/specs/*.md` whose head matches the keywords.
- Advisory by default (exit 0); `--strict` exits 1 on any overlap (or when `gh` is unavailable, since the claim space could not be verified) so scripted flows can gate on it.
- Read-only: GET-only `gh` calls + local spec reads. `gh` failure degrades loudly to spec-scan-only.

## What Changed

New `src/commands/devClaimCheck.ts` + CLI registration + a CLAUDE.md-template awareness line (Agent Awareness Standard). Earned from the 2026-06-05 double collision: #802 re-scoped against a sibling's spec, then #810 superseded #808's SecretStore layer mid-CI — topic-level parallel-work awareness doesn't see PR/spec-level claims; this closes that gap at the moment it matters.
