# SpecReview Synthesis: docs-code-sync

**Review ID**: 20260328-114147
**Date**: 2026-03-28
**Round**: 1
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing
**Spec**: specs/docs-code-sync.md

---

## Overall Assessment

**Status: NEEDS WORK**

The spec describes a well-designed, cost-aware, three-phase documentation sync pipeline with unusually thorough edge case coverage. The architecture is fundamentally sound. However, a cluster of critical security and safety issues — specifically around prompt injection, autonomous writes to behavioral config files, and lack of human-in-the-loop gates — prevent it from being approved as written.

**Average Score: 6.6 / 10**
**Score Range: 5.0 – 7.5**

| Reviewer | Status | Score | Key Finding |
|----------|--------|-------|-------------|
| Security | NOT APPROVED | 5.0 | Prompt injection via git diff + auto-commit to CLAUDE.md = critical attack surface |
| Scalability | CONDITIONAL APPROVE | 7.0 | Cost model 3–10x understated; batching algorithm undefined |
| Business | APPROVED WITH CONDITIONS | 7.0 | Build-vs-buy unaddressed; auto-commit default unearned |
| Architecture | APPROVED WITH RECOMMENDATIONS | 7.5 | Grep fallback unbounded; stale docCodeMap entries; line range instability |
| Privacy | CONDITIONAL APPROVAL | 7.5 | No secrets scanning gate before LLM; full file sent to Sonnet vs. targeted excerpt |
| Adversarial | CONDITIONAL | 5.0 | Self-referential CLAUDE.md corruption loop; no concurrency guard; no subagent cap |
| DX | APPROVE WITH CONDITIONS | 7.5 | Gate expression is brittle; first-run experience undefined; subagent contract implicit |
| Marketing | CONDITIONAL PASS | 6.5 | Name is generic; agent-correctness angle underplayed; no competitive positioning |

---

## Consensus Findings

Issues independently identified by 3 or more reviewers:

