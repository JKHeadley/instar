# CrossReview Synthesis: COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md

**Models reviewed**: GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast
**Date**: 2026-04-26

## Overall verdict

All three models score the spec 8–9/10 with CONDITIONAL approval. None recommended rejection or fundamental redesign. Each found 2–3 critical issues and several gaps; many of these were addressed by the spec edits applied 2026-04-26 in response to (a) principal directive (comprehensive-first + 10× tighter time horizons) and (b) the cross-review findings themselves.

## Consensus findings (all 3 models agreed)

1. **Layer A LLM gate needs a fallback** for when the LLM is unavailable. Single point of failure in dev workflow.
   → **Addressed**: spec now defines a fail-closed regex fallback that pauses with explicit principal-confirmation requirement.

2. **Lint coverage is narrower than the "comprehensive" framing suggests.** Various bypass surfaces (namespace imports, dynamic require, aliased imports, shell-quoted verbs, env-var redirection) need explicit handling.
   → **Partially addressed**: spec now covers namespace imports (Gemini), env-var denylist (GPT), and notes the format-patch shape check (Grok). Dynamic-require, shell-quoting, and git-aliases are still residual; planned to be tightened in implementation rather than respec'd.

3. **Self-compliance contradiction in the initial draft** — the spec's own deferred items included a `recurrence-risking` one (safe-fs-extension) but the self-compliance check claimed none were.
   → **Addressed**: principal directive applied; safe-fs-extension and ci-mutation-detector pulled in-scope; zero `recurrence-risking` deferrals remain.

## Unique catches

### GPT 5.4 (unique)
- **Env-var redirection bypass**: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*` accepted in `SafeGitOptions.env` without constraint. Strong real attack surface. **Addressed** via env denylist on the `SafeGitOptions.env` field.
- **`write-tree` classification contradiction**: listed in DESTRUCTIVE_GIT_VERBS but tested as read-only. **Addressed** by moving `write-tree` to READONLY_GIT_VERBS with explanation that it adds objects only.
- **Path canonicalization gap**: `cwd` / `-C` / `--git-dir` / `--work-tree` not canonicalized via realpath. **Addressed** by adding canonicalization at SafeGitExecutor boundary.
- **"Comprehensive" framing overstated**: Bash tool / npx / terminal use bypass everything. **Acknowledged** — these are external invocations covered by PR #96 constructor guard, the new CI mutation detector, and classic branch protection on origin. Not a clean closure but the compensating layers are real.

### Gemini 3.1 Pro (unique)
- **Namespace-import bypass**: `import * as fs from 'node:fs'; fs.rmSync(...)` not flagged by initial AST rule. **Addressed** in SafeFsExecutor section.
- **Submodule / symlink edge cases**: spec's worktree handling doesn't enumerate submodule layouts. Residual gap; planned for implementation.
- **Cross-platform path normalization (Windows)**: spec is POSIX-shaped. Acceptable — instar is macOS/Linux only per current policy.

### Grok 4.1 Fast (unique)
- **`format-patch` over-blocked**: conditional verb included in destructive list without arg-shape check. **Addressed** via shape-check routing.
- **Marker file false-negative**: if `.instar-source-tree` is accidentally deleted, the marker layer fails open silently. Three-layer detection in PR #96 (marker + remote + signature) makes this a partial fail-open at worst — the other two layers still fire. Residual gap; could add periodic marker regeneration in a future commitment.
- **No formal security section / no audit log**: spec lacks adversarial-caller threat model and post-ship monitoring. Residual gap; planned in implementation.

## Divergence

Models did not contradict each other on any finding. They flagged different residuals from different angles, which is exactly the point of cross-model review.

## Model strengths observed

- **GPT**: best at attack-surface analysis and finding contradictions in the design's internal invariants. Caught the env-var bypass and the write-tree classification mismatch.
- **Gemini**: best at threading the spec's rules back to the spec itself ("does this spec follow its own rules?") and at edge cases in shared-with-external-systems contracts (namespace imports, cross-platform).
- **Grok**: best at production-readiness (failure modes of the dev tooling itself, post-ship monitoring, scalability across user count). Caught the LLM-fallback gap and the format-patch over-block.

## Prioritized recommendations status

| # | Finding | Source | Status |
|---|---------|--------|--------|
| 1 | Layer A LLM fallback | All 3 | Addressed (regex fallback) |
| 2 | Env-var redirection bypass | GPT | Addressed (denylist) |
| 3 | write-tree classification | GPT | Addressed (moved to READONLY) |
| 4 | Path canonicalization (cwd, -C, --git-dir, --work-tree) | GPT | Addressed |
| 5 | Self-compliance contradiction | Gemini | Addressed (in-scoped) |
| 6 | Namespace-import lint coverage | Gemini | Addressed |
| 7 | format-patch shape check | Grok | Addressed |
| 8 | Time horizons too lax | (Justin) | Addressed (10× tightened) |
| 9 | Strong anti-deferral pressure | (Justin) | Addressed (principal-deferral-approval gate) |
| 10 | Dynamic-require lint | Grok | Residual — implementation tightening |
| 11 | Shell-quoting variants | Grok | Residual — implementation tightening |
| 12 | Git aliases | Grok | Residual — implementation tightening |
| 13 | Marker file regeneration | Grok | Residual — could become a tracked commitment if relevant |
| 14 | Audit logging / post-ship monitoring | Grok | Residual — could become a tracked commitment |
| 15 | Bash tool / npx / terminal external boundary | GPT | Acknowledged — PR #96 + CI detector + branch protection cover |

## Convergence verdict

**External cross-review converged.** Items 1–9 addressed in spec. Items 10–15 are residual gaps that either (a) tighten in implementation rather than redesign, or (b) acknowledge a real boundary the spec cannot close on its own and rely on existing compensating mechanisms. The spec is ready for principal review and approval, with one of the cross-review residuals (audit logging) potentially worth converting into a paired commitment depending on principal preference.
