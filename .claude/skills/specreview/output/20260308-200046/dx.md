# DX & API Design Review: Discovery Protocol

**Spec:** Discovery Protocol -- Sub-Agent Opportunity Capture
**Review ID:** 20260308-200046
**Round:** 1
**Reviewer lens:** Developer Experience & API Design

---

## Approval Status: CONDITIONAL APPROVE

The protocol is well-motivated, grounded in a real problem, and follows sound design principles. The file-based, convention-over-configuration approach is the right call for sub-agent contexts where API access is unreliable. However, several DX gaps would cause friction for the first implementer and for sub-agents trying to use this correctly. These are fixable without redesign.

**Score: 7/10**

---

## Critical Issues

### 1. No helper for sub-agents to write discovery files correctly

The spec asks sub-agents to construct a JSON object with 15+ fields, a specific ID format (`disc-<8-char-uuid>`), an ISO timestamp, and correct enum values -- all from a brief inline prompt injection of ~100 tokens. This is the single biggest DX failure. Sub-agents will:

- Generate malformed IDs (wrong length, missing prefix)
- Use wrong enum values (e.g., `"medium-high"` instead of `"medium"`)
- Omit required fields
- Write to the wrong path

**Recommendation:** Provide a shell helper script (e.g., `.claude/scripts/write-discovery.sh`) that accepts key arguments and outputs a valid JSON file. The sub-agent prompt then becomes: "Run `.claude/scripts/write-discovery.sh --title '...' --category improvement --value medium --effort low --risk low --readiness implementation-complete --description '...'`". This shifts correctness from the LLM to the tool. Alternatively, provide a JSON schema file at `.instar/state/discoveries/schema.json` so sub-agents can validate before writing.

### 2. Worktree isolation is acknowledged but unresolved

Open Question #3 identifies that worktree-isolated sub-agents cannot write to the main `.instar/state/` directory. This is not an edge case -- it is the primary deployment mode for sub-agents doing focused work. The protocol is unusable in its most common execution context without a solution.

**Recommendation:** Define the worktree behavior now, even if the solution is simple. Options: (a) sub-agents write discoveries to a project-root-relative path and the parent copies them post-merge, (b) the session spawner passes the absolute path to the discovery directory as an environment variable, or (c) discoveries are written to a known location in the worktree and the worktree teardown script moves them. Pick one. An unresolved open question about the primary use case is a blocker.

---

## Recommendations

### 3. Add a concrete end-to-end example

The spec has a schema, a decision tree, and an implementation plan, but no walkthrough of a complete lifecycle. A single example showing: (a) sub-agent encounters opportunity, (b) writes discovery file (show the actual shell commands), (c) parent reads and triages, (d) discovery becomes evolution proposal -- would make the protocol immediately understandable. Show the commands, not just the schema.

### 4. Error handling and validation are absent

What happens when:
- A discovery file has invalid JSON?
- A required field is missing?
- Two sub-agents generate the same discovery ID?
- The `discoveries/` directory does not exist yet?

The spec says "convention over configuration" and "zero overhead when unused," which is good. But it also means there is no initialization step to create the directory. The first sub-agent to write a discovery will fail if the directory does not exist. Either the sub-agent must `mkdir -p` before writing (add this to the prompt), or the directory must be created during `instar init` (Step 1 mentions this but the sub-agent prompt section does not).

**Recommendation:** Add a one-liner to the sub-agent prompt: `mkdir -p .instar/state/discoveries && cat > .instar/state/discoveries/disc-$(uuidgen | cut -c1-8).json << 'DISC'`. This handles both directory creation and file naming in one command.

### 5. The `status` field is write-only for sub-agents

Sub-agents always write `"status": "pending"`. The parent then mutates the file to `"applied"`, `"proposed"`, or `"dismissed"` before moving it to `processed/`. This means the status field serves two masters: creation (always pending) and lifecycle (mutable). This is fine architecturally, but the spec should clarify that sub-agents MUST NOT read or depend on status of other discovery files. The directory is a write-only drop box for sub-agents.

### 6. Token budget claim needs validation

Success criterion #4 says the protocol adds "<100 tokens to sub-agent prompts." The proposed prompt injection in the spec (the "Sub-Agent Prompt Integration" section) is approximately 120-150 tokens as written. If a helper script exists, the prompt can be shorter. If not, the current text exceeds the stated budget. Either trim the prompt or revise the criterion.

### 7. The `selfAssessment` section creates perverse incentives

Sub-agents rating their own discoveries as "high value" and "low risk" is like asking a developer to rate their own PR. Every discovery will trend toward optimistic self-assessment. The parent triage step mitigates this, but consider whether self-assessment should be simplified to just `readiness` (the one field the sub-agent actually knows) and let the parent handle value/effort/risk scoring.

---

## Observations

### What works well

- **File-based over API-based** is exactly right. Sub-agents in worktrees, sandboxes, or resource-constrained contexts cannot reliably call HTTP endpoints. The filesystem is the universal interface.
- **The "dismissed-with-reason" requirement** is a strong design choice. It prevents the gravitational pull toward silent cleanup. This is the kind of structural enforcement that actually changes behavior.
- **Integration with the evolution system** is elegant. Discoveries do not create a new processing pipeline -- they feed into one that already exists. This is good architectural taste.
- **The real-world example** (observability hooks reverted) grounds the entire spec. Every reader immediately understands the problem.
- **Convention-based directory path** (`.instar/state/discoveries/`) follows the project's existing patterns and requires zero configuration.

