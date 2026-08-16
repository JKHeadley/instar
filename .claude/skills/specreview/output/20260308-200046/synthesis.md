# SpecReview Synthesis: Discovery Protocol — Sub-Agent Opportunity Capture

**Review ID**: 20260308-200046
**Date**: 2026-03-08
**Round**: 1
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing
**Spec**: specs/discovery-protocol.md

---

## Overall Assessment

**Status**: NEEDS WORK
**Average Score**: 6.6 / 10
**Score Range**: 4 - 8

| Reviewer | Status | Score | Key Finding |
|----------|--------|-------|-------------|
| Security | CONDITIONAL | 6/10 | Discovery files are untrusted input processed by LLM — textbook prompt injection surface requiring HMAC signing and content isolation |
| Scalability | CONDITIONAL | 7/10 | Sound at current scale; unbounded `processed/` growth and missing atomic writes need addressing before production |
| Business | CONDITIONAL | 7/10 | Genuine whitespace opportunity, but Agent Teams overlap risk and no adoption strategy threaten viability |
| Architecture | APPROVED | 8/10 | Architecturally sound with correct primitives; needs schema validation, atomic writes, and worktree resolution |
| Privacy | CONDITIONAL | 7/10 | Local-first design is privacy-friendly but lacks retention policies, data sanitization, and user opt-out controls |
| Adversarial | CONDITIONAL REJECT | 4/10 | Unauthenticated file-based IPC from less-trusted to more-trusted context is a critical attack surface without signing, validation, and isolation |
| DX | CONDITIONAL | 7/10 | Right architecture, but no helper tooling for sub-agents to write correct files; worktree isolation unresolved |
| Marketing | CONDITIONAL | 7/10 | "Discovery" name collides with A2A/ANP terminology; rename before it calcifies in code |

---

## Consensus Findings

*Issues that 3+ reviewers independently identified:*

1. **Worktree isolation is a day-one blocker, not future work**: Identified by [Security, Scalability, Business, Architecture, Privacy, Adversarial, DX]
   - Summary: Sub-agents in git worktrees cannot write to `.instar/state/discoveries/` in the main tree. This is the primary sub-agent execution mode, making the protocol unusable in its most common context without a solution.
   - Recommended action: Resolve in Phase 1. Preferred approach: sub-agents write to a known worktree-relative path; parent copies discoveries back during worktree teardown. Document the mechanism explicitly.

2. **No integrity verification / signing on discovery files**: Identified by [Security, Adversarial, Architecture, DX]
   - Summary: Any process running under the user's account can write to the discoveries directory. There is no HMAC, signature, or provenance verification. The Playbook system already uses HMAC for manifest integrity — apply the same pattern here.
   - Recommended action: Add HMAC signing using a session-derived key. Parent verifies signature before processing. Reject unsigned files.

3. **Prompt injection via discovery content fields**: Identified by [Security, Adversarial, Privacy]
   - Summary: Free-text fields (description, rationale, diff) are processed by the parent LLM. A compromised sub-agent can embed adversarial instructions indistinguishable from legitimate content. Research shows 97% exploitation rates for LLMs processing malicious local files.
   - Recommended action: Treat all discovery content as untrusted data. Present fields individually with explicit "UNTRUSTED" framing. Evaluate in a context that does not permit tool execution. Consider field length limits.

4. **Unbounded `processed/` directory growth**: Identified by [Scalability, Architecture, Privacy, Adversarial]
   - Summary: Processed discoveries accumulate indefinitely with no retention, archival, or cleanup policy. At moderate use (10-50/day), this reaches tens of thousands of files within a year, crossing filesystem performance thresholds.
   - Recommended action: Define a retention policy (e.g., 90-day TTL or monthly JSONL archival). Add `processed/` to `.gitignore`.

5. **Self-assessment fields are untrusted and gameable**: Identified by [Security, Adversarial, Business, Privacy, DX, Architecture]
   - Summary: Sub-agents self-rate value, effort, risk, and readiness. Every rational sub-agent will overstate value and understate risk. A compromised sub-agent exploits this to fast-track malicious changes.
   - Recommended action: Parent must independently assess all dimensions. Treat self-assessment as advisory hints, not authoritative signals. Consider reducing to just `readiness` (the one field the sub-agent actually knows).

