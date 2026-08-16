# GPT 5.4 Review: discovery-protocol.md

**Model**: gpt-5.4
**Date**: 2026-03-08
**Focus**: full document

---

## Raw Model Response

## 1. Overall Assessment

- **Score**: 8/10
- **Status**: CONDITIONAL

This is a strong, pragmatic spec with a clear problem statement, sensible design principles, and an implementation path that matches the stated constraints. The core idea—durable, file-based capture of out-of-scope sub-agent discoveries with mandatory parent disposition—is well chosen and addresses a real workflow failure. The document is especially strong in separating capture from evaluation and in integrating with existing systems instead of inventing a parallel platform. However, it is not fully ready as written because several operational details are underspecified or internally inconsistent: directory lifecycle vs "zero overhead," concurrent writes and ID generation, worktree/isolation behavior, schema/versioning, processed-file semantics, and failure handling around triage/evolution submission. These are fixable, but they should be resolved before implementation to avoid a protocol that works in demos but loses reliability in real multi-agent use.

---

## 2. Critical Issues (Must Fix)

### Issue 1: Internal contradiction on "zero overhead" vs pre-created directories
- **What**: The design principle says "Zero overhead when unused. If a sub-agent has no discoveries, nothing happens. No empty files, no polling, no state to clean up." But the implementation plan says to create `.instar/state/discoveries/` and `.instar/state/discoveries/processed/` during init.
- **Why it matters**: This creates ambiguity about intended behavior and weakens the design philosophy. It also affects migration, gitignore behavior, session-start logic, and user expectations. If directories are always created, the "unused" case still has persistent state.
- **Suggested fix**: Pick one of two models and state it explicitly:
  1. **Lazy-create model**: Create the directory only when the first discovery is written. Hooks should tolerate absence.
  2. **Pre-create model**: Keep the directory always present, but revise the design principle to "near-zero operational overhead" rather than "nothing happens."

  Lazy-create is more aligned with the stated principles.
- **Section reference**: Design Principles #4; Implementation Plan Step 1; Success Criteria #5

---

### Issue 2: No concurrency/atomicity rules for discovery file creation and processing
- **What**: The spec assumes simple filesystem writes and `ls`, but does not define how to avoid collisions, partial writes, duplicate processing, or races between multiple sub-agents/parents.
- **Why it matters**: In multi-agent or worktree-heavy environments, two sub-agents may generate the same ID pattern, write simultaneously, or a parent may triage while a file is still being written. This can produce corrupt JSON, lost discoveries, double-triage, or inconsistent statuses.
- **Suggested fix**: Add explicit file operation rules:
  - Write to a temp file, then atomic rename to `<id>.json`
  - Require sufficiently unique IDs (full UUID or timestamp+random)
  - Parent only processes files matching schema and not ending in `.tmp`
  - On triage, atomically move file to a "processing" or "processed" location, or use a lock file
  - Define idempotency behavior if a discovery is processed twice
- **Section reference**: Phase 1: Capture; Phase 2: Triage; file naming and status semantics throughout

---

### Issue 3: Worktree/isolation handling is identified but not specified
- **What**: The spec's own design principle says sub-agents may run in worktrees or sandboxes, and the open questions note that isolated worktrees may not write to the main `.instar/state/`. But this is left unresolved despite being central to the protocol.
- **Why it matters**: This is not a peripheral edge case; it is a primary deployment mode. Without a defined transport path from isolated sub-agent workspace to parent-visible discovery storage, the protocol may fail exactly where it is most needed.
- **Suggested fix**: Move this from Open Questions into the core architecture. Define one canonical behavior:
  - **Option A**: Discoveries are written inside the sub-agent workspace and copied back by the session spawner on completion
  - **Option B**: The spawner mounts or injects a shared discovery path
  - **Option C**: Discovery file is returned as an artifact in the sub-agent result envelope and materialized by the parent/spawner

  Also specify behavior on copy-back failure.
- **Section reference**: Design Principles #1; Open Questions #3; Sub-Agent Prompt Integration; Implementation Plan Step 5

---

