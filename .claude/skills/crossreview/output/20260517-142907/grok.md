# Grok 4.1 Fast Review: AGENT-WORKTREE-CONVENTION-SPEC.md

**Model**: grok-4-1-fast
**Date**: 2026-05-17
**Focus**: full document

---

## Raw Model Response

### 1. Overall Assessment
- **Score**: 8/10
- **Status**: CONDITIONAL
- **Summary**: The specification is well-structured, pragmatic, and demonstrates strong operational awareness through its layered approach and explicit residuals section. The signal-vs-authority framework and rollback analysis are particularly mature. However, it under-addresses concurrency safety and omits any security/permission model for the new `.worktrees/` directory—both flagged focus areas in the review request.

### 2. Critical Issues (Must Fix)

| Issue | What | Why it matters | Suggested fix | Section reference |
|-------|------|----------------|---------------|-------------------|
| **Race condition on worktree creation** | The spec mentions idempotency ("refuse to clobber") but does not specify atomicity guarantees between the existence check and `git worktree add`. | A concurrent agent session (or parallel sub-agent) could pass the check, then both attempt creation, resulting in partial state or a confusing error. | Use `mkdir -p` + atomic directory creation as a lock, or wrap `git worktree add` in a retry-with-cleanup loop; document the failure mode explicitly. | "Idempotency" bullet under Layer 1; Tests section |
| **Missing permission model for `.worktrees/`** | No specification of directory permissions, ownership, or ACLs on the created worktree paths. | Sandbox revocation could stem from permission drift (e.g., `chmod 700` by another process); agents may create world-readable worktrees containing secrets. | Mandate `0700` on `.worktrees/` and document that the CLI enforces it; add a test assertion. | Layer 1 behaviour bullets; Side-effects review |
| **No validation of `INSTAR_REPO` env var** | The spec allows `INSTAR_REPO` to override the instar repo location without path canonicalization or existence checks beyond "does it exist." | An attacker or confused user could point to a malicious repo; the symlink step would then pull attacker-controlled `node_modules`. | Require the resolved path to contain a `.git` directory and match a known-safe pattern; log the resolved path at creation time. | "Resolve the instar repo location" bullet |

### 3. Strengths
- **Explicit failure-mode analysis**: The "Over-block / Under-block" section directly addresses the review focus on precision failures and correctly concludes that raw `git worktree add` remains a bypass vector (mitigated by documentation rather than interception).
- **Rollback and blast-radius clarity**: The "Rollback cost" subsection quantifies recovery at "under 5 minutes" with zero data loss—this is rare and valuable in specs.
- **Layered deployment strategy**: Separating the CLI subcommand (permanent) from the bash helper (bridge) avoids a flag-day migration and acknowledges real-world rollout latency.
- **Companion ELI16 document**: Mandatory per the project's own rule and executed correctly, improving accessibility for non-author reviewers.

### 4. Gaps & Missing Elements
- **Concurrency**: No mention of file locking, `flock`, or `mkdir` atomicity around the worktree path creation.
- **Supply-chain**: While "no new dependencies" is stated, there is no discussion of the security properties of the `node_modules` symlink (e.g., whether it could pull in untrusted native modules).
- **Silent bypass via symlinks**: An agent could theoretically create a symlink from inside `.worktrees/` pointing back to the shared checkout, defeating the sandbox goal. Not addressed.
- **Audit logging**: No requirement to log successful or failed `instar worktree create` invocations to a persistent agent log for post-incident review.
- **Section missing**: A short "Security Considerations" subsection (even if empty) would satisfy the review focus request on sandbox/permission edge cases.

### 5. Industry Comparison
- **Similar to `gh repo fork` / `gh issue create`**: Opinionated subcommands that encode team conventions while leaving raw `git` available for power users—matches the "signal with structured refusal" design here.
- **Anti-pattern avoided**: Unlike some monorepo tools that silently rewrite paths, this spec refuses loudly, which is the correct choice per the over-block analysis.
- **Best practice followed**: The "make the correct action the default path of least resistance" principle is applied cleanly via the scaffold seed and CLI.

### 6. Scalability Assessment
- **Phase 1 (MVP, 10-50 users)**: Works without modification; the discovery walk is trivial at this scale.
- **Phase 2 (Growth, 50-500 users)**: The upward directory walk for `.instar/AGENT.md` could become slow or ambiguous if agents start deeply nested projects; add a depth limit or caching.
- **Phase 3 (Scale, 500-5000 users)**: No architectural changes needed—this is strictly local CLI tooling with no shared state or network calls.
- **Spike handling**: Irrelevant; the operation is a single `git worktree add` plus optional symlink, bounded by local disk I/O.

### 7. Recommendations (Prioritized)
1. **Add atomicity guarantee to Layer 1**: Specify that `instar worktree create` uses an atomic directory creation (e.g., `mkdir` with `EEXIST` check) before calling `git worktree add`, and surface any race as a clear error rather than leaving partial state.
2. **Insert a minimal "Security Considerations" subsection**: Cover (a) permissions on `.worktrees/`, (b) symlink attack surface, and (c) validation of `INSTAR_REPO`.
3. **Strengthen the `INSTAR_REPO` resolution**: Require the path to contain a `.git` directory and log the final resolved absolute path on success.
4. **Add one integration test for concurrent creation**: Two parallel invocations with the same slug should result in exactly one success and one clean failure with no partial checkout left behind.
5. **Document the node_modules symlink threat model**: Explicitly state that the symlink is created only when the destination does not exist and the source is inside the resolved instar repo, closing the supply-chain concern.