# Grok 4.1 Fast Review: COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md

**Model**: grok-4-1-fast
**Date**: 2026-04-26
**Focus**: full document
**Score**: 9/10
**Status**: CONDITIONAL (Approve after addressing Critical Issues)

## Critical Issues (Must Fix)

1. **Layer A LLM classifier has no fallback for API failure.** Lacks behavior when LLM is unavailable (rate limit, outage). Single point of failure in dev workflow. Fix: regex-based fallback flagging deferral keywords ("defer", "follow-up", "out-of-scope"), with LLM as primary and regex as last-resort backup. Add tests.

2. **Lint rule misses dynamic / obfuscated callers.** Misses dynamic `require('child_process')` via dynamic-require / eval, and shell grep doesn't handle quoted/escaped git verbs (`git "add"`). Fix: AST flag `require('child_process')` and `import('child_process')` outside allowlist; shell parser should handle quoted variants.

3. **`format-patch (when used with --inline)` conditional miss.** `DESTRUCTIVE_GIT_VERBS` includes the conditional but verb extraction treats all `format-patch` as destructive. Over-blocks legitimate uses. Fix: move conditional verbs to `readSync` shape validation.

## Strengths

- Exhaustive inventory and migration plan (~45 destructive + ~30 read-only callsites, bisectable migration order).
- Defense-in-depth: constructor / funnel / lint / governance layers, with belt-and-suspenders dual cwd/-C checks.
- Self-compliance section validates the rule the spec introduces.
- Test plan covers escape hatches, bypasses, and meta-layers.
- Rollback simplicity: per-commit revert with inert orphans post-rollback.

## Gaps

- Git aliases: `git foo` where `foo` is aliased to a destructive verb is not detected.
- Marker file false-negative: if `.instar-source-tree` is accidentally deleted, the assertion's marker layer fails open. No periodic regeneration or multi-marker fallback.
- Assumes all git calls use `execFileSync` / `spawn`. Misses `isomorphic-git` or future pure-JS libraries.
- No formal security section (adversarial callers, e.g., compromised skill injecting bad cwd).
- No cost analysis or post-ship monitoring story (audit log, blocked-attempt alerting).

## Industry comparison

Mirrors Google's Tricorder + Bazel lint + Piper presubmits for monorepo git hygiene. SafeGitExecutor pattern akin to Sapling's verb-based wrappers. Aligns with zero-trust devtools (AWS CodeCatalyst, GitHub Codespaces). Meta-pattern fix counters the "spec-as-ticket" anti-pattern.

## Scalability

- Phase 1 (10–50 users): negligible overhead.
- Phase 2 (50–500 users): caching keeps Layer A LLM cost ~$0.01/spec.
- Phase 3 (500–5000 users): minor — Layer A caching needs repo-wide invalidation on spec changes; consider git hook trigger.
- Spike handling: 10× load handled via caching + Haiku speed; regex fallback prevents LLM-outage DoS.

## Top recommendations (prioritized)

1. Resolve critical issues before PR: dynamic-require lint, Layer A fallback, format-patch shape check.
2. Pick `commitments/` dir location now (Grok suggests top-level for grep/discoverability).
3. Add security section + SafeGitExecutor audit logging to `.instar/audit.json`.
4. Extend verb extraction for git aliases.
5. Post-ship metrics (Prometheus exporter or job for call counts / blocked attempts).