### Issue 4: Discovery lifecycle/status model is incomplete
- **What**: The spec defines initial `status: pending` and final statuses `applied`, `proposed`, `dismissed`, but does not define the full state machine, required metadata on transitions, or whether processed files retain full audit history.
- **Why it matters**: Without a formal lifecycle, implementations will diverge. For example: what fields must be added on dismissal? Where is proposal ID stored? Is `deferred` a proposal status or discovery status? Can a dismissed discovery later be reopened? What happens if evolution proposal filing fails after status update?
- **Suggested fix**: Define a minimal state model and transition schema, e.g.:
  - `pending` → `applied | proposed | dismissed | triage-failed`
  - Add `disposition` object with `processedAt`, `processedBy`, `reason`, `proposalId`, `commitRef`
  - Clarify that "deferred" belongs to the proposal system, not discovery status
  - Require processed files to remain immutable except for disposition metadata
- **Section reference**: Phase 2: Triage; Phase 4: Evolution System Integration

---

### Issue 5: No schema versioning or compatibility strategy
- **What**: The spec proposes a JSON schema but the example format has no `schemaVersion` field, and there is no compatibility or migration plan for future changes.
- **Why it matters**: This protocol is likely to evolve. Without versioning, hooks, parent agents, and helper scripts may break when fields change. Since the system is file-based and durable across sessions, backward compatibility matters.
- **Suggested fix**: Add a required top-level `schemaVersion`, e.g. `"schemaVersion": 1`, and define compatibility rules:
  - Readers must ignore unknown fields
  - Required fields per version
  - Migration behavior for old discovery files
- **Section reference**: Phase 1: Capture; Implementation Plan Step 1

---

### Issue 6: Parent obligation is strong, but enforcement/recovery is weak
- **What**: The spec says the parent "MUST NOT silently discard discoveries" and every discovery must get a disposition, but there is no enforcement mechanism beyond convention and session-start awareness.
- **Why it matters**: The core value proposition is preventing loss. If the parent crashes, exits early, or forgets triage, the system still depends on best effort. That may be acceptable, but then the spec overstates guarantees.
- **Suggested fix**: Add explicit enforcement/recovery behavior:
  - Session-end or handoff hook warns if pending discoveries exist
  - Triage helper can be run automatically or suggested prominently
  - Recovery context should list pending discovery IDs, not just count
  - Optionally mark stale discoveries and escalate after TTL
- **Section reference**: Phase 2: Triage; Phase 3: Awareness; Success Criteria #2; Open Questions #2

---

### Issue 7: Security/privacy implications of storing diffs are unaddressed
- **What**: `artifacts.diff` may contain sensitive code, secrets, credentials, or proprietary implementation details. The spec says discoveries are local-only state, but local state can still be exfiltrated, logged, synced, or accidentally committed.
- **Why it matters**: This is especially relevant if the evolution system or hooks surface discovery content broadly, or if the directory is copied across machines. Sensitive diffs in JSON files are a common leakage path.
- **Suggested fix**: Add a security section with at least:
  - Discoveries must not include secrets or credentials
  - Prefer file references over full diff unless needed
  - Redaction guidance
  - Access expectations for `.instar/state`
  - Whether discovery files are ever transmitted to APIs
- **Section reference**: Phase 1 artifacts; Phase 4 integration; Open Questions #1

---

## 3. Strengths

### Clear articulation of the problem
The **Problem** section is excellent. It identifies the forced-choice failure mode crisply and uses a compelling real-world example. This grounds the spec in observed behavior rather than hypothetical elegance.

### Strong design principle: separate capture from evaluation
This is the best architectural decision in the doc. The distinction in **Design Principles #3** and the phased architecture avoids overloading sub-agents with prioritization authority while still preserving signal.

### Right choice of lowest-common-denominator transport
The **file-based, not API-based** principle is practical and robust. It fits heterogeneous execution contexts and avoids introducing network/API dependencies into sub-agent environments.

### Good use of existing systems
The integration with the **evolution proposal system**, **session-start hook**, and **compaction recovery** is thoughtful. Rather than creating a parallel backlog mechanism, the spec routes durable discoveries into existing review machinery.

### Mandatory disposition is a strong behavioral control
The "**must not silently discard discoveries**" rule in **Phase 2** is the most important policy in the document. It directly addresses the failure mode and creates accountability.

### The schema is mostly well designed
The sample JSON is meaningful and captures useful dimensions:
- source context
- rationale
- artifacts
- readiness
- self-assessment

In particular, `discovery.rationale` as the "how I noticed this" story is a strong inclusion; it helps the parent evaluate whether the finding is grounded or speculative.

