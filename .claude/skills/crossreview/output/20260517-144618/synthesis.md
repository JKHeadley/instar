# CrossReview Synthesis: AGENT-WORKTREE-CONVENTION-SPEC.md (Round 3)

**Review ID**: 20260517-144618
**Date**: 2026-05-17
**Models**: GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast
**Document**: /Users/justin/.instar/agents/echo/.worktrees/spec-agent-worktree-convention/docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md
**Focus**: Round 3 convergence — verify Round 2 fixes and surface new material issues

---

## Overall Assessment

**Consensus Status**: CONDITIONAL (one new material issue + one new race condition; otherwise converged)

| Model | Status | Score | Key Finding |
|-------|--------|-------|-------------|
| GPT 5.4 | CONDITIONAL | 9/10 | Layer 4 conflates `repoAllowlist[0]` (remote URL) with a local repo path |
| Gemini 3.1 Pro | APPROVE (with one pre-merge fix) | 9.5/10 | 1MB ledger rotation in concurrent CLI is a race; move to single-threaded layer or `flock` |
| Grok 4.1 Fast | APPROVE | 9/10 | No new material issues; spec is converged |

**Average Score**: 9.17 / 10
**Score Range**: 9.0 – 9.5

**Round 2 fixes (a–e) verification: unanimous RESOLVED across all three models.** No model considered any prior issue inadequately addressed.

---

## Consensus Findings

All three models independently confirmed:

1. **(a) Env-var-only transport**: Clean, no leftover `--agent-home` references — RESOLVED
2. **(b) Detector skips main checkout + bare entries via `realpath(<instar_repo>)`** — RESOLVED
3. **(c) `git rev-parse --git-common-dir`** is the correct primitive for repo validation — RESOLVED
4. **(d) Path-based stale-metadata recovery (`prune` then `remove --force <path>`)** — RESOLVED
5. **(e) "Do NOT remove partial directory; git owns rollback"** — RESOLVED

No model flagged regressions on prior issues. Prior issues are closed.

---

## Unique Catches (Per Model) — NEW Material Issues

### GPT 5.4 Unique Finding (BLOCKING per GPT)
- **Layer 4 detector resolves canonical instar repo via `worktree.repoAllowlist[0]`** but `repoAllowlist` is defined elsewhere as a list of **remote.origin.url** strings (e.g., `git@github.com:instar-ai/instar.git`), not filesystem paths. The detector then does `git -C <instar_repo> worktree list --porcelain`, which requires a local path. As written, an implementer following the spec literally cannot determine which local checkout to inspect.
- **Fix proposed**: Split concepts. Add `worktree.repoPath` (or equivalent) for the canonical local path, keep `repoAllowlist` as remote URL allowlist for validation. Layer 4 resolves a local path, then validates its remote against the allowlist.
- **Validity**: Strong catch. The spec text in Layer 4 step 1 literally says "read `worktree.repoAllowlist[0]` from `~/.instar/config.json`" while the Instar-repo resolution section defines the allowlist as remote URL strings. This is a real wire-level contradiction.

### Gemini 3.1 Pro Unique Finding (BLOCKING per Gemini, pre-merge)
- **Audit ledger ring rotation race**: The new "rotate to `.ledger.jsonl.1` when ledger exceeds 1 MB" requirement runs synchronously inside the concurrent CLI. Two concurrent `instar worktree create` invocations hitting the threshold simultaneously will race the `stat → rename → open` sequence, potentially overwriting each other's rotation or writing to orphaned FDs.
- **Fix proposed**: Either wrap append+rotate in `flock`, or (preferred) move rotation out of the CLI into the single-threaded Layer 3 migrator / Layer 4 detector.
- **Validity**: Strong catch. The spec explicitly invites concurrent CLI invocations (Concurrency section, Tests "Concurrent invocations"); rotation logic in the same code path is genuinely racy. Gemini also caught this is a NEW concern introduced by Round 3 spec additions.

### Grok 4.1 Fast Unique Findings
- None. Grok found no new material issues and approved. (This is a real signal of consensus on most surface area, but Grok did NOT independently catch either of the issues above.)

---

## Divergences

