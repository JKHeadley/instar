# Grok 4.1 Fast Review: AGENT-WORKTREE-CONVENTION-SPEC.md (Round 3)

**Model**: grok-4-1-fast
**Date**: 2026-05-17T21:50:24Z
**Focus**: Round 3 convergence review

---

## Raw Model Response

**1. Overall Assessment**
- **Score**: 9/10
- **Status**: APPROVE
- All five prior Round-2 fixes (a–e) are adequately resolved with no leftover references or paper-over implementations. The spec is now internally consistent, has tight threat-model boundaries, and is ready for implementation.

**2. Critical Issues (Must Fix)**
None. No new material architectural, wire-level, or correctness issues were introduced by the rewrite. The minor deterministic-repo choice in the detector (allowlist[0]) is a deliberate design decision, not a defect.

**3. Strengths**
- Extremely precise handling of the macOS/Claude sandbox revocation problem via a single env-var transport (`INSTAR_AGENT_HOME`) and strict realpath + regex + registry validation.
- Correct use of `git rev-parse --git-common-dir` and explicit skipping of the primary worktree + bare entries in the detector.
- Clear “git owns rollback” rule and path-based (not slug-based) recovery commands for stale metadata.
- Strong signal-vs-authority separation and explicit non-claims around signing and authority.
- Comprehensive test matrix and acceptance criteria that directly cover the failure modes found in prior rounds.

**4. Gaps & Missing Elements**
- No explicit statement of what happens if `worktree.repoAllowlist` is empty in the detector (minor).
- Residual R-8 (system-owned config) remains out of scope; acceptable for v1.

**5. Industry Comparison**
The design follows the well-known “agent home as single source of truth” pattern used by tools such as `direnv`, `asdf`, and container volume conventions. It avoids the common anti-pattern of trying to intercept every raw `git` invocation and instead provides both an easy path and observable signals.

**6. Scalability Assessment**
- **Phase 1 (MVP)**: Works cleanly.
- **Phase 2/3**: No architectural changes required; the per-agent, single-process detector and O_APPEND ledger already scale to hundreds of agents.
- Spike handling is already bounded by the 2-second timeout and deduplication window.

**7. Recommendations (Prioritized)**
1. Proceed to implementation — the spec has converged.
2. Add one clarifying sentence in Layer 4: “If `worktree.repoAllowlist` is empty, fall back to the baked default.”
3. Implement the exact test cases listed under “Detector” and “Concurrent invocations.”
4. After the first PR, run the detector once on echo’s machine to drain the expected ~30 pre-existing attention items.
5. Schedule the R-6 default-flip review after 30 days of zero “node_modules absent” attention items.