### Implementation plan is small and realistic
The plan is incremental, bounded, and plausibly completable in a few hours. That makes the proposal adoptable.

---

## 4. Gaps & Missing Elements

### 1) No explicit error-handling model
Missing cases:
- invalid JSON
- schema validation failure
- duplicate IDs
- failed move to `processed/`
- failed evolution API submission
- parent reads discovery while sub-agent is still writing
- hook output truncation if many discoveries exist

This should be a dedicated section.

### 2) No retention/audit policy
The doc says processed discoveries are moved to `processed/`, but not:
- how long they are retained
- whether they are append-only
- whether they can be deleted
- whether `processed/` is ever compacted
- whether dismissed items remain visible for audit

If the point is durability and prevention of loss, retention policy matters.

### 3) No canonical schema for disposition metadata
The doc says "include proposal ID" and "dismissed with reason," but does not define where those live in the JSON. This should not be left to implementers.

### 4) No migration/upgrade strategy for existing installations
The implementation plan mentions updating templates and migrators, but not:
- what happens to existing sessions
- whether old agents without prompt injection can still participate
- whether hooks should tolerate absent directories indefinitely
- rollback if the protocol causes noise

A migration section would help.

### 5) No performance or volume management
At low scale, listing `*.json` is fine. At higher scale, session-start hook output and repeated scans can become noisy or slow, especially if `processed/` grows large or pending files accumulate. There is no cap, paging, or summarization strategy beyond count and titles.

### 6) No explicit ownership model
Who is the "parent" when:
- multiple parent agents exist
- a task is handed off
- a session ends before triage
- discoveries are found in a branch unrelated to current work

The protocol assumes a single parent responsible for triage, but that assumption should be explicit.

### 7) No guidance on when a discovery is "out of scope"
The prompt says "valuable improvements that are OUTSIDE your assigned task scope," but this is subjective. Without examples or heuristics, sub-agents may either under-capture or flood the system.

### 8) Missing anti-spam controls
There is no rate limiting or thresholding. A verbose sub-agent could emit many low-value discoveries, creating triage burden and reducing trust in the protocol.

### 9) Missing test plan / acceptance criteria by component
The success criteria are product-level, but there is no validation plan:
- schema validation tests
- concurrent write tests
- worktree copy-back tests
- hook display tests
- end-to-end triage tests

### 10) Missing rollback/failure containment
If prompt injection causes sub-agents to stop making useful incidental fixes and instead generate excessive discovery files, what is the rollback path? The spec should include a feature flag or configuration gate.

---

## 5. Industry Comparison

### Compared to existing solutions in the same space
This resembles a lightweight hybrid of:
- issue capture / backlog intake
- code review "follow-up task" workflows
- agent memory / scratchpad artifacts
- dead-letter queues for deferred work

In traditional engineering teams, adjacent discoveries are often captured via:
- TODO comments
- issue trackers
- PR comments
- follow-up tickets
- ADRs or design notes

This spec improves on those in one key way: it captures the discovery **at the point of encounter by the sub-agent**, before context is lost. That is a real advantage over relying on parent recall or manual issue filing later.

### Compared to industry best practices
Best practices generally favor:
- durable capture
- explicit ownership
- structured metadata
- workflow integration
- auditability

This spec aligns well with all of those except ownership and lifecycle rigor, which are underdefined.

The strongest best-practice alignment is:
- **append durable state**
- **separate producer from evaluator**
- **force explicit disposition**
- **integrate with existing prioritization systems**

### Known patterns it matches
- **Inbox/triage model**: discoveries are captured quickly, evaluated later
- **Outbox pattern**: sub-agent writes a durable file for later processing
- **Human-in-the-loop AI workflow**: AI proposes, parent/human evaluates
- **Event sourcing lite**: each discovery is a durable event-like record

### Anti-patterns it avoids
- Forcing sub-agents to make autonomous scope expansions
- Hiding discoveries only in ephemeral chat text
- Polluting the primary diff with unrelated changes
- Building a heavyweight service dependency for a local workflow problem

### Anti-patterns it risks
- **Filesystem queue without queue semantics**: once multiple writers/readers exist, ad hoc file protocols can become unreliable unless atomicity and locking are defined
- **Metadata theater**: too many fields without clear downstream use can reduce compliance
- **Triage debt accumulation**: if discovery creation is easy but triage is manual, backlog can become noise

