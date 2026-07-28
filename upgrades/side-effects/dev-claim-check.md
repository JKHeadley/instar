# Side-Effects Review — `instar dev:claim-check`

**Version / slug:** `dev-claim-check`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane (read-only dev tooling, no runtime/server surface)`

## Summary of the change

New read-only developer command: pre-build advisory listing open + recently-merged PRs that touch the paths you intend to build on, and local specs matching optional keywords. Earned from the 2026-06-05 parallel-session double collision (#802 vs the keychain spec; #810 vs #808).

## Decision-point inventory

- `findPrOverlaps` — add — pure path-overlap semantics (exact match or directory-prefix in either direction, `/`-boundary safe).
- `findSpecMatches` — add — pure case-insensitive keyword match against spec file heads (first 2KB).
- `runDevClaimCheck` — add — orchestration: gh queries (open, merged-within-window), spec scan, report, exit-code policy.
- CLI registration (`dev:claim-check`) — add — paths variadic + `--keywords/--merged-days/--repo/--strict`.
- CLAUDE.md template — modified — one awareness line in the contributor-tools block (Agent Awareness Standard).

## 1. Over-block

None possible: advisory by default (always exit 0 on findings). `--strict` is opt-in for scripted flows; its only block-shaped behavior is exit 1 — and it also exits 1 when `gh` is unreachable, on the principle that strict mode must not bless an UNVERIFIED claim space. A false-positive overlap costs the developer one read of a PR title.

## 2. Over-permit

The command mutates nothing (GET-only `gh` invocations, local reads). No new permissions, no token handling beyond the ambient `gh` auth.

## 3. Failure modes

- `gh` absent/unauthenticated/network down → LOUD stderr warning ("PR overlap NOT checked"), spec scan still runs, advisory exit 0 / strict exit 1.
- No `docs/specs/` dir (non-instar repo) → empty spec scan, no error.
- Unreadable individual spec file → skipped (advisory scan).
- PRs with >100 changed files: the `gh pr list --json files` payload truncates at GitHub's per-PR file cap — a known recall limit for giant PRs, acceptable for an advisory (giant PRs are visible by title anyway).

## 4. Migration parity

CLAUDE.md template change rides the existing template-refresh path on update (`generateClaudeMd()` consumers); no config/hook/skill changes, no `PostUpdateMigrator` entry needed.

## 5. Token/cost impact

None. No LLM calls. Two `gh` REST calls per invocation, developer-initiated only.

## 6. Rollback

Revert the commit; the command disappears, nothing else depends on it.
