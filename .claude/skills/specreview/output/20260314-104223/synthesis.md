# SpecReview Synthesis: Seed Migration

**Review ID**: 20260314-104223
**Date**: 2026-03-14
**Round**: 1
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing
**Spec**: specs/seed-migration.md

## Overall Assessment

**Status**: NEEDS WORK
**Average Score**: 7.0 / 10
**Score Range**: 6 - 8

| Reviewer | Status | Score | Key Finding |
|----------|--------|-------|-------------|
| Security | CONDITIONAL | 6 | No integrity verification on capabilities-reference.md; RAG poisoning attack surface |
| Scalability | CONDITIONAL | 7 | LLM triage cost may wipe out token savings; cache invalidation absent |
| Business | CONDITIONAL | 8 | Zero-search-count needs root cause analysis; anti-pattern timing is live risk |
| Architecture | CONDITIONAL | 7 | Triage is layer-level not node-level — undermines per-capability loading promise |
| Privacy | CONDITIONAL | 7 | Agent-specific instruction leakage risk; no tree isolation between agents |
| Adversarial | CONDITIONAL | 6 | Reference file is single point of compromise; degraded mode silently drops safety |
| DX | CONDITIONAL | 7 | No recovery path for irrelevant search results; tree query API undefined |
| Marketing | CONDITIONAL | 8 | "Migration" triggers anxiety; lead with coherence improvement, not cost savings |

## Consensus Findings

Issues that 3+ reviewers independently identified:

### 1. Anti-Pattern Loading Strategy Is Unresolved and Critical (7/8 reviewers)
**Reviewers**: Security, Scalability, Business, Architecture, Adversarial, DX, Marketing

The strongest consensus across all reviews. Open Question #5 is not optional — it is the single most dangerous behavioral regression in the spec. Every reviewer agrees: **the top 3-7 highest-consequence anti-patterns must stay in the seed.** The token cost (~300-500 tokens) is trivial against the cost of an agent that violates them. An agent about to "File and Wait" or "Escalate to Human" will not pause to query the tree for the rule telling it not to.

### 2. capabilities-reference.md Needs Integrity Protection (5/8 reviewers)
**Reviewers**: Security, Privacy, Adversarial, Scalability, Architecture

The new reference file becomes the authoritative source for agent behavioral instructions with zero tamper detection. This is a security regression from CLAUDE.md, which is git-tracked and visible in diffs. All five reviewers recommend HMAC signing (same mechanism Playbook already uses), with verification at every tree traversal.

### 3. Capability Summary Should Be Included in Seed (5/8 reviewers)
**Reviewers**: Scalability, Business, Architecture, Privacy, DX

Open Question #1 has a clear consensus answer: **yes, include a ~20-line one-liner-per-capability index.** Without it, an agent that doesn't know a capability exists can never query for it. The index provides awareness; the tree provides details. Growth concern is manageable (one line per new feature).

### 4. Single File vs. Many Files Has a Split but Leaning Answer (6/8 reviewers engaged)
**Reviewers favoring many files**: Security, Scalability, Privacy, Adversarial, DX (5 reviewers)
**Reviewers favoring single file**: Business, Architecture (2 reviewers)

The majority favors per-capability files for blast radius reduction, auditability, cache coherence, and least-privilege access. The minority favors single file for maintenance simplicity and heading-match reliability. See Conflicts section.

### 5. LLM Triage Cost Not Accounted For (3/8 reviewers)
**Reviewers**: Scalability, Architecture, DX

The spec's token savings projection (17,600 -> ~6,000) does not include the cost of the triage LLM calls themselves (500-1,500 tokens per call). At 3-5 queries per session, triage overhead could be 1,500-7,500 tokens — potentially wiping out the savings entirely. The cost model has a gap.

## Critical Issues (Blockers)

### B1. Triage Granularity Gap (Architecture)
The triage system scores **layers**, not individual nodes. A query about any capability loads ALL capability nodes (~35) simultaneously. This fundamentally undermines the per-capability loading promise that justifies the migration. **Must resolve before Phase 2.**

