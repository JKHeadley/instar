# CrossReview Synthesis: discovery-protocol.md

**Review ID**: 20260308-200216
**Date**: 2026-03-08
**Models**: GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast
**Document**: discovery-protocol.md (Discovery Protocol — Sub-Agent Opportunity Capture)
**Focus**: full document

---

## Overall Assessment

**Consensus Status**: CONDITIONAL

| Model | Status | Score | Key Finding |
|-------|--------|-------|-------------|
| GPT 5.4 | CONDITIONAL | 8/10 | Strong design but underspecified filesystem protocol, lifecycle model, and worktree handling |
| Gemini 3.1 Pro | CONDITIONAL | 8/10 | Solid architecture but worktree isolation causes silent data loss, and LLM JSON+diff is fragile |
| Grok 4.1 Fast | APPROVE | 9/10 | Production-ready draft with minor gaps in concurrency and security |

**Average Score**: 8.3 / 10
**Score Range**: 8 - 9

---

## Consensus Findings

*Issues that 2+ models flagged independently — strongest signal for real problems:*

1. **Worktree/sandbox isolation breaks the core mechanism**: Flagged by GPT, Gemini, Grok
   - All three models identified that sub-agents in isolated worktrees cannot write to the parent's `.instar/state/discoveries/` directory, meaning discoveries are silently lost on teardown. GPT elevated this to a critical issue and proposed three resolution options (copy-back, mount, result envelope). Gemini proposed rsync on worktree teardown. Grok noted the gap but kept it as a gap rather than a top critical issue.
   - **Recommended action**: Move this from Open Questions into the core architecture. Define a canonical copy-back mechanism in the worktree teardown lifecycle, with explicit failure handling if copy-back fails.

2. **Concurrency and atomicity are unspecified**: Flagged by GPT, Gemini, Grok
   - All models identified race conditions: multiple sub-agents writing simultaneously, parent triaging while a file is still being written, duplicate IDs causing overwrites. GPT provided the most comprehensive treatment (temp files, atomic rename, lock files, idempotency). Gemini proposed write-to-`.tmp`-then-rename. Grok proposed `flock`-based triage and `.processing` rename.
   - **Recommended action**: Add atomic write protocol (write to `.tmp`, rename to `.json`), require sufficiently unique IDs (UUID or timestamp+random), and add `.processing` rename during triage to prevent double-processing.

3. **Malformed JSON handling is absent**: Flagged by GPT, Gemini, Grok
   - All models noted that LLMs may produce invalid JSON, and the spec has no error handling for parse failures. Gemini proposed an `invalid/` directory. Grok proposed `jq` validation with an `invalid-json` status. GPT listed it among gaps.
   - **Recommended action**: Add schema validation in both the triage script and session-start hook. Move malformed files to an `invalid/` directory with error metadata rather than failing the pipeline.

4. **Discovery lifecycle/state model is incomplete**: Flagged by GPT, Gemini
   - GPT detailed the missing state machine (transitions, disposition metadata, audit history). Gemini noted the lack of garbage collection for `processed/`. Both identified that the spec defines initial and final states but not the transitions or retention rules between them.
   - **Recommended action**: Define a formal state machine (`pending` -> `applied | proposed | dismissed | triage-failed`), add disposition metadata schema (`processedAt`, `processedBy`, `reason`, `proposalId`), and specify retention policy for processed files.

5. **Security/trust model for applied diffs is unaddressed**: Flagged by GPT, Gemini, Grok
   - GPT flagged that diffs may contain secrets or credentials. Gemini warned about applying hallucinated/malicious code without sandboxing. Grok flagged the need for diff sanitization. None of the models were deeply satisfied with the spec's silence on this.
   - **Recommended action**: Add a security section covering: no secrets in discovery artifacts, redaction guidance, whether diffs are ever transmitted externally, and a recommendation that applied discoveries go through the same review as any code change (not auto-applied blindly).

6. **Garbage collection / retention for processed files**: Flagged by Gemini, GPT
   - Both noted the `processed/` directory grows indefinitely with no cleanup policy. Gemini suggested a 14-day TTL. GPT asked whether processed files are append-only, deletable, or compactable.
   - **Recommended action**: Define a retention policy (e.g., 14-30 day TTL for processed files) and add a cleanup mechanism (cron job or session-end hook).

---

## Unique Catches (Per Model)

*Things only one model caught — potential blind spots the others missed:*