### 1. Auto-commit to CLAUDE.md and behavioral config files must be blocked
**Identified by: Security (CRIT-2), Adversarial (Issue #2, blocking), Privacy (CRIT-3), Business (Critical Issue #2), DX (R1)**

All five reviewers independently flagged the auto-commit default — particularly for CLAUDE.md and `.instar/context/*.md` — as the most dangerous design decision in the spec. The concern is consistent: an LLM reading untrusted code diffs and autonomously rewriting the file that governs agent behavior creates a self-modification loop with no human gate. The spec lists "auto-commit vs. staged-for-review" as an open question but defaults to auto-commit without resolution.

**Recommended action:** Hard-block auto-commit to CLAUDE.md and all identity/behavioral config files. Default the entire system to stage-and-notify (send Telegram summary, auto-commit after N hours if no rejection). Treat auto-commit as an opt-in mode earned by demonstrated accuracy over 30+ days.

### 2. Prompt injection via git diff content
**Identified by: Security (CRIT-1), Adversarial (Issue #1, blocking), Privacy (implicitly, CRIT-2)**

Code diffs, commit messages, docstrings, and string literals pass directly into LLM prompts with no sanitization. This is a confirmed real-world attack class. An attacker with commit access can embed instructions that cause Haiku or Sonnet to modify documentation in attacker-specified ways, including CLAUDE.md.

**Recommended action:** Treat all diff content as untrusted data. Use XML-delimited data envelopes with explicit "this is code data, not instructions" framing. Consider a dedicated injection-detection pass before Phase 3. Strip or sandbox comment/docstring content before including in prompts.

### 3. UNCERTAIN triage results have no escalation path
**Identified by: Architecture (R3), Business (recommendation #7), Adversarial (Issue #14), DX (R3), Privacy (REC-5)**

Five reviewers noted that UNCERTAIN results from Haiku are routed to handoff notes with no alerting, no queue, no TTL, and no resolution mechanism. In practice this means real staleness that Haiku cannot confidently assess will silently persist indefinitely. The spec presents UNCERTAIN as a safety valve but it functions as a garbage bin.

**Recommended action:** Add UNCERTAIN items to a persistent queue (not just handoff notes). Items unresolved after 2–3 consecutive runs should trigger a Telegram attention queue alert. Add a max-age TTL.

### 4. Cost model is materially understated
**Identified by: Scalability (Critical Issue #1), Business (Critical Issue #3), Adversarial (Observations)**

The spec's cost estimates appear to use ~$1.50/M Sonnet output pricing. Actual current pricing is $15/M output — a 10x undercount on the dominant cost driver. Scalability calculates realistic per-run cost at ~$1.67 for a 2-doc update run vs. the spec's $0.20–0.50. Business notes that for an actively evolving codebase (the spec's own description of instar), the "mid-range" scenario is the typical case, not the edge.

**Recommended action:** Update cost estimates using verified current pricing. Add a realistic median alongside the optimistic floor. Implement hard per-run cost caps (`maxCostPerRun: $2.00`) with abort-on-exceed.

### 5. docCodeMap stale entries have no TTL or pruning strategy
**Identified by: Architecture (Critical Issue #2), Adversarial (Issue #6), DX (Observations), Scalability (R5)**

The `lastVerified` timestamp is stored but never used to invalidate entries. Renamed modules, deleted docs, and false-positive grep matches accumulate permanently. Over time the map grows unbounded and includes noise that inflates per-run scope.

**Recommended action:** Add TTL to docCodeMap entries. Re-verify entries not confirmed in >30 days via grep. Provide a manual override mechanism to remove false-positive mappings.

---

## Critical Issues (Blockers)

### BLOCK-1: Prompt injection via diff content (Security CRIT-1, Adversarial Issue #1)
An attacker with commit access can embed LLM instructions in code comments, docstrings, or string literals. These pass directly into Haiku and Sonnet prompts. In the worst case (which the spec enables by default), this achieves persistent agent compromise via CLAUDE.md rewrite. No defense exists in the current spec. This is not theoretical — CVE-2025-53773 demonstrated RCE via code comment prompt injection with CVSS 9.6.

### BLOCK-2: Auto-commit to CLAUDE.md / self-referential corruption loop (Security CRIT-2, Adversarial Issue #2)
The spec auto-commits Sonnet-generated updates to CLAUDE.md — the behavioral specification loaded at every session start. This creates a loop: code change → CLAUDE.md flagged stale → Sonnet rewrites it → next session Echo has different instructions → Echo behaves differently → generates different code → triggers next update. Combined with BLOCK-1, a single crafted commit can achieve persistent agent hijacking.

### BLOCK-3: State file injection and TOCTOU race (Security CRIT-3)
The `docCodeMap` state file has no integrity protection, no schema validation, and no atomic write semantics. Tampering can inject entries pointing to arbitrary paths. A race condition between gate check and execution can cause operation on an inconsistent baseline. If the state file is corrupted or manually cleared, the next run diffs from git epoch — potentially processing thousands of files and burning unbounded token cost.

---

## Conflicts

### Conflict 1: Should CLAUDE.md be in scope at all?
- **Adversarial** says hard-exclude CLAUDE.md and all identity files from autonomous updates — period.
- **Business and Privacy** say a two-tier approach works: auto-commit for routine docs, human-required approval for CLAUDE.md and safety files.
- **Security** says require human approval before any write to CLAUDE.md specifically.

**Resolution:** The adversarial position (hard-exclude) is safest for v1. The two-tier approach is the right long-term design once the system has proven accuracy. Start with hard-exclude; unlock CLAUDE.md updates as an explicit opt-in after the system demonstrates >95% precision over 30+ days.

### Conflict 2: Haiku vs. Sonnet for triage of sensitive files
- **Adversarial** says use Sonnet (not Haiku) for triage when the doc section is in Echo's identity/context files, accepting the higher cost as insurance against 30%+ false positive rates.
- **Scalability** says Haiku triage is correct architecture; the issue is budget caps and batch API usage, not model selection.

**Resolution:** Use Sonnet for triage on safety-critical docs (CLAUDE.md, `.instar/context/*.md`). Maintain Haiku for routine docs. This is a targeted carve-out, not a full model swap.

### Conflict 3: Parallel vs. sequential Phase 3 execution
- **Scalability** explicitly recommends sequential Phase 3 to avoid rate limits and partial-commit states.
- **Architecture** notes the spec is silent on this but implies parallel execution.
- **Adversarial** notes no subagent cap exists.

**Resolution:** Sequential Phase 3 execution with a hard cap (5 subagents per run maximum). Queue excess for the next run via handoff notes.

---

## Recommendations (Prioritized)

| Priority | Recommendation | Source Reviewers | Effort | Impact |
|----------|----------------|-----------------|--------|--------|
| P0 | Hard-block auto-commit to CLAUDE.md and all behavioral config files; require explicit human approval | Security, Adversarial, Privacy, Business, DX | Low | Critical |
| P0 | Implement structured data enveloping (XML-tagged blocks) for all diff content passed to LLMs; treat as untrusted user input | Security, Adversarial | Low | Critical |
| P0 | Add `jobInProgress` concurrency guard flag in state file | Adversarial, Security | Low | High |
| P1 | Cap Sonnet subagents at hard maximum per run (suggest: 5); queue excess to handoff notes | Adversarial, Scalability | Low | High |
| P1 | Two-phase state commit: write `pendingCommit` at start, promote to `lastCheckedCommit` only on clean exit | Adversarial, Security | Low | High |
| P1 | Add secrets-scanning gate at end of Phase 1 before any LLM calls; reject/redact `.env*`, `*credentials*`, `*.pem`, `*.key` content | Privacy, Security | Medium | High |
| P1 | Update cost model to current Sonnet pricing ($15/M output); add per-run hard cost cap (`maxCostPerRun: $2.00`) | Scalability, Business, Adversarial | Low | High |
| P1 | Implement UNCERTAIN item queue with Telegram escalation after 2–3 unresolved runs | Architecture, Business, Adversarial, DX, Privacy | Medium | Medium |
| P2 | Replace inline gate expression with a named script (`.instar/scripts/docs-code-sync-gate.sh`) | DX, Security | Low | Medium |
| P2 | Document and implement a first-run bootstrap strategy (recommended: set `lastCheckedCommit` to HEAD and exit; let next run handle actual changes) | DX | Low | Medium |
| P2 | Add TTL to docCodeMap entries; re-verify entries not confirmed in >30 days | Architecture, Adversarial, Scalability, DX | Medium | Medium |
| P2 | Add structural diff check after Phase 3: if >20% of section content changed or imperative language added, require human approval | Security, Architecture, Adversarial | Medium | High |
| P2 | Scope code content sent to Sonnet to the specific changed function/class (+/- 20 lines context), not full file | Privacy, Adversarial, DX | Low | Medium |
| P2 | Add oscillation detection: track doc section content hashes; if a section changes >N times in M days, escalate to human review | Adversarial | Medium | Medium |
| P3 | Use Batch API for Phase 2 Haiku triage calls (50% cost savings, removes rate limit pressure) | Scalability | Medium | Medium |
| P3 | Add section-hash-based staleness caching: skip Haiku call if neither doc nor code has changed since last ACCURATE verdict | Architecture | Medium | Medium |
| P3 | Add explicit build-vs-buy analysis; justify why DeepDocs/Swimm cannot handle general doc scope | Business | Low | Low |
| P3 | Add `dryRun: false` job config flag; dry-run executes Phases 1–2 only, producing a report without committing | DX | Low | Medium |
| P3 | Add false-positive tracking to state file; require measured accuracy threshold before enabling auto-commit | Business | Medium | High |
| P3 | Use dedicated git author identity for auto-commits; add `Auto-updated-by: docs-code-sync` trailer | Adversarial, Privacy, DX | Low | Low |
| P3 | Version the state schema (`"schemaVersion": 1`) | Architecture | Trivial | Low |

---

## Scalability Summary

### MVP (Current scope — single instar repo, echo-only)
**Consensus view:** Viable with critical issue mitigations. Cost is manageable at $20–60/month realistic median. The gate skip, tiered model selection, and docCodeMap cache are well-designed for this scale. No architectural blockers.
**Key risks:** Cost model underestimates by 3–10x without pricing correction; unbounded runHistory array (~2,000 entries/year at 6 runs/day); Phase 3 without subagent cap could spike cost on any active sprint.

### Growth (10x — ~2,000 source files, 80 docs, 3–5 agents)
**Consensus view:** Needs R1 (Batch API), R2 (budget caps), and sequential Phase 3 before reaching this scale. docCodeMap pairs per run hit 200+; concurrent Phase 3 hits rate limits; monthly cost reaches $200–400 without optimization.
**Key risks:** Undefined batching algorithm becomes a cost trap as docCodeMap fills; no UNCERTAIN drain causes accumulating technical debt; multi-agent state management requires architectural changes not yet specified.

### Scale (100x — ~20,000 source files, 300+ docs)
**Consensus view:** Requires architectural rethink. Grep fallback becomes the bottleneck (15,000+ grep operations per run); JSON state file needs migration to SQLite; rename detection hits 400-file ceiling frequently.
**Key risks:** FTS5 inverted index needed over doc corpus; docCodeMap pruning becomes mandatory; per-agent state isolation creates coordination complexity.

### Viral spike (adversarial input scenario)
**Consensus view:** No circuit breaker exists. A PR with 200 meaningful file changes touching documented APIs could legitimately trigger 20–30 Sonnet subagents in a single run at $15+ cost. A cold-start after state loss has no defined recovery path and could replay from git epoch.
**Key risks:** No `maxCostPerRun` enforcement; no subagent cap; no cold-start recovery procedure; state corruption → unbounded token burn.

---

## Name Analysis

*(From Marketing reviewer)*

**Current name: `docs-code-sync`**
Assessment: Functional, forgettable. Communicates what it does, but has zero memorability, no emotional texture, and competes directly with every generic description a developer might search. Sounds like a feature spec title, not a product. Slug-only format signals internal job, not product.

**Alternative candidates:**

| Name | Concept | Strengths | Risks |
|------|---------|-----------|-------|
| **Drift** | The problem reclaimed as product identity | Short, evocative. "Drift catches drift." | Common in ML/data drift monitoring space |
| **Groundtruth** | Docs reflecting what code actually does | Strong implied promise; developer-resonant | Awkward as one word |
| **Keepup** | Continuous act of staying current | Action-oriented, conversational | "Chasing" connotation implies always behind |
| **Freshen** | Making stale docs fresh | Warm, human, transformative | Too casual; doesn't convey intelligent detection |
| **Anchorpoint** | Docs anchored to code reality | Implies stability and structural bond | Long; less obvious what it does |

**Recommended name: Drift** — with tagline "Catches documentation drift before it catches you." The irony of using the problem name as the solution name is memorable. Validate against existing products before committing.

**Runner-up: Groundtruth** — for precision-oriented positioning.

**Marketing note:** The most differentiated angle — docs that instruct autonomous agents where staleness is a correctness failure, not just an inconvenience — is currently underplayed. No commercial competitor (Swimm, DeepDocs, Mintlify, Fern) addresses agent-facing instruction files. This is the actual wedge.

---

## Gaps

Areas no reviewer adequately covered, or areas where the spec is silent:

1. **Cold-start recovery procedure**: If the state file is lost or corrupted, what is the safe recovery path? Multiple reviewers flagged the risk but none specified a recovery procedure. The spec needs an explicit "first run after state loss" strategy distinct from normal first-run bootstrapping.

2. **Deletion tracking in Phase 1**: The adversarial reviewer flagged that deleted functions/exports are tracked differently than modifications — a deleted function with no docCodeMap entry may never trigger a doc check. Phase 1 should track deletions separately. No reviewer proposed a concrete implementation.

3. **Rollback procedure**: If a doc update is committed and later found incorrect, what is the rollback path? The spec is silent on this. Given auto-commits would be attributed to the git user (not a bot identity by default), identifying and reverting them is non-trivial without the `Auto-updated-by` trailer.

4. **Cross-doc consistency**: If two docs both reference the same changed API, Haiku assessments run independently and may produce conflicting verdicts (one STALE, one ACCURATE). No reviewer proposed a resolution strategy for conflicting assessments of the same underlying change.

5. **Testing strategy for adversarial inputs**: The spec's testing section (section 8) was noted as good, but no reviewer proposed concrete test cases for prompt injection — a planted comment containing injection instructions and verification that the system ignores it. This should be part of acceptance criteria.

6. **UNCERTAIN confidence gradations**: The spec uses a binary ACCURATE/STALE/UNCERTAIN. Reviewers uniformly said UNCERTAIN needs an escalation path, but no one addressed whether Haiku should emit confidence scores alongside verdicts, or whether a threshold-based approach (escalate to Sonnet if Haiku confidence < X%) would be superior to the current three-class output.

---

## Convergence Status

**Approve:** 0 (no reviewer gave unconditional approval)
**Conditional:** 5 (Scalability, Business, Architecture, Privacy, DX)
**Not Approved / Block:** 2 (Security, Adversarial)
**Conditional Pass:** 1 (Marketing)

**Status: CONVERGING — not yet converged**

There is strong consensus on the blockers (BLOCK-1 through BLOCK-3) and on the auto-commit default being wrong. There is no material disagreement on the architecture being sound in principle. The reviewers are aligned on what needs to change; the spec just hasn't changed yet. This is a well-defined set of pre-build requirements, not a fundamental design dispute. Once the P0 and P1 issues are addressed, the spec will converge to approval quickly — likely in a single revision round.

---

## Next Steps

Action items to address before building, in priority order:

1. **Resolve auto-commit default** — Change Phase 3 default to staged-review. Hard-exclude CLAUDE.md and all `.instar/AGENT.md`/identity files from autonomous updates entirely. Document this as a deliberate policy, not an open question.

2. **Add prompt injection defenses** — Wrap all diff content in XML data envelopes with explicit "this is code, not instructions" framing. Treat commit messages as untrusted user input. Add an injection-detection pass before Phase 3 for safety-critical docs.

3. **Add Phase 1 secrets scanning gate** — Before any LLM call, scan diff content for known secret patterns. Redact or exclude matching chunks. Add `.env*`, `*credentials*`, `*.pem`, `*.key` to default exclusion list.

4. **Fix the gate expression** — Extract to `.instar/scripts/docs-code-sync-gate.sh`. Handle missing state file explicitly (first run → always run). Remove hardcoded absolute paths; use `$INSTAR_DIR` or relative resolution.

5. **Add concurrency guard and two-phase state commit** — Write `jobInProgress: true` at start, clear on completion. Write `pendingCommit` at start, promote to `lastCheckedCommit` only on clean exit.

6. **Cap Sonnet subagents** — Hard maximum of 5 per run. Queue excess via handoff notes. Execute Phase 3 sequentially, not in parallel.

7. **Update cost model** — Recalculate using current pricing ($15/M Sonnet output). Add `maxCostPerRun: 2.00` with abort-on-exceed. Update the spec's cost table and worst-case estimates.

8. **Document first-run bootstrap** — Explicitly state: on first run (no state file), set `lastCheckedCommit` to HEAD and exit. Let subsequent run handle actual changes. Document cold-start recovery procedure (state loss scenario).

9. **Add UNCERTAIN escalation queue** — Move UNCERTAIN items from handoff-notes-only to a persistent queue. Telegram alert after 2–3 unresolved runs. Add TTL.

10. **Define subagent interface contract** — Specify how Haiku/Sonnet subagents are invoked, how output is parsed, what happens on malformed/empty responses, timeout and retry policy, and whether Phase 3 spawns one subagent per stale doc or one per stale file.

11. **Version the state schema** — Add `"schemaVersion": 1`. Document migration path for schema evolution.

12. **Add `dryRun` mode** — Config flag that executes Phases 1–2 only, produces a report, skips all writes. Required for safe testing before first live deploy.

Once items 1–6 are addressed, the spec should be re-reviewed. Items 7–12 can be resolved as implementation decisions without a full re-review cycle.