### Divergence 1: Is the spec ready to ship?
- **GPT**: CONDITIONAL — Layer 4 path/URL confusion must be fixed first
- **Gemini**: APPROVE with one pre-merge fix — log rotation race must be addressed
- **Grok**: APPROVE — no blockers found
- **Analysis**: GPT's and Gemini's findings are NON-OVERLAPPING (different sections, different failure modes) and both are real. Grok's clean bill is overconfidence — it missed both. The honest convergence read is CONDITIONAL: two small, surgical fixes needed before /instar-dev.

### Divergence 2: Severity of Layer 4 deterministic-repo design
- **GPT**: Blocking ambiguity
- **Gemini**: Did not flag this specifically; noted "first-entry ordering" softness but not the path/URL confusion
- **Grok**: Explicitly defended as "deliberate design decision, not a defect"
- **Analysis**: GPT is correct. Re-reading Layer 4 step 1 against Instar-repo resolution shows the allowlist is unambiguously a URL list, not a path list. Grok's defense is wrong on the facts.

### Minor wording issue (Gemini-only, non-blocking)
- "The first entry is always the canonical repo's own working tree (or marked bare)" is stronger than the actual safe rule (path-equality check). Implementation shouldn't depend on porcelain entry order. Worth tightening.

---

## Model Strengths Observed

| Model | Strengths | Weaknesses |
|-------|-----------|------------|
| GPT 5.4 | Caught the load-bearing wire-level contradiction; clean section refs; precise fix specs | Did not catch the rotation race |
| Gemini 3.1 Pro | Caught the concurrency race in the new rotation logic; strong threat-model commentary; specific implementation alternatives | Did not catch the Layer 4 path/URL confusion; required a retry with higher max-tokens (initial output truncated) |
| Grok 4.1 Fast | Concise; correctly verified all Round 2 fixes | Missed both new material issues; over-eager APPROVE; explicitly mis-classified GPT's catch as "deliberate design" |

---

## Prioritized Recommendations

| Priority | Recommendation | Flagged By | Impact |
|----------|---------------|------------|--------|
| P0 | Fix Layer 4 canonical-repo resolution: introduce `worktree.repoPath` (or equivalent) — do not use `repoAllowlist[0]` as a path | GPT | Blocks implementation; spec is ambiguous as written |
| P0 | Move 1MB ledger rotation out of concurrent CLI into single-threaded layer (or add `flock`) | Gemini | Prevents data-loss race under concurrent worktree creation |
| P1 | Tighten Layer 4 wording to not rely on porcelain entry order ("the first entry is always..." → keep only the path-equality skip rule) | Gemini | Defensive correctness; small wording change |
| P2 | State detector behavior when multiple local clones of the same allowed remote exist | GPT | Edge case; clarification |
| P2 | State whether case-insensitive slug collision is intentionally cross-platform (not host-FS-dependent) | Gemini | Cross-platform clarity |
| P3 | Note `prune`-before-`add` performance on huge repos; ensure CLI doesn't feel sluggish | Gemini | UX polish |
| P3 | Add one line: "If `repoAllowlist` is empty, fall back to baked default" | Grok | Edge case clarity |

---

## Gaps Across All Reviews

1. **No model probed the BackupManager scoping claim by reading source.** Spec asserts `.worktrees/` is excluded because it's a sibling of `stateDir`, citing `src/core/BackupManager.ts:89`. None of the three models verified this against the actual source — they accepted the citation.
2. **No model exercised the migrator's "one-shot attention item on bad INSTAR_REPO" idempotency claim across multiple update ticks.** Spec says "at most once per migrator run" — but that's per-run, not per-INSTAR_REPO-instance across runs. Could re-emit on every update if the operator delays the fix.
3. **No model questioned the `0700` permission claim's interaction with multi-user macOS setups** (e.g., if multiple human accounts share the agent home — unlikely but unstated).

---

## Key Takeaway

Cross-model review delivered exactly what a single-model review could not: GPT and Gemini each caught a DIFFERENT real defect in the Round 3 rewrite, while Grok missed both. The fixes from Round 2 are unambiguously closed — three independent models agree. But the rewrite introduced **two new surgical issues** (Layer 4 path-vs-URL confusion + ledger rotation race) that must close before /instar-dev. Both fixes are small (single-section edits, no architectural change). Once addressed, the spec is converged.

**Recommended action**: One more spec patch addressing P0×2 + P1, then re-tag `review-convergence: converged` and proceed to /instar-dev. No need for another full external round — the issues are well-bounded and the fix surface is small.

---

*Generated by CrossReview cross-model analysis.*
