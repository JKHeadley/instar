# Architecture Review: Discovery Protocol — Sub-Agent Opportunity Capture

**Review ID:** 20260308-200046
**Reviewer:** Systems Architect (Round 1)
**Spec:** `/Users/justin/.instar/agents/echo/specs/discovery-protocol.md`
**Date:** 2026-03-08

---

## Approval Status

**APPROVED WITH MINOR RECOMMENDATIONS**

The architecture is sound, well-scoped, and builds intelligently on existing infrastructure. The file-based IPC approach is the correct choice for this problem space. The design principles are strong and the implementation plan is realistic. A few refinements would harden it for production use.

---

## Score: 8/10

Strong design that correctly identifies the problem, chooses appropriate primitives, and integrates with existing systems. Points deducted for: missing concurrency handling in worktree scenarios (acknowledged but unresolved), absence of schema validation at write-time, and no explicit cleanup/garbage-collection mechanism for the processed directory.

---

## Research Findings

### File-Based IPC Patterns in Agent Systems

File-based IPC is a well-established pattern that is experiencing a renaissance in the agent ecosystem. The broader industry is converging on the filesystem as a first-class coordination primitive for AI agents:

- **AgentFS** (Turso) has formalized the concept of an "agent filesystem" with dedicated abstractions for agent state, treating files as the natural interface between isolated agent processes.
- **Vercel and LlamaIndex** have published guides arguing that "files and bash" may be the best architecture for agent coordination — minimal abstraction, maximum portability.
- The **"drop directory" pattern** (write a file, another process picks it up) is a decades-old IPC mechanism used in print spoolers, mail systems, and batch processing. It is robust precisely because it requires no runtime coordination — just filesystem semantics.

The spec's choice of file-based IPC over API-based communication is well-validated by industry practice. Sub-agents in worktrees or sandboxes may lack network access but will always have filesystem access. This is the right primitive.

**Key risk identified in research:** Multi-agent coordination via shared filesystem creates potential for race conditions and inconsistent views without structured timestamps and clear ownership semantics. The spec partially addresses this with unique IDs and timestamps, but see recommendations below.

### Discovery/Opportunity Protocols in Multi-Agent Architectures

The emerging multi-agent protocol landscape (A2A, ACP, ANP, MCP) is focused on real-time agent-to-agent communication. This spec addresses a different and less-explored problem: **asynchronous opportunity capture** within a hierarchical agent topology. This is closer to the "hierarchical orchestration" pattern described in Google's ADK multi-agent patterns, where a lead agent delegates to specialists and must handle their out-of-scope observations.

No existing protocol cleanly solves this specific problem. A2A handles discovery of agents (identity, capabilities), not discovery of opportunities by agents. The spec is filling a genuine gap. The decision to use a lightweight, convention-based approach rather than adopting a heavyweight protocol is appropriate given the scope.

### JSON Schema Validation for Agent Communication

Current best practices for structured agent output use JSON Schema with runtime validation libraries (Zod for TypeScript, Pydantic for Python). The MCP protocol itself uses JSON-RPC 2.0 with schema-defined tool interfaces. JSON Schema 2.0's vocabulary system enables modular, extensible validation — relevant for the discovery format which may evolve over time.

The spec defines a clear JSON structure but does not include a formal JSON Schema file for validation. This is a gap — see recommendations.

---

## Critical Issues

None. The architecture has no fundamental flaws that would block implementation.

---

## Recommendations

### 1. Add Write-Time Schema Validation (Priority: High)

The spec defines a JSON format but relies on sub-agents to produce valid files. LLM-generated JSON is notoriously unreliable — missing required fields, wrong types, malformed UUIDs. The parent triage phase should validate discovery files against a JSON Schema before processing, and malformed files should be moved to a `malformed/` subdirectory with an error log rather than silently failing or crashing the triage loop.

**Suggested addition to Step 1 of the implementation plan:** Ship a `discovery-schema.json` file and a lightweight validation function (or use `ajv` if already in the dependency tree). The triage helper in Step 4 should call this validator first.

### 2. Explicit Worktree Handling (Priority: High)

Open Question 3 identifies that worktree-isolated sub-agents cannot write to the main `.instar/state/`. This is not a future concern — it is a day-one blocker for any sub-agent running in a worktree. Two options:

- **Option A (simpler):** Sub-agents write discoveries to a well-known path relative to their own working directory (e.g., `.discoveries/` at worktree root). The parent copies them to `.instar/state/discoveries/` after the worktree task completes. This keeps the sub-agent protocol unchanged.
- **Option B:** The session spawner mounts or symlinks `.instar/state/discoveries/` into the worktree. More transparent but more fragile.

Recommend Option A for its simplicity and alignment with Design Principle 1 (file-based, not API-based).

### 3. Garbage Collection for Processed Discoveries (Priority: Medium)

The spec moves processed discoveries to `.instar/state/discoveries/processed/` but never deletes them. Over weeks/months of active sub-agent use, this directory will accumulate unboundedly. Add either:

- A TTL-based cleanup (delete processed discoveries older than 30 days), or
- A rolling retention policy (keep last N processed discoveries), or
- Integrate with the existing `git-sync` job to commit-and-purge processed discoveries.

### 4. Atomicity of Discovery Writes (Priority: Medium)

If a sub-agent crashes mid-write, a partial JSON file in the discoveries directory will break the triage loop. Use the standard write-to-temp-then-rename pattern: write to `.instar/state/discoveries/.disc-<id>.json.tmp`, then `rename()` to the final path. Rename is atomic on all major filesystems. This is a one-line change in the sub-agent prompt instructions but prevents a class of subtle failures.

### 5. Discovery Deduplication (Priority: Low)

Multiple sub-agents working on related files may independently discover the same opportunity. The triage phase should include a lightweight deduplication check — comparing `discovery.title` and `artifacts.files` against existing pending and recently-processed discoveries. Exact-match on title + files overlap is sufficient; no need for semantic similarity.

### 6. Token Budget Verification (Priority: Low)

Success Criterion 4 states the protocol should add fewer than 100 tokens to sub-agent prompts. The proposed prompt text in the "Sub-Agent Prompt Integration" section is approximately 120-130 tokens. This is close but exceeds the stated budget. Consider trimming the format specification to just the required fields (the sub-agent can infer optional fields) or linking to a schema file rather than inlining the format.

---

## Observations

### What Works Well

1. **Design Principle 3 (Separate capture from evaluation)** is the key architectural insight. It cleanly separates concerns: the sub-agent captures with low judgment overhead, the parent evaluates with full context. This is the right division of labor.

2. **The decision tree in Phase 2** is well-designed. The four dispositions (apply, propose, propose-deferred, dismiss-with-reason) cover all cases without ambiguity. The "dismiss-with-reason" requirement is particularly good — it forces the parent to articulate why a discovery lacks value rather than reflexively discarding it.

3. **Evolution system integration** is elegant. The field mapping from discovery format to evolution proposal format is clean, and reusing the existing `evolution-review` job means no new scheduling infrastructure is needed.

4. **Zero overhead when unused** (Principle 4) is correctly maintained. No polling, no empty directories, no state to initialize. A simple `ls` check is all the triage phase needs.

5. **Session-start hook integration** ensures discoveries survive across session boundaries. This is critical — without it, discoveries would accumulate silently with no forcing function for triage.

### Design Tensions Worth Noting

- **Local-only vs. synced state:** The spec proposes discoveries as local-only (not git-synced), but the evolution proposals they feed into ARE synced. This creates an asymmetry: a discovery filed as a proposal on Machine A will be visible on Machine B, but the original discovery context (rationale, artifacts) will not. If traceability matters, consider syncing at least the processed discoveries.

- **Sub-agent trust calibration:** The `selfAssessment` fields rely on the sub-agent accurately judging value, effort, and risk. LLM self-assessment is notoriously unreliable — models tend toward overconfidence on value and underestimate risk. The parent triage phase should treat these as hints, not authoritative signals. The spec implicitly does this (the parent re-evaluates), but making this explicit would strengthen the protocol.

- **Discovery volume control:** There is no mechanism to prevent a sub-agent from flooding the discoveries directory with low-value observations. Consider a soft limit (e.g., max 3 discoveries per session) in the sub-agent prompt instructions. This forces prioritization at the source rather than pushing all filtering to the parent.

---

## Scalability Assessment

**Current scale:** The protocol is designed for a single agent with occasional sub-agent spawns. At this scale (tens of discoveries per week), the file-based approach is more than adequate. Directory listing, JSON parsing, and file moves are all O(n) in the number of discoveries, and n will be small.

**Growth path:** If sub-agent usage increases significantly (hundreds of discoveries per week), the flat directory structure will still perform well — filesystems handle thousands of files in a single directory without issue. The triage process may become tedious at volume, which is where the "Future Work" item on automated triage becomes relevant.

**Multi-machine:** The local-only design is correct for now. If multi-machine discovery sharing becomes needed, the evolution proposal system already handles cross-machine sync. The migration path is clear: discoveries that matter get promoted to proposals (synced); raw discoveries stay local (ephemeral).

**Evolution path:** The architecture can evolve without rewrites. Adding schema validation, deduplication, automated triage, or cross-agent sharing would each be additive changes — none require restructuring the core capture/triage/route pipeline. This is a sign of good foundational design.

---

## Summary

This is a well-conceived protocol that solves a real problem (silent value loss in sub-agent workflows) with appropriate technology choices (file-based IPC, convention-over-configuration, integration with existing systems). The architecture is simple enough to implement in the estimated 4 hours, robust enough for production use with the recommended hardening (schema validation, atomic writes, worktree handling), and flexible enough to evolve as usage patterns emerge.

The strongest aspect of the design is its restraint — it does not over-engineer the solution. File drops, JSON files, directory conventions, and a decision tree. No new services, no new protocols, no new dependencies. This is the right level of complexity for the problem.