Options: (A) Extend TreeTriage to support node-level scoring within layers, (B) Create sub-layers, or (C) Accept aggregate loading with tight per-node token budgets.

### B2. No Integrity Verification on Reference File (Security, Adversarial, Privacy)
The file that will contain every agent behavioral instruction has no tamper detection. A compromised git pull, malicious sync, or bad upgrade script could silently rewrite agent behavior. HMAC signing (already used in Playbook) is the obvious fix.

### B3. Anti-Pattern Loading Must Be Resolved Before Phase 4 (All reviewers)
Open Question #5 is not deferrable. Resolution: top 5-7 anti-patterns stay in seed (~300-500 tokens); remaining anti-patterns go to tree; behavioral layer optionally loaded at session start via compaction-recovery hook.

### B4. Tree Query API Is Undefined (DX)
The spec describes what the tree contains and serves, but never defines the actual endpoint or command an agent calls. The seed's "Self-Knowledge Tree pointer" section promises "how to query the tree" but delivers no concrete API. Without this, agents cannot use the tree.

### B5. No Recovery Path for Irrelevant Search Results (DX)
The spec handles "tree is down" well but never addresses "tree returns wrong content." No confidence scoring, no "no match" signal, no retry protocol. This is the more common failure mode and the one most damaging to agent coherence.

## Conflicts

### Single File vs. Many Files (Open Question #4)
- **Many files** (Security, Scalability, Privacy, Adversarial, DX): Blast radius reduction, independent versioning, cache coherence, least-privilege access. A corrupted `publishing.md` doesn't take down `jobs.md`.
- **Single file** (Business, Architecture): Maintenance simplicity, reliable heading-match extraction, single editing surface, no broken path references.
- **Marketing**: Favors single file for tree traversal reliability but acknowledges the tradeoff.
- **Resolution recommendation**: The security and scalability arguments are stronger. Use per-capability files with a consistent naming convention (`context/capabilities/{node-id}.md`). The maintenance overhead is real but smaller than the blast radius of a monolith reference file.

### Session-Start Proactive Load (Open Question #3)
- **Against** (Business, Architecture): Adds ~2,000 tokens, negates 30% of savings.
- **Middle ground** (Scalability, DX): Load the capability index (~400-500 tokens) at session start, not the full content. Awareness without bloat.
- **Resolution recommendation**: Load the capability index (the 20-line summary) at session start. Defer full content to on-demand queries.

### Rule-Based vs. LLM Triage as Primary Path
- **DX**: Rule-based should be primary (fast, zero-cost), LLM triage as fallback for ambiguous queries.
- **Architecture**: LLM triage is more accurate but creates the cost scaling problem Scalability identified.
- **Resolution recommendation**: Rule-based primary, LLM fallback. This also eliminates the triage cost scaling concern.

## Recommendations (Prioritized)