### GPT 5.4 Unique Findings
- **"Zero overhead" vs pre-created directories contradiction**: The design principle says "nothing happens when unused" but the implementation plan creates directories at init. This is a sharp observation about internal inconsistency — valid and worth resolving by choosing lazy-create or softening the principle language.
- **Schema versioning**: No `schemaVersion` field means future changes will break parsers silently. This is a real concern for a file-based protocol expected to evolve. Valid and important.
- **"Metadata theater" anti-pattern warning**: Too many required fields could reduce sub-agent compliance. This is a useful design tension to be aware of during implementation.
- **Ownership model ambiguity**: Who triages when multiple parents exist, sessions are handed off, or discoveries are found in unrelated branches? Valid organizational concern.
- **No guidance on what qualifies as "out of scope"**: Without heuristics, sub-agents may under-capture or flood. Valid — adding 2-3 examples would help calibrate.

### Gemini 3.1 Pro Unique Findings
- **LLM JSON formatting for code diffs is fragile**: LLMs struggle with escaping multi-line strings inside JSON. Gemini proposed sidecar `.patch` files alongside the `.json` metadata. This is the single most practically important unique finding across all reviews — it identifies a failure mode that will surface immediately in production.
- **Prompt token budget undercount**: The spec claims "<100 tokens" but the JSON example alone is 75-90 tokens before instructions. This needs strict minification. Valid observation that could affect the "zero overhead" promise.
- **Rate limiting / discovery caps**: Proposed a hard limit (e.g., max 5 discoveries per task) to prevent rogue sub-agents from spamming. GPT mentioned anti-spam controls in gaps but Gemini provided a concrete number.

### Grok 4.1 Fast Unique Findings
- **UUID generation method needs specification**: Sub-agents need a concrete, dependency-free method (`crypto.randomUUID()` slice or `uuidgen | cut`). Practical implementation detail the others glossed over.
- **Disk full / permission denied fallback**: What happens if the filesystem write itself fails? No fallback to returning the discovery in the session output. Valid edge case.
- **Internationalization note**: Timestamps and categories assume English. While a stretch for this domain, it signals awareness of implicit assumptions.
- **Creative industry comparisons**: GTD inbox pattern, Bazel aspects, Sentry suspect spans — these are apt and useful for positioning the design.

---

## Divergences

*Where models actively disagree — requires human judgment:*

### Divergence 1: Approval Status
- **GPT**: CONDITIONAL (8/10) — "not fully ready as written"
- **Gemini**: CONDITIONAL (8/10) — "conditional upon resolving worktree isolation and JSON+diff fragility"
- **Grok**: APPROVE (9/10) — "production-ready draft"
- **Analysis**: GPT and Gemini are aligned that the spec needs fixes before implementation. Grok's APPROVE with a 9/10 is notably more optimistic — it treats the issues as minor implementation details rather than spec-level problems. Given that all three identified the same core issues (worktree, concurrency, malformed JSON), the CONDITIONAL consensus is stronger. The spec is good but genuinely needs the worktree and atomicity issues resolved before it can be considered implementation-ready.

### Divergence 2: Severity of the Diff-in-JSON Problem
- **GPT**: Not flagged as a distinct issue (mentioned JSON validity generally)
- **Gemini**: Elevated to Critical Issue #2 with a concrete sidecar-file solution
- **Grok**: Not flagged distinctly (subsumed under JSON validation)
- **Analysis**: Gemini's framing is the strongest here. LLMs writing multi-line code diffs inside JSON string values is a known, frequent failure mode. GPT and Grok addressed JSON validity in general but missed this specific, predictable failure vector. The sidecar `.patch` file approach is a pragmatic solution worth adopting.

### Divergence 3: Scalability Framing
- **GPT**: Framed as user counts (10-50, 50-500, 500-5000) but acknowledged this is really about sub-agent invocations
- **Gemini**: Same user-count framing, suggested pivot to API-backed queue at scale
- **Grok**: Same framing, suggested SQLite/Kafka migration path
- **Analysis**: All three applied the template's user-count framing somewhat literally. This is a single-agent protocol — the scaling dimension is discoveries-per-session, not users. The subagent analyses for all three reviews correctly noted this mismatch. At the actual scale this protocol will operate (single agent, handful of sub-agents per session), filesystem-based approaches are more than sufficient for the foreseeable future.

---

## Model Strengths Observed

*What each model was particularly good/bad at:*

