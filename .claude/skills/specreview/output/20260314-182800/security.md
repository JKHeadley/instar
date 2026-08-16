# Security Review: Seed Migration Spec v2 (Round 2)

**Reviewer**: Echo (security specialist role)
**Date**: 2026-03-14
**Spec**: `specs/seed-migration.md` (Draft v2, post-review)
**Round**: 2
**R1 Review**: `output/20260314-104223/security.md`
**Review focus**: Resolution of R1 critical issues; new risks introduced by v2 changes

---

## Round 2 Assessment

The v2 revision is a substantive response to the Round 1 critique. Every critical issue from R1 was addressed, several with specific implementation detail. The architecture has materially improved: the monolith reference file is gone (replaced by per-capability files), integrity verification is now a first-class design principle (Design Principle #7), content framing is specified, query sanitization is defined, the auto-regeneration risk is explicitly gated, and a security test category was added to the test suite. These are real improvements, not cosmetic rewording.

That said, four concerns remain — two of them substantive enough to keep this conditional rather than a clean approval. The two new open questions introduced in v2 (evolution system interaction and token budget enforcement) both have latent security implications that the spec acknowledges but doesn't resolve. One R1 recommendation (fallback hardcoded safety ruleset) remains absent. And the path traversal fix was described but its implementation is not explicitly confirmed in the new code.

---

## Round 1 Issues Resolution

| Issue | Status | Notes |
|-------|--------|-------|
| 1. No integrity verification on capabilities-reference.md | **RESOLVED** | Design Principle #7 mandates HMAC-SHA256 at write and read time, with signatures in `context/.integrity.json`. The single monolith file is gone — replaced by per-capability files, each individually signed. This is the correct and complete fix. |
| 2. Prompt injection via poisoned tree node content | **RESOLVED** | Content framing (`<knowledge-fragment source="..." verified="true">`) is specified. HTML comment stripping is explicit. Security test Category 7 includes "HTML comment injection" test. These are the three mitigations I recommended. |
| 3. Path traversal gap in resolvePath() | **PARTIALLY RESOLVED** | The spec now requires path traversal protection: "Attempt to reference file outside project dir via tree config — Path rejected, symlinks resolved." This is specified as a test requirement. However, the spec does not show the updated `resolvePath()` implementation or confirm that `fs.realpathSync()` was added. It's a test claim, not confirmed code. |
| 4. TreeGenerator auto-regeneration is implicit trust escalation | **RESOLVED** | The Resilience Mode table now explicitly states: "Tree config corrupt → TreeGenerator can regenerate from AGENT.md + capabilities, gated on human confirmation via attention queue (prevents auto-regeneration from compromised AGENT.md)." The exact concern is addressed with the exact recommended fix. |
| 5. LLM triage is injectable via query manipulation | **RESOLVED** | Input sanitization section added: 500-character length limit, strip control characters and HTML, allowlist validation of node IDs, anomalous query logging. Security test Category 7 includes "Prompt injection via query" test. All R1 recommendations implemented. |

**R1 Recommendations Status:**

| Recommendation | Status | Notes |
|----------------|--------|-------|
| A. Fallback hardcoded safety ruleset | **UNRESOLVED** | The spec still does not include a minimal in-process hardcoded safety ruleset (not file-based) for the three most critical behaviors. The seed file is closer to immutable than a dynamic file, but it's still a file that can be compromised. A hardcoded in-memory baseline is a different defense depth. |
| B. Single file → many files | **RESOLVED** | The per-capability file architecture is adopted as the primary design. Design rationale is explicit and well-argued. |
| C. Memory search source type content framing | **RESOLVED** | The `<knowledge-fragment>` wrapper applies to all tree-served content. |
| D. Cache poisoning via race condition | **RESOLVED** | Cache key includes file modification time. File-change events trigger immediate invalidation. Cache entries include HMAC of source file at cache time — if HMAC changes, cache is invalidated. Comprehensive fix. |
| E. Upgrade script transactional approach | **RESOLVED** | Phase 6 now includes schema validation of upgrade script output and staggered rollout. The staging-then-atomic-swap isn't explicitly described, but schema validation before replacing serves a similar protective purpose. |
| F. No audit trail for tree config changes | **RESOLVED** | Tree config versioned alongside context files. Restoring a backup restores both. Per-file git history provides an independent audit trail. |

---

## New Issues (v2)

### 1. Evolution System Interaction Remains an Open Security Question (Remaining Open Question #4)

The spec acknowledges this and defers it: "Can evolution proposals modify tree nodes? If so, how are proposed node changes validated to prevent poisoned proposals?"

This is more than a P2 design question — it is a meaningful attack surface. The evolution system accepts proposals from LLM sessions. If a session can be manipulated (via prompt injection from a compromised Telegram message), and that session then submits an evolution proposal that adds or modifies a tree node, the attacker has indirectly poisoned tree content without triggering HMAC verification on the existing files (because the proposal creates a new file or overwrites an existing one, which the integrity system then signs at write time — the HMAC protects against external modification, not against internally-generated malicious writes).

The attack chain: crafted Telegram message → prompt injection in session → manipulated session submits evolution proposal → proposal approved by evolution-review job → new/modified tree node file written with valid HMAC → poisoned content served by tree.

**Recommendation**: Evolution proposals that modify tree nodes must be gated on the same human confirmation mechanism as TreeGenerator regeneration — not auto-approved by the evolution-review job. This is not resolved by the HMAC system because HMAC signs whatever the writer writes.

**Severity**: Medium. Requires multi-step exploitation. Lower risk than R1 Issue #1 was. But the open question in the spec should be resolved, not deferred.

---

### 2. Token Budget Enforcement Has Implicit Truncation Risk (Remaining Open Question #3)

The spec defers this: "What happens when a retrieved context file exceeds the `maxTokens` budget? Truncation? Partial response? Warning?"

If the implementation truncates content silently (the most likely default), and a context file's safety-critical information is in the latter half, agents receive partial knowledge that may be worse than no knowledge — they believe they have the full content and act on incomplete information. For capability files (like the feedback system or the nuke command reference), this could cause security-relevant behavior (e.g., agent believes it's checked the full policy, but the "never run instar nuke autonomously" clause was truncated).