### Naming and consistency

- The term "discovery" is well-chosen -- it avoids overloaded terms like "suggestion," "recommendation," or "finding."
- The `disc-` prefix on IDs is clean and greppable.
- Field naming is consistent with existing Instar conventions (`createdAt`, `selfAssessment`, camelCase throughout).

### Missing from the spec

- **No versioning on the schema.** If the discovery format changes, old files will break new parsers. Add a `"version": 1` field now.
- **No mention of concurrency.** Two sub-agents running in parallel could write discoveries simultaneously. JSON file writes are not atomic on most filesystems. Consider write-to-temp-then-rename (the standard atomic file write pattern).
- **No size limit or rate limit.** A sub-agent in a loop could generate hundreds of discovery files. The triage step would become unmanageable. Consider a soft cap (e.g., max 5 discoveries per session) mentioned in the prompt.

---

## Scalability Assessment

The protocol scales well for its intended use case (single-agent, handful of sub-agents, low-volume discoveries). Potential scaling concerns:

| Scenario | Risk | Mitigation |
|----------|------|------------|
| Many concurrent sub-agents | Low | File-per-discovery avoids contention; unique IDs prevent collisions |
| High discovery volume | Medium | No rate limiting; triage becomes a burden at >20 pending items |
| Multi-machine sync | Medium | Explicitly deferred; git sync of discoveries would create merge conflicts on status changes |
| Cross-agent sharing | Low (future) | Feedback/dispatch system is the right channel; no protocol changes needed |

The 30-day TTL proposal for untriaged discoveries is sensible. Auto-filing as evolution proposals (rather than deleting) preserves value while clearing the queue.

---

## Research Findings

### Agent-to-Agent Protocol Patterns (A2A, MCP)

Google's [Agent2Agent (A2A) protocol](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/) uses **Agent Cards** -- JSON documents at a well-known path (`/.well-known/agent.json`) that describe capabilities and endpoints. The [discovery mechanism](https://a2a-protocol.org/latest/topics/agent-discovery/) supports three modes: well-known path, registry-based, and static configuration. The Discovery Protocol spec aligns with the "well-known path" pattern (fixed directory, known schema), which is the simplest and most robust option for intra-system communication.

Key lesson from A2A: **discovery documents should be self-describing**. The current spec's discovery files lack a `version` or `schema` field, which A2A includes by default. Adding `"version": 1` would future-proof the format.

### File-Based IPC and the "Drop File" Pattern

The Discovery Protocol is essentially a [drop file IPC pattern](https://dev.to/leandronsp/inter-process-communication-files-1m34) -- one of the oldest and most battle-tested inter-process communication techniques. Eric Raymond's [Art of Unix Programming](http://www.catb.org/~esr/writings/taoup/html/ch07s07.html) notes that drop files are ideal when "a more elaborate and coordinated method of communication would be overkill," which matches this use case perfectly.

Known pitfalls of drop files that the spec should address:
- **Garbage accumulation** if processing is interrupted (the `processed/` directory and 30-day TTL handle this)
- **Collision risk** when multiple writers use the same filename (UUID-based naming handles this, but atomicity of writes is not addressed)
- **No delivery guarantee** (the session-start hook surfacing pending discoveries mitigates this)

### Convention Over Configuration in Developer Tools

Modern plugin/discovery architectures ([IT-Tools pattern](https://deepwiki.com/sharevb/it-tools/1-it-tools-overview), framework plugin systems) show that [convention over configuration](https://medium.com/@trees.william/convention-over-configuration-a-senior-architects-perspective-on-modern-software-design-fc08753960bb) works best when:
1. The convention is **documented with a concrete example** (the spec needs this)
2. There is a **validation tool** to check conformance (the spec proposes a JSON schema but does not provide one)
3. The **first experience is a success** -- new users should not debug format issues on their first attempt (the helper script recommendation addresses this)

### Multi-Agent Design Patterns

Google's [eight essential multi-agent design patterns](https://www.infoq.com/news/2026/01/multi-agent-design-patterns/) identify the **Orchestrator-Worker** pattern as the primary model for parent/sub-agent coordination. The Discovery Protocol fits within this pattern but adds a feedback channel from worker to orchestrator that most implementations lack. This is a genuine innovation -- most orchestrator-worker systems treat workers as pure functions with no side-channel output.

The [2026 guide to agentic design patterns](https://www.sitepoint.com/the-definitive-guide-to-agentic-design-patterns-in-2026/) emphasizes that agent coordination protocols should be **transport-agnostic**. The file-based approach satisfies this -- it works across worktrees, containers, and network boundaries (via shared filesystems), whereas HTTP-based protocols require network connectivity.

---

## Summary

The Discovery Protocol solves a real problem with a well-chosen architecture. The file-based, convention-driven approach is aligned with both Unix traditions (drop files) and modern agent protocol patterns (A2A's well-known paths). The main DX gaps are: (1) no helper tooling for sub-agents to write correct files, (2) unresolved worktree isolation, and (3) missing concrete examples. These are all addressable without changing the protocol design. Fix the critical issues and this is ready for implementation.