| Priority | Recommendation | Source Reviewers | Effort | Impact |
|----------|---------------|------------------|--------|--------|
| P0 | Resolve anti-pattern loading: top 5-7 in seed, rest in tree | All 8 | Low | Critical |
| P0 | Add HMAC integrity verification to capabilities-reference.md | Security, Privacy, Adversarial | Medium | Critical |
| P0 | Fix triage granularity: node-level scoring or sub-layers | Architecture | High | Critical |
| P0 | Define the tree query API (endpoint, response format, confidence) | DX | Medium | Critical |
| P0 | Add confidence scoring and "no match" signal to tree responses | DX, Adversarial | Medium | High |
| P1 | Add ~20-line capability index to seed | Scalability, Business, Architecture, Privacy, DX | Low | High |
| P1 | Resolve single vs. many files (recommend: many files) | Security, Scalability, Privacy, Adversarial, DX | Medium | High |
| P1 | Account for triage LLM cost in token savings model | Scalability, Architecture, DX | Low | Medium |
| P1 | Define cache invalidation strategy (TTL + file-change events) | Scalability, Adversarial | Medium | High |
| P1 | Sanitize HTML comments and add content framing to retrieved content | Security | Low | High |
| P1 | Add path traversal protection (resolve symlinks, allowlist dirs) | Security | Low | Medium |
| P1 | Strip injection-resistance into triage prompt, validate node IDs | Security, Adversarial | Low | Medium |
| P2 | Explain zero-search-count root cause in spec | Business | Low | Medium |
| P2 | Add tree version pinning for rollback compatibility | Adversarial | Medium | Medium |
| P2 | Add schema version header to reference file(s) | Architecture | Low | Medium |
| P2 | Define tree isolation between agents on same machine | Privacy | Medium | Medium |
| P2 | Add staggered rollout mechanism for Phase 6 | Scalability | Medium | Medium |
| P2 | Separate tests into deterministic (every commit) and LLM-graded (phase gates) | Scalability | Low | Low |
| P2 | Rename "Degraded Mode" to "Resilience Mode" for user comms | Marketing | Low | Low |
| P3 | Add agent-facing introspection endpoints (/nodes, /nodes/{id}) | DX | Low | Medium |
| P3 | Define node count governance model (max ~50 with consolidation reviews) | Scalability | Low | Low |
| P3 | Create user-facing communication narrative (doctor analogy) | Marketing | Medium | Medium |
| P3 | Add false-positive rate test for triage accuracy | Architecture | Low | Low |

## Open Questions Resolution

### 1. Should the seed include a summary of capabilities?
**Consensus: YES (5/8 reviewers explicitly recommend it)**

Include a ~20-line, one-liner-per-capability index in the seed. It serves a fundamentally different purpose than the tree: the index answers "does this exist?" while the tree answers "how do I use it?" Without it, agents cannot discover capabilities they don't already know about. Growth is manageable (one line per new feature). Estimated cost: ~400-500 tokens.

### 2. How should agent-specific content be handled?
**Consensus: Agent-specific behavioral overrides stay in the seed (4/8 reviewers)**

Privacy and Architecture are most emphatic: identity constraints ("never use POST /feedback" for Echo) must be in the seed, not the tree. The test for inclusion: "Would violating this rule cause the agent to act against its fundamental role?" If yes, it stays in the seed. General capability documentation can go to the tree. The risk of contamination (other agents pulling Echo-specific rules from shared tree nodes) and deprivation (Echo losing critical overrides) is real.

### 3. Should the tree be queried at session start?
**Consensus: NO to full content, YES to capability index (~400-500 tokens) (5/8 reviewers)**

Loading the full capabilities layer (~2,000 tokens) at startup negates ~30% of savings. The better answer: load the capability index (the 20-line summary from Question 1) at session start for awareness. Defer full content to on-demand queries. For agents with known high-capability usage patterns, offer an optional config flag for proactive loading.

### 4. Context file organization: one big file or many small files?
**Consensus: MANY SMALL FILES (5 reviewers vs. 2)**