6. **Missing atomic file write semantics**: Identified by [Scalability, Architecture, Adversarial, DX]
   - Summary: Concurrent sub-agents writing files, or a parent reading mid-write, can produce partial/corrupt JSON. The standard write-to-temp-then-rename pattern is a one-line fix that eliminates the race.
   - Recommended action: Mandate write-then-rename in the protocol spec and sub-agent prompt.

7. **Token budget exceeds stated limit**: Identified by [Architecture, Scalability, DX]
   - Summary: Success criterion states <100 tokens for sub-agent prompt injection. The actual prompt text is ~120-150 tokens. Either trim the prompt (use a helper script or link to schema) or revise the criterion.
   - Recommended action: Provide a shell helper script for sub-agents. Reduces prompt to a single command invocation and shifts correctness from the LLM to the tool.

8. **Discovery volume control / flooding risk**: Identified by [Security, Scalability, Adversarial, DX, Architecture]
   - Summary: No cap on discoveries per session or file size. A misbehaving sub-agent can flood the directory, creating triage fatigue and consuming context tokens.
   - Recommended action: Soft cap of 5 discoveries per session in the sub-agent prompt. Cap `artifacts.diff` at 10KB. Session-start hook displays top N with "and X more" summary.

---

## Critical Issues (Blockers)

*Any reviewer issuing BLOCK status -- these must be addressed before proceeding.*

| # | Issue | Reviewer | Severity | Suggested Fix |
|---|-------|----------|----------|---------------|
| 1 | Prompt injection via discovery content fields | Security, Adversarial | CRITICAL | Isolate discovery evaluation context; present content as untrusted data with explicit framing; do not permit tool execution during evaluation |
| 2 | No integrity verification (HMAC/signatures) on discovery files | Security, Adversarial | CRITICAL | Add HMAC signatures using session-derived key; verify before processing; reject unsigned files |
| 3 | Unreviewed code application via `artifacts.diff` | Security, Adversarial | CRITICAL | Never auto-apply code diffs; route through evolution proposals with mandatory review; parent independently verifies tests pass |
| 4 | Persistent backdoor via discovery-to-evolution pipeline | Adversarial | CRITICAL | Flag discovery-originated evolution proposals for mandatory human review; automated pipeline must not implement discovery code without explicit approval |

---

## Conflicts

*Points where reviewers disagree or provide contradictory recommendations.*

### Conflict 1: Self-Assessment — Remove, Simplify, or Keep?

- **DX** says: Simplify to just `readiness` (the one field the sub-agent actually knows); let parent handle value/effort/risk.
- **Adversarial** says: Consider removing self-assessment entirely or renaming to "self-estimate" to signal unreliability.
- **Architecture / Scalability** says: Keep but treat as advisory hints, not authoritative signals. Useful for fast-filtering at triage.
- **Marketing** says: Self-assessment is a "subtle but powerful feature" worth highlighting as meta-cognitive capability.
- **Tension**: DX/Adversarial see self-assessment as a source of perverse incentives and gaming. Architecture/Marketing see it as useful metadata.
- **Resolution**: Simplify to `readiness` only for sub-agent self-report. Parent independently scores value/effort/risk during triage. This preserves the useful signal while eliminating the gameable dimensions.

### Conflict 2: 30-Day TTL Auto-Proposal vs. Auto-Dismiss