**Recommendation**: Truncation must either (a) be clearly signaled to the agent in the response so it can flag incomplete knowledge, or (b) never happen silently — if a file exceeds budget, return the full file or nothing, with a clear budget-exceeded signal.

---

### 3. Hardcoded Safety Baseline Still Absent

This was R1 Recommendation A and remains unaddressed. The seed file is a meaningful improvement over the monolith — it's smaller and more focused — but it's still a file that travels through git sync and can be simultaneously compromised with context files in a single malicious push.

A minimal in-process hardcoded baseline (three rules, zero tokens, never reachable by file system attack) provides a defense depth that no file-based approach can replicate. The three rules I recommended in R1:
1. Never delete agent data
2. Always use the feedback API, not gh
3. Never run `instar nuke` autonomously

These are so short they add negligible maintenance burden and would survive any file system compromise scenario.

**Severity**: Low. The seed file is more protected than the old monolith was, and multiple other controls exist. But this remains the simplest gap to close.

---

### 4. Path Traversal Fix Is a Test Claim, Not Confirmed Implementation

The spec adds a security test: "Path traversal → Path rejected, symlinks resolved." But the spec does not include an updated `resolvePath()` implementation, and the existing code issue (the OR-of-negations logic, no `fs.realpathSync()` call) was identified in R1 as a code-level defect in `TreeTraversal.js line 283-296`.

A test requirement is not the same as a fix. The test verifies behavior, but if the underlying code isn't changed, the test may pass for most inputs and fail on crafted edge cases that the test suite doesn't cover.

**Recommendation**: Confirm in the spec (or implementation) that `resolvePath()` has been updated: (1) call `fs.realpathSync()` before prefix checks, (2) use an explicit directory allowlist, (3) change the OR logic to AND. This is a Phase 0 prerequisite.

**Severity**: Low-Medium. The test suite catch is valuable. But the code defect should be explicitly fixed and confirmed, not just tested for.

---

## Unchanged Observations (Still Valid)

- The `file_section` preference over `memory_search` for deterministic retrieval is still correct.
- The rule-based primary / LLM fallback triage strategy resolves the prompt injection amplification risk I noted in R1 (Haiku manipulated → Sonnet inherits). Rule-based path has no LLM injection surface.
- The observation about `dispatch` keyword in the rule-based triage's keyword list (forces capabilities layer load on any Telegram message mentioning dispatch) still applies. Minor DoS-lite concern, documented.
- The scale risk (Phase 6 → 300+ agents, npm supply chain) remains. The staggered rollout and schema validation partially address it, but signed templates with cryptographic verification are not in scope for this spec. Acceptable for current scale.

---

## Updated Approval Status: CONDITIONAL

The spec has addressed all five critical issues from Round 1. The two remaining new issues (evolution system interaction, token budget truncation) are genuine security concerns that should be resolved before Phase 4 begins — consistent with the R1 gate. The path traversal and hardcoded baseline gaps are lower severity and could be addressed in implementation without blocking Phases 1-3.

**Condition for full approval**: Resolve the evolution proposal gate (Issue #1 above) and the token budget truncation signal (Issue #2 above) before Phase 4. Confirm `resolvePath()` code update at Phase 0.

**Phases 1-3** (additive, non-destructive) remain safe to proceed immediately.

---

## Updated Score: 8/10

**Justification**: The revision closed the primary attack surface I identified — the integrity gap on the behavioral reference file. Content framing, query sanitization, per-file HMAC, and cache coherence are all implemented. The auto-regeneration trust escalation is explicitly gated. The test suite now includes a security category with the specific tests I recommended.

The score is held at 8 rather than 9 by the evolution system interaction gap (which is acknowledged but unresolved) and the token budget truncation risk. These are narrower concerns than R1's issues — the attack chains are longer and require more adversarial conditions — but they're real. Closing the evolution gate and specifying truncation behavior would justify a 9/10. The hardcoded safety baseline would push it to 9.5.

The architecture is now substantially sound from a security standpoint. The v2 author took the critique seriously and addressed it with specificity. The remaining gaps are refinements on a solid foundation, not structural defects.

---

*Sources consulted (unchanged from R1):*
- [OWASP LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [PoisonedRAG — USENIX Security 2025](https://www.usenix.org/system/files/usenixsecurity25-poisonedrag.pdf)
- [RAG Security and Privacy: Formalizing the Threat Model](https://arxiv.org/html/2509.20324v1)
- [Securing AI Agents Against Prompt Injection](https://arxiv.org/abs/2511.15759)
- [OWASP Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