Security, Scalability, Privacy, Adversarial, and DX all favor per-capability files. The arguments: blast radius reduction (one corrupted file doesn't break all nodes), independent versioning, better cache coherence, least-privilege access, cleaner diffs. Business and Architecture favor single file for simplicity. The security and scalability arguments are stronger. Use `context/capabilities/{node-id}.md` naming convention.

### 5. Anti-pattern loading strategy?
**Consensus: HYBRID — top 5-7 in seed, rest in tree (7/8 reviewers)**

The strongest consensus in the entire review. Every reviewer who addressed this question independently arrived at the same answer: critical anti-patterns (File-and-Wait, Escalate to Human, Answer From Memory, GitHub Issues, Defensive Fabrication) must stay in the seed. These are ~300-500 tokens — well within budget. The remaining anti-patterns and gravity wells can go to the tree, loaded via behavioral layer at session start or on-demand. An agent about to violate an anti-pattern will not pause to query the tree for the rule.

## Scalability Summary

| Phase | Assessment | Key Risks | Reviewers Agree? |
|-------|-----------|-----------|-----------------|
| Phase 1 MVP (3 agents) | Manageable | Triage cost model gap; validate actual savings | Yes (8/8) |
| Phase 2 Growth (30 agents) | Requires fixes | Cache invalidation; triage granularity; shared vs. per-agent cache | Yes (6/8) |
| Phase 3 Scale (300 agents) | Two bottlenecks | Triage cost at 40% cold rate = ~480K tokens/day; reference file maintenance | Yes (5/8) |
| Viral Spike (1000 agents) | Needs rate limiting | Thundering herd on simultaneous migration; staggered rollout required | Scalability, Adversarial |

## Gaps

Areas that no reviewer adequately covered or that the spec is silent on:

1. **Rollback of tree config vs. rollback of CLAUDE.md**: The spec has good CLAUDE.md rollback, but rolling back a tree config to a version incompatible with the current instar version is not addressed. Only Adversarial touched this briefly.

2. **Multi-machine tree sync**: When an agent runs across multiple machines (laptop + desktop via `instar pair`), how does tree config sync? Is it part of git-sync? What happens when machines have different tree config versions temporarily?

3. **Tree query observability for operators**: No reviewer addressed how an operator (not an agent) can inspect what the tree is serving. A dashboard tab or API endpoint showing "last 10 tree queries and what was returned" would be valuable for debugging.

4. **Token budget enforcement**: The spec mentions `maxTokens` per node but no reviewer validated what happens when a retrieved section exceeds the budget. Is it truncated? Does the agent get a partial response? Is there a warning?

5. **Evolution system interaction**: The tree has an `evolution` layer, and the agent has an evolution system with proposals. No reviewer examined how evolution proposals that modify tree nodes are validated — could an evolution proposal add a poisoned node?

6. **Performance benchmarks**: No reviewer asked for actual latency numbers. How long does a tree query take end-to-end (triage + traversal + file read + response)? At what latency does it degrade the user experience in interactive Telegram sessions?

## Convergence Status

| Metric | Value |
|--------|-------|
| Reviewers in agreement (APPROVE) | 0 / 8 |
| Conditional approvals | 8 / 8 |
| Blockers | 0 / 8 (but 5 P0 issues from consensus) |
| Open conflicts | 2 (single vs. many files; session-start loading) |

All 8 reviewers gave conditional approval. No outright blocks, but no outright approvals either. The conditions cluster around 5 P0 issues that must be resolved before Phase 4 begins. Phases 1-3 (additive, non-destructive) can proceed immediately.

## Next Steps

1. **Resolve the 5 P0 issues** before Phase 2 begins:
   - Fix triage granularity (layer-level -> node-level)
   - Define tree query API (endpoint, response format, confidence scoring)
   - Add HMAC integrity verification to reference file(s)
   - Move top 5-7 anti-patterns into seed
   - Add irrelevant-result recovery path (confidence threshold + "no match" signal)

2. **Lock down the 4 open questions** (all have clear consensus answers):
   - Q1: Yes, include capability index in seed
   - Q2: Agent-specific behavioral overrides stay in seed
   - Q3: Load index at session start, not full content
   - Q4: Many small files with `context/capabilities/{node-id}.md`
   - Q5: Hybrid — top 5-7 anti-patterns in seed, rest in tree

3. **Add triage cost to the token savings model** — enumerate triage prompt tokens, calls per session, and cache hit assumptions. Validate net savings before declaring the cost case.

4. **Write a one-paragraph root cause analysis** for why the tree has zero searches. This shapes the risk profile for the entire migration.

5. **Define cache invalidation strategy** — TTL + file-change event triggers. Decide on per-agent vs. shared cache scope.

6. **Begin Phase 1-3** (additive phases) in parallel with P0 resolution. These phases are non-destructive and can proceed safely while the critical issues are addressed.

7. **Before Phase 6 (broad rollout)**: Create user-facing communication narrative. Lead with coherence improvement, not cost savings. Rename "Degraded Mode" to "Resilience Mode." Prepare rollback-first announcement structure.