Overall, the approach is directionally strong and more practical than many overengineered agent-memory designs, but it needs more rigor to behave like a reliable queue rather than a loose convention.

---

## 6. Scalability Assessment

### Phase 1 (MVP, 10-50 users): Will it work?
Yes, mostly. At this scale, a file-based discovery inbox is entirely reasonable. Manual parent triage, session-start awareness, and evolution proposal routing are all viable. The main risks are implementation sloppiness:
- malformed files
- forgotten triage
- worktree copy-back gaps

If those are addressed, MVP should work well.

### Phase 2 (Growth, 50-500 users): What breaks?
Several things start to strain:

1. **Manual triage burden**
   - More sub-agents means more discoveries
   - Parent agents may dismiss quickly or ignore pending items
   - Signal-to-noise becomes a problem

2. **Filesystem semantics**
   - More concurrent writers/readers
   - More need for locking, atomic moves, and idempotency

3. **Session-start noise**
   - Listing titles for many pending discoveries becomes noisy
   - Recovery context may become cluttered

4. **Lack of ownership**
   - Pending discoveries may outlive the parent session
   - Responsibility becomes ambiguous

At this phase, the protocol still works, but only if triage tooling and retention rules improve.

### Phase 3 (Scale, 500-5000 users): Architecture changes needed?
Yes. At this scale, pure filesystem convention becomes limiting unless usage is highly local and isolated per repo/session.

Likely needed changes:
- a proper indexed discovery store or event log
- ownership/assignee tracking
- deduplication
- priority scoring
- stale discovery handling
- richer triage UI/API
- analytics on capture-to-apply rates
- cross-session and cross-machine synchronization

The file format can remain the edge-capture mechanism, but the system likely needs an ingestion/indexing layer.

### Spike handling: What happens under sudden load?
Under a burst of sub-agent activity:
- many discovery files may appear at once
- parent triage becomes a bottleneck
- session-start output may become unusable
- duplicate or overlapping discoveries may proliferate
- evolution proposal API could be spammed if "proposed" is overused

To handle spikes, the system would need:
- dedupe heuristics
- batching/summarization
- rate limits or thresholds
- a "bulk defer" workflow
- maybe automatic grouping by file/path/category

As written, the protocol degrades gracefully only at low volume.

---

## 7. Recommendations (Prioritized)

1. **Specify the filesystem protocol rigorously: atomic writes, unique IDs, locking/processing semantics, and idempotency.**
   This is the highest-impact change because it determines whether the protocol is reliable under real multi-agent conditions.

2. **Resolve worktree/sandbox behavior in the core design, not as an open question.**
   Define exactly how discoveries move from isolated sub-agent environments to the parent-visible state directory, including failure handling.

3. **Add a formal discovery lifecycle and schema versioning.**
   Include `schemaVersion`, explicit disposition metadata (`processedAt`, `reason`, `proposalId`, `commitRef`), and a clear state machine.

4. **Add an operational section covering error handling, retention, stale discovery policy, and enforcement/recovery.**
   The spec's promise is "no silent loss"; that requires more than a directory and a convention.

5. **Tighten scope and anti-noise guidance for sub-agents and triagers.**
   Add heuristics/examples for what qualifies as a discovery, when to include diffs vs references, and how to avoid flooding the system with low-value items.

---

## Subagent Analysis

Brief notes on the quality and specificity of the model's response:
- **Was the review substantive?** Yes, highly substantive. GPT 5.4 identified 7 critical issues with concrete fixes, 10 gaps, and 5 prioritized recommendations. The review demonstrates deep engagement with the spec's internal logic, not just surface-level commentary.
- **Any notable gaps in the model's analysis?** The scalability section applies a user-count framing (10-50, 50-500, 500-5000 users) that does not quite fit the domain -- this is an agent-internal protocol, not a user-facing service. The scaling dimension is really sub-agent invocations per session, not users. The security section (Issue 7) is valid but somewhat generic. The model did not deeply explore the token budget constraint (success criterion #4) or whether the proposed sub-agent prompt injection is realistic within that budget.
- **Unique insights this model provided?** The "zero overhead vs pre-created directories" contradiction (Issue 1) is a sharp observation that catches a real inconsistency between principles and implementation. The "metadata theater" anti-pattern warning is valuable -- too many required fields could reduce sub-agent compliance. The distinction between "filesystem queue without queue semantics" as a risk pattern is well articulated and actionable.
