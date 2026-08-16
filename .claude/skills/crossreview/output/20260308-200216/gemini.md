# Gemini 3.1 Pro Review: discovery-protocol.md

**Model**: gemini-3.1-pro-preview
**Date**: 2026-03-08
**Focus**: full document

---

## Raw Model Response

### 1. Overall Assessment
- **Score**: 8/10
- **Status**: CONDITIONAL
- **Summary**: This is a highly pragmatic, well-reasoned specification that elegantly solves a common multi-agent coordination problem (scope creep vs. context loss). The decision to use a decoupled, file-based architecture respects the constraints of agentic environments and UNIX philosophies. However, approval is conditional upon resolving the worktree isolation issue (which currently threatens to break the core mechanism) and addressing the fragility of having LLMs write multi-line code diffs inside JSON string values.

### 2. Critical Issues (Must Fix)

**Issue 1: Worktree/Sandbox Isolation Data Loss**
- **What**: Sub-agents running in isolated worktrees write discoveries to their local `.instar/state/discoveries/` directory, which is destroyed when the worktree is cleaned up.
- **Why it matters**: This results in silent data loss, completely defeating the purpose of the protocol. The spec acknowledges this in "Open Questions" but leaves it unresolved.
- **Suggested fix**: Update the worktree teardown lifecycle hook. Before a worktree is deleted, copy any files in `.instar/state/discoveries/` back to the parent's main repository state.
- **Section reference**: Open Questions (#3), Phase 1: Capture

**Issue 2: LLM JSON Formatting for Code Diffs**
- **What**: The schema requires the sub-agent to put code changes into `artifacts.diff` as a JSON string.
- **Why it matters**: LLMs notoriously struggle with escaping multi-line strings, quotes, and special characters inside JSON. Forcing a patch/diff into a JSON string will frequently result in malformed JSON, causing the parent's parser to crash and the discovery to be lost.
- **Suggested fix**: Separate metadata from payload. Have the agent write `disc-<uuid>.json` for metadata and, if there is code, `disc-<uuid>.patch` for the diff. Update the schema to reference the patch file rather than containing the string.
- **Section reference**: Phase 1: Capture (File format)

**Issue 3: Unhandled Malformed Discoveries**
- **What**: Phase 2 assumes `ls *.json` yields perfectly formatted, valid JSON files.
- **Why it matters**: If a sub-agent writes invalid JSON (or gets interrupted mid-write), the parent agent's triage process will throw parsing errors, potentially halting the parent agent or creating an infinite loop of failing to process a bad file.
- **Suggested fix**: Add explicit error handling in Phase 2. If a file fails JSON schema validation, automatically move it to an `.instar/state/discoveries/invalid/` directory with an error log attached, rather than failing the triage run.
- **Section reference**: Phase 2: Triage

### 3. Strengths
- **Decoupled Architecture**: Principle #3 (Separate capture from evaluation) is excellent. It prevents sub-agents from context-switching into evaluators and keeps their token usage focused.
- **Zero-Overhead Baseline**: Principle #4 ensures this feature doesn't bloat the system when unused. Relying on filesystem checks (`ls`) rather than running daemons or servers is highly appropriate for this context.
- **Integration with Existing Systems**: Phase 4 seamlessly maps discoveries into the existing evolution proposal system, avoiding the creation of a redundant lifecycle pipeline.
- **Forced Disposition**: The "Critical rule" in Phase 2 (requiring a specific disposition and reason for dismissal) is a strong design choice that prevents the system from becoming a silent graveyard of ignored ideas.

### 4. Gaps & Missing Elements
- **Garbage Collection**: The `processed/` directory will grow indefinitely. There is no specified mechanism or TTL for cleaning up applied/dismissed files, which will eventually bloat the `.instar` directory.
- **Concurrency/Race Conditions**: What happens if a parent agent begins triaging while a sub-agent is still streaming/writing the JSON file? The parent might read a partial file.
- **Security/Execution Risks**: If a sub-agent writes malicious or hallucinated code into a discovery, and the parent applies it via the automated triage helper, there's a risk of executing unverified code. The spec doesn't explicitly require sandbox-testing of *applied* discoveries.
- **Prompt Token Budget**: The spec claims the prompt adds "<100 tokens", but the JSON schema example alone is roughly 75-90 tokens, not counting the instructions. This needs strict minification in implementation.

### 5. Industry Comparison
- **Existing Solutions**: This closely mirrors the **Dead Letter Queue (DLQ)** pattern in message brokers, adapted for agentic file systems. It also resembles the **Git Stash** workflow, but with added metadata.
- **Best Practices**: Using file-based Inter-Process Communication (IPC) via a shared directory is a battle-tested UNIX pattern (e.g., `maildir`). It is highly robust compared to API-based handshakes for local agents.
- **Anti-patterns**: As mentioned, embedding raw code/diffs inside JSON strings is an industry anti-pattern due to escaping complexities. The standard practice is multipart formatting or sidecar files.

### 6. Scalability Assessment
- **Phase 1 (MVP, 10-50 users)**: Will work exceptionally well, assuming the worktree bug is fixed. The filesystem handles this volume effortlessly.
- **Phase 2 (Growth, 50-500 users)**: The `processed/` directory will accumulate thousands of files. `ls` commands might slow down, and IDEs indexing the `.instar` folder might experience lag. A cleanup job (e.g., deleting processed files older than 7 days) becomes necessary.
- **Phase 3 (Scale, 500-5000 users)**: If agents become distributed (running across different containers/VMs rather than sharing a local filesystem), the file-based approach will break. The architecture would need to pivot to an API-backed queue (e.g., Redis or a dedicated database table).
- **Spike handling**: If a sub-agent gets caught in a loop, it could generate thousands of discovery files in minutes, exhausting inodes or disk space. A hard limit (e.g., max 50 discoveries per session) should be enforced at the writing phase.

### 7. Recommendations (Prioritized)

1. **Fix Worktree Isolation Sync**: Mandate a step in the worktree teardown script that `rsync`s or copies `.instar/state/discoveries/*.json` back to the parent context before the sandbox is destroyed. *(Addresses critical data loss)*
2. **Extract Diffs to Sidecar Files**: Update the schema and prompts to instruct sub-agents to save code diffs as `disc-<uuid>.patch` alongside the JSON file, rather than embedding them inside the `artifacts.diff` JSON string. *(Prevents JSON parsing failures)*
3. **Add Triage Error Handling & Atomic Writes**: Require sub-agents to write to a temporary file (e.g., `disc-<uuid>.tmp`) and rename it to `.json` upon completion to prevent the parent from reading partial files. Add a `catch` block in the parent triage script to move malformed JSONs to an `invalid/` folder. *(Ensures system stability)*
4. **Implement Garbage Collection**: Add a cron or session-end hook that deletes files in the `processed/` directory that are older than 14 days to prevent state bloat. *(Addresses Phase 2 scalability)*
5. **Enforce Rate Limiting/Caps**: Add an instruction to the prompt and a check in the write-logic: "Maximum 5 discoveries per task." This prevents rogue agents from spamming the discovery directory and wasting tokens/disk space. *(Protects against spike failure modes)*

---

## Subagent Analysis

Brief notes on the quality and specificity of the model's response:
- **Was the review substantive?** Yes, highly substantive. Gemini identified three concrete critical issues, each with specific fixes and section references. The review goes beyond surface-level observations and engages deeply with the architecture.
- **Any notable gaps in the model's analysis?** The scalability assessment applies a user-count framing (10-50, 50-500, 500-5000 users) that doesn't quite map to this spec's domain -- this is about agent-internal coordination, not user-facing scale. The "users" here are really sub-agent invocations per session. The security/execution risk point in Gaps is valid but could have been elevated to a critical issue given the autonomous execution context.
- **Unique insights this model provided?** The sidecar file recommendation (Issue 2) is particularly strong -- LLMs struggling with JSON-escaped diffs is a real and underappreciated failure mode. The atomic write pattern (write to .tmp then rename) in Recommendation 3 is a practical engineering detail that shows systems-level thinking. The DLQ and maildir comparisons in the Industry section are apt analogies.