| Model | Strengths | Weaknesses |
|-------|-----------|------------|
| GPT 5.4 | Most thorough gap analysis (10 items). Best at identifying internal contradictions and design philosophy tensions. Strong on lifecycle/state machine thinking. Most comprehensive recommendations. | Scalability section used wrong framing. Security analysis was somewhat generic. Missed the diff-in-JSON fragility that Gemini caught. |
| Gemini 3.1 Pro | Best unique practical insight (sidecar patch files). Strong systems-level engineering details (atomic writes, garbage collection). Best industry analogies (DLQ, maildir). Most concise and focused critical issues. | Fewer total findings than GPT. Could have elevated security/execution risk to critical. Scalability framing was template-literal. |
| Grok 4.1 Fast | Most actionable recommendations (with time estimates). Creative industry comparisons. Good at practical implementation details (UUID generation methods). Clean template adherence. | Overly optimistic scoring (APPROVE for a spec with acknowledged critical gaps). Internationalization point was a stretch. Less depth on lifecycle and ownership concerns. |

---

## Prioritized Recommendations

*Combined from all models, ordered by frequency and impact:*

| Priority | Recommendation | Flagged By | Impact |
|----------|---------------|------------|--------|
| P0 | Resolve worktree/sandbox isolation in core architecture (copy-back on teardown with failure handling) | GPT, Gemini, Grok | High — without this, the protocol silently fails in a primary deployment mode |
| P0 | Add atomic write protocol (write to `.tmp`, rename to `.json`) and concurrency controls for triage (`.processing` rename or flock) | GPT, Gemini, Grok | High — prevents data corruption and race conditions under real multi-agent use |
| P1 | Extract code diffs to sidecar `.patch` files instead of embedding in JSON strings | Gemini | High — prevents the most predictable LLM failure mode in this protocol |
| P1 | Add JSON schema validation in triage and session-start hooks; route invalid files to `invalid/` directory | GPT, Gemini, Grok | Med-High — prevents pipeline failures from malformed discoveries |
| P1 | Define formal discovery lifecycle state machine with disposition metadata schema | GPT, Gemini | Med-High — prevents implementation divergence and enables audit |
| P2 | Add schema versioning (`schemaVersion: 1`) with forward-compatibility rules | GPT | Medium — prevents silent breakage as the protocol evolves |
| P2 | Add security section (no secrets in artifacts, redaction guidance, review-before-apply) | GPT, Gemini, Grok | Medium — addresses trust model gap in autonomous execution context |
| P2 | Add garbage collection for `processed/` directory (TTL-based cleanup) | Gemini, GPT | Medium — prevents unbounded state growth |
| P3 | Add rate limiting / discovery caps per session (e.g., max 5-10 per task) | Gemini, GPT | Low-Med — prevents noisy sub-agents from flooding the system |
| P3 | Add scope heuristics and examples for what qualifies as a discovery | GPT | Low-Med — helps calibrate sub-agent capture behavior |
| P3 | Specify UUID generation method in sub-agent prompt | Grok | Low — practical implementation detail, easy to add |
| P3 | Resolve "zero overhead" principle vs pre-created directories (prefer lazy-create) | GPT | Low — internal consistency, not functional |

---

## Gaps Across All Reviews

*Areas that NO model adequately covered:*

1. **Token budget realism for sub-agent prompt injection**: The spec claims <100 tokens but no model rigorously verified this against the actual prompt text + JSON schema. Gemini noted the schema alone is 75-90 tokens but didn't calculate the full injection. If the prompt injection exceeds budget, it undermines the "zero overhead" principle.

2. **Testing and validation plan**: GPT mentioned the absence of acceptance criteria by component, but no model proposed specific test scenarios or a validation strategy. For a protocol that spans sub-agents, filesystem operations, hooks, and API integration, a concrete test plan would catch integration issues early.

3. **Interaction with git-sync and backup systems**: Discoveries in `.instar/state/` will be picked up by git-sync and backup snapshots. No model explored whether this is desirable (it probably is for durability) or whether it creates noise (many small files in commits). The interaction with existing state management deserves explicit consideration.

4. **Sub-agent compliance and prompt effectiveness**: No model deeply explored whether the proposed prompt injection will actually cause sub-agents to write well-formed discoveries consistently. The prompt is aspirational — real-world LLM compliance with structured output instructions varies significantly by model, context length, and task complexity.

---

## Key Takeaway

The cross-model review reveals strong consensus that this is a well-designed protocol solving a genuine problem, but it has three critical gaps that a single-model review might have downplayed: worktree isolation (all three), filesystem atomicity (all three), and LLM JSON+diff fragility (Gemini alone, but the strongest practical insight of the entire review). The most important finding is Gemini's sidecar `.patch` file proposal — it addresses a failure mode that GPT and Grok both missed despite being the most predictable point of failure in production. The most important action item is resolving the P0 issues (worktree copy-back and atomic writes) before implementation begins, as these determine whether the protocol is reliable or merely ceremonial.

---

*Generated by CrossReview cross-model analysis.*
