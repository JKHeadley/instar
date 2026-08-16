## Architecture Review: docs-code-sync
**Review ID:** 20260328-114147 | **Round:** 1 | **Reviewer Role:** Systems Architect

**Approval Status: APPROVED WITH RECOMMENDATIONS**
**Score: 7.5 / 10**

The architecture is fundamentally sound. The three-phase pipeline is pragmatic, the tiered LLM cost model is well-considered, and the edge case coverage is unusually thorough. No blocking architectural issues, but several design choices need attention before implementation.

---

### Research Findings

**LLM Pipeline Architecture:** Production deployments have converged on pipeline-oriented DAG architecture where the LLM acts as a per-step worker, not an end-to-end orchestrator. Key finding: safety logic should live in infrastructure, not prompts. This spec partially follows this — Phase 1 is a solid infrastructure gate, but Phase 2's staleness judgment lives entirely inside prompts.

**Incremental Code Analysis:** Incremental analysis is faster but can miss broader impact of changes when dependencies extend beyond modified components. The spec's "always check structural docs" heuristic compensates for this correctly.

**Grep vs. AST for Dependency Mapping:** Grep carries false positives (comments, test files) and false negatives (semantic references that don't match symbol names). For documentation sync — where docs reference symbols by name — grep is the right pragmatic choice. The `docCodeMap` cache is the correct long-term answer.

**Tiered LLM Routing:** The 3-way classification (ACCURATE/STALE/UNCERTAIN) is exactly right. Cheap models that fail frequently cost more than expensive models that succeed once. The UNCERTAIN escape hatch prevents Haiku from forcing low-confidence decisions into Phase 3.

---

### Critical Issues

**1. Grep fallback has no upper bound (MEDIUM)**
Phase 2a greps "all doc files" for every unmapped module with no cap on resulting (doc-section, change) pairs. On a cold `docCodeMap`, this could expand unbounded before Haiku triage begins. Recommendation: cap at ~50 pairs per run, prioritized by match precision (exact path > exported symbol > module name > structural docs).

**2. `docCodeMap` stale entries have no TTL (MEDIUM)**
`lastVerified` is stored but never used to invalidate entries. If `src/threadline/` is renamed to `src/relay/`, the old entry keeps that doc from being re-discovered via grep. Recommendation: re-verify cache entries older than N days, or run grep in parallel with cache lookup and reconcile.

**3. Line range instability (MEDIUM)**
Phase 3 operates on `lines {start}-{end}` from Phase 2. If the doc was edited between Phase 2 and Phase 3 (git pull, concurrent job), line numbers shift. Recommendation: store a content hash of the target section alongside line numbers; verify the hash before applying the edit.

**4. Sonnet subagent scope creep (HIGH)**
The Phase 3 prompt relies on prompt compliance to enforce "update ONLY the stale section." Sonnet may reason about the full doc and make broader edits. This is a promissory boundary, not a programmatic one. Recommendation: after the subagent writes output, apply a structural diff — if more than the target section changed, flag for human review instead of auto-committing.

---

### Recommendations

**R1: Section-hash-based staleness caching** — Cache ACCURATE verdicts keyed on `(docPath, sectionHash, codeCommit)`. If neither the doc nor the code has changed since the last ACCURATE assessment, skip the Haiku call. Estimated 40–60% reduction in steady-state token burn.

**R2: Fix the gate expression** — The shell one-liner in the job definition breaks if the state file doesn't exist (first run), is malformed, or python3 isn't on PATH. Extract into a helper script with explicit missing-state-file handling (treat as "no prior run → always run").

**R3: Escalate persistent UNCERTAIN items** — UNCERTAIN items that persist unresolved for 2+ runs should be added to the Telegram attention queue, not just buried in handoff notes.

**R4: Batch by doc file, not by changed module** — All (doc-section, change) pairs for a single doc file should go in one Haiku call. Minimizes calls while keeping context coherent.

**R5: Version the state schema** — Add `"schemaVersion": 1`. The schema will evolve; migration/reset needs a signal.

---

### Observations

The spec gets a lot right: the three-phase separation of concerns, the UNCERTAIN escape hatch, the well-considered exclusion list, the large-refactor fallback (>50 files), the per-commit traceable messages, and `knownUndocumented` tracking.

Gaps: No programmatic sanity check after Phase 3 (just "does it make sense?" — not checkable). The secondary doc trigger (module-level) and primary doc discovery (symbol-level) operate at different semantic granularities, creating potential coverage inconsistency. The spec is silent on whether Phase 3 subagents run in parallel (parallel is faster but could produce merge conflicts on cross-referencing docs). The `runHistory` array grows unbounded — needs a cap or rotation.

---

### Scalability Assessment

Current scope (instar, echo-only): fully adequate. Multi-agent expansion is a straightforward generalization (per-agent config, per-agent state). Grep-based discovery does not scale beyond a few hundred doc files — at that scale a proper inverted index is needed, but that's not the current problem. The `docCodeMap` is the right incremental step.

| Dimension | Score |
|-----------|-------|
| Technology Choices | 8/10 |
| System Design | 8/10 |
| API Design | 8/10 |
| Data Architecture | 6/10 |
| Integration Points | 9/10 |
| Operational Concerns | 7/10 |
| Complexity Budget | 8/10 |
| Evolution Path | 7/10 |
| **Overall** | **7.5/10** |

**Approved for implementation.** Address the 4 Critical Issues before first deploy. R1 (section-hash caching) and R4 (batch by doc file) are worth implementing early.