- **Business** says: Auto-filing as evolution proposals after 30 days just moves noise to a different queue. Consider auto-dismissal with summary notification instead.
- **DX / Scalability** says: Auto-filing as evolution proposals preserves value while clearing the queue. Sensible default.
- **Tension**: Business sees TTL-expired discoveries as likely low-value (if they were valuable, they'd have been triaged). Scalability sees them as potentially valuable items that fell through the cracks.
- **Resolution**: Needs cross-examination. Consider a middle path: auto-dismiss with a batch summary notification, giving the user one last chance to rescue items before deletion.

### Conflict 3: Git Sync of Discoveries

- **Scalability** says: Pending discoveries should sync (actionable state); processed should NOT sync. Add `processed/` to `.gitignore`.
- **Privacy** says: Make `.gitignore` inclusion mandatory by default for ALL discoveries. Git sync only after data sanitization controls are in place.
- **Architecture** says: Local-only is correct for now. Evolution proposals (which sync) provide the cross-machine path.
- **Tension**: Scalability wants partial sync for multi-machine continuity. Privacy wants no sync by default due to sensitive artifact content.
- **Resolution**: Default to local-only (no git sync) for both pending and processed. This satisfies Privacy and Architecture. If multi-machine sync is needed later, it requires the sanitization controls Privacy demands. Add all of `.instar/state/discoveries/` to `.gitignore` in Step 1.

---

## Recommendations (Prioritized)

*Consolidated from all reviewers, ordered by impact and frequency.*

| Priority | Recommendation | Source Reviewers | Effort | Impact |
|----------|---------------|-----------------|--------|--------|
| P0 | Add HMAC signatures to discovery files for provenance verification | Security, Adversarial | Med | High |
| P0 | Treat all discovery content as untrusted; isolate evaluation context from tool execution | Security, Adversarial | Med | High |
| P0 | Never auto-apply code diffs; route through evolution proposals with mandatory review | Security, Adversarial | Low | High |
| P0 | Resolve worktree isolation in Phase 1 (copy-back during teardown) | All except Marketing | Low | High |
| P1 | Add strict JSON schema validation with `additionalProperties: false` | Architecture, Adversarial, DX | Low | Med |
| P1 | Mandate atomic file writes (write-to-temp-then-rename) | Scalability, Architecture, Adversarial, DX | Low | Med |
| P1 | Provide a shell helper script for sub-agents to write valid discovery files | DX | Low | High |
| P1 | Define retention policy for processed discoveries (90-day TTL or monthly archival) | Scalability, Privacy, Architecture, Adversarial | Low | Med |
| P1 | Parent independently assesses risk/value; treat self-assessment as advisory only | Security, Adversarial, Business, Privacy | Low | Med |
| P1 | Flag discovery-originated evolution proposals for mandatory human review | Adversarial | Low | High |
| P1 | Add user opt-out config flag (`discoveries.enabled: false`) | Privacy | Low | Med |
| P2 | Cap discoveries per session (max 5) and file size (max 10KB for diffs) | Adversarial, Scalability, DX | Low | Med |
| P2 | Add data sanitization requirements for artifact diffs (no secrets, PII, credentials) | Privacy, Adversarial | Med | Med |
| P2 | Add `version: 1` field to discovery schema for forward compatibility | DX | Low | Low |
| P2 | Rename from "Discovery Protocol" to avoid collision with A2A/ANP terminology | Marketing | Low | Med |
| P2 | Add a concrete end-to-end example (sub-agent writes, parent triages, becomes proposal) | DX | Low | Med |
| P2 | Restrict directory permissions to 0700 | Security | Low | Low |
| P2 | Make `.gitignore` inclusion of discoveries directory mandatory by default | Privacy, Scalability | Low | Med |
| P3 | Add structured logging for all triage decisions | Security, Privacy | Med | Low |
| P3 | Add triage-failure circuit breaker (auto-move after 3 failed attempts) | Adversarial | Low | Low |
| P3 | Add discovery counter/index file to avoid directory scanning | Scalability | Low | Low |
| P3 | Define worktree copy as a sanitization boundary | Security | Low | Low |
| P3 | Add protocol compliance tracking (discoveries created vs. sub-agent sessions run) | Business | Low | Med |

---

## Scalability Summary

| Phase | Assessment | Key Risks | Reviewers Agree? |
|-------|-----------|-----------|-----------------|
| **MVP** (1-5 sub-agents/day) | Safe. File-based IPC is more than adequate. | None significant. | Yes |
| **Growth** (10-50 sub-agents/day) | Manageable. Triage time becomes the constraint (~30-60 min/day). | Processed directory accumulates ~10K files/year; triage fatigue begins. | Yes |
| **Scale** (100-500 sub-agents/day) | Triage becomes dominant workload. Automated pre-filtering needed. | Token cost of triage may exceed token cost of sub-agent work; 50K+ processed files/year. | Yes |
| **Viral spike** (50+ concurrent sub-agents) | 100-150 pending discoveries in minutes; triage backlog of hours. | No backpressure mechanism; session-start hook could overflow context. | Yes |

All reviewers agree that the protocol is well-designed for its intended scale. The scaling bottleneck is not filesystem performance but LLM evaluation time during triage. Batch triage, priority sorting, and automated pre-filtering become necessary at 100x scale.

---

## Gaps

*Areas that no reviewer adequately covered, or areas where the spec itself is silent.*

1. **Testing strategy**: No reviewer addressed how to test the protocol. Unit tests for schema validation, integration tests for the capture-triage-route pipeline, and adversarial tests for prompt injection resistance should be specified.

2. **Rollback mechanism**: If an applied discovery causes problems, there is no defined rollback path beyond git revert. The protocol should specify how to trace a problematic change back to its originating discovery.

3. **Observability and metrics**: Business reviewer noted the absence of effectiveness metrics. No reviewer proposed specific metrics. Key metrics should include: discovery-to-application rate, triage time per discovery, false positive rate, sub-agent compliance rate.

4. **Multi-user implications**: The Privacy reviewer touched on this briefly, but in a multi-user Instar deployment, one user's sub-agents could theoretically write discoveries that another user's parent agent triages. The trust model needs explicit scoping per user.

5. **Interaction with Agent Teams**: Business reviewer flagged the competitive overlap with Claude Code Agent Teams but no reviewer analyzed the technical interaction. Can the discovery protocol coexist with Agent Teams' mailbox system? Should it?

---

## Name Analysis (from Marketing Reviewer)

**Current name**: Discovery Protocol
**Assessment**: "Discovery" in the 2026 agent ecosystem means capability advertisement and agent-finding (A2A, ANP). Using it for opportunity capture creates ambiguity. Poor searchability. Good internal clarity but high collision risk externally.
**Alternatives suggested**:
1. **Serendipity Protocol** (top pick) — distinctive, zero collision, captures the essence of unplanned valuable finds
2. **Salvage Protocol** — emphasizes the problem (valuable work being lost); strong but slightly negative connotation
3. **Fieldnotes Protocol** — ethnographic metaphor; sub-agents as field researchers noting observations outside their mission
4. **Aside Protocol** — theatrical metaphor; elegant but niche
5. **Gleanings Protocol** — collecting valuable remnants after the main harvest; poetic and precise

**Recommendation**: Rename before the name calcifies in code and documentation. "Serendipity Protocol" or "Salvage Protocol" are the strongest options.

---

## Convergence Status

| Metric | Value |
|--------|-------|
| Reviewers in agreement (APPROVE) | 1 / 8 |
| Conditional approvals | 6 / 8 |
| Blockers | 1 / 8 |
| Open conflicts | 3 |
| Resolved conflicts | 0 |

**Convergence**: CONVERGING

All 8 reviewers agree the concept is sound and addresses a real problem. Seven of eight approve with conditions; one (Adversarial) conditionally rejects pending security fixes. The conditions are largely overlapping — the same 4-5 fixes (HMAC signing, content isolation, worktree resolution, schema validation, atomic writes) would satisfy most conditional approvals simultaneously. The Adversarial reviewer's concerns are a superset of the Security reviewer's and would also be addressed by the P0 recommendations.

---

## Next Steps

- [ ] Address 4 critical issues (prompt injection isolation, HMAC signing, code diff review gates, evolution pipeline human review) before implementation
- [ ] Resolve 3 open conflicts (self-assessment scope, TTL behavior, git sync policy) via cross-examination or spec author decision
- [ ] Implement P0 and P1 recommendations (estimated +2-3 hours on top of the spec's 4-hour estimate)
- [ ] Decide on rename before writing code (recommend "Serendipity Protocol" or "Salvage Protocol")
- [ ] Resolve worktree isolation with a concrete mechanism in Phase 1
- [ ] Re-run review for affected areas: `/specreview specs/discovery-protocol.md --round 2 --reviewers security,adversarial,dx`

---

*Generated by SpecReview multi-agent analysis.*
