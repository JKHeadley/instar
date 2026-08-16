# Scalability Review: Discovery Protocol — Sub-Agent Opportunity Capture

**Review ID:** 20260308-200046
**Reviewer:** Scalability & Infrastructure Specialist
**Spec:** `/Users/justin/.instar/agents/echo/specs/discovery-protocol.md`
**Round:** 1
**Date:** 2026-03-08

---

## Approval Status

**CONDITIONAL APPROVAL** — The design is sound for single-agent, single-machine use at moderate scale. However, there are structural decisions that will cause pain at higher concurrency and over longer time horizons. The fixes are straightforward and should be addressed before or during implementation.

---

## Score: 7/10

Solid architectural thinking. File-based IPC is the right call for this environment. The concerns are about what happens when the system succeeds — when discoveries accumulate, when many sub-agents run concurrently, and when the processed archive grows without bound.

---

## Research Findings

### File-Based IPC Scaling

File-based IPC is well-understood and has clear scaling boundaries. Key findings from research:

- **Directory listing degrades predictably.** On EXT4/APFS, directories with fewer than 10,000 entries perform well. Between 10,000-100,000, performance depends on filesystem internals (HTree for EXT4, B-tree for APFS). Beyond 100,000, metadata operations become the bottleneck — each `ls` or `readdir` call stats every entry. ([IBM zFS performance study](https://www.ibm.com/support/pages/zfs-performance-degradation-number-files-directory-increase), [EXT4 benchmarks](https://www.funwithlinux.net/blog/optimal-number-of-files-per-directory-vs-number-of-directories-for-ext4/))

- **The "small files problem" is real.** Each file open/read/close cycle costs a few milliseconds of overhead. At thousands of files, those milliseconds compound. Querying a day's worth of small JSON files can take hours in extreme cases. ([MinIO small files analysis](https://blog.min.io/challenge-big-data-small-files/))

- **File-based IPC lacks atomicity guarantees.** Concurrent writes from multiple sub-agents to the same directory are safe (different files), but a reader scanning the directory while a writer is mid-write can see partial files. This is mitigable with write-then-rename patterns. ([IPC files discussion](https://dev.to/leandronsp/inter-process-communication-files-1m34))

- **Agent memory systems face "death by a thousand files."** JSON file proliferation in agent systems leads to fragmented artifacts, expensive full-folder scans, and eventual need for index/database layers. Teams end up rebuilding database functionality on top of files. ([Oracle Developers: AI Agent Memory Management](https://medium.com/oracledevs/comparing-file-systems-and-databases-for-effective-ai-agent-memory-management-5322ac45f3b6))

- **Best practice threshold:** Keep directories under 25,000 files. Beyond that, subdirectory sharding (e.g., by date or hash prefix) is standard mitigation. ([Billion-files filesystem research](https://arxiv.org/html/2408.01805v1))

### Relevance to This Spec

The discovery protocol operates well within safe thresholds for its intended use case (single agent, moderate sub-agent concurrency). The risk is long-term accumulation in the `processed/` directory and potential for bursty concurrent writes during parallel sub-agent execution.

---

## Critical Issues

### 1. Unbounded `processed/` Directory Growth

**Severity: High**

The spec moves triaged discoveries to `.instar/state/discoveries/processed/` but defines no archival, rotation, or cleanup strategy. The 30-day TTL mentioned in Open Questions applies only to *pending* discoveries. Processed discoveries accumulate forever.

**At scale:**
- 10 discoveries/day (moderate sub-agent activity) = 3,650 files/year
- 50 discoveries/day (heavy parallelism) = 18,250 files/year
- After 2-3 years of heavy use: 50,000+ small JSON files in one directory

This crosses the performance degradation threshold for directory listing. The session-start hook's `ls .instar/state/discoveries/*.json` won't be affected (it only checks the pending directory), but any audit, search, or backup operation touching `processed/` will slow down.

**Recommendation:** Define a rotation policy. Either:
- Archive processed discoveries older than 90 days into monthly JSONL rollup files (e.g., `processed/archive/2026-03.jsonl`)
- Delete processed discoveries older than 90 days (they've already been routed to evolution proposals)
- Shard `processed/` by month: `processed/2026-03/disc-xxx.json`

### 2. No Atomic Write Guarantee for Discovery Files

**Severity: Medium**

The spec says sub-agents write discovery JSON files directly. If the parent agent's triage scan (`ls *.json`) runs while a sub-agent is mid-write, the parent could read a partial/corrupt JSON file. This is unlikely but not impossible, especially with parallel sub-agents.

**Recommendation:** Use write-then-rename:
1. Sub-agent writes to `.instar/state/discoveries/.disc-<id>.json.tmp`
2. Sub-agent renames to `.instar/state/discoveries/disc-<id>.json`

Rename is atomic on all POSIX filesystems. The parent's glob pattern (`*.json`) will never match the `.tmp` file. This is a one-line change in the protocol spec and eliminates the race entirely.

---

## Recommendations

### R1. Add File Size Bounds to the Schema

The `artifacts.diff` field has no size limit. A sub-agent that captures a large refactoring discovery could write a multi-megabyte diff into a single JSON file. This creates:
- Slow JSON parsing during triage
- Bloated `processed/` archive
- Memory pressure if multiple large discoveries are loaded simultaneously

**Suggestion:** Cap `artifacts.diff` at 10KB. For larger diffs, store the diff in a separate file and reference it: `"artifacts.diffFile": "disc-<id>.diff"`. Or simply omit the diff and let the evolution proposal system regenerate it.

### R2. Add a Discovery Counter / Index File

Rather than scanning the directory on every session start, maintain a lightweight index:

```json
// .instar/state/discoveries/index.json
{ "pending": 2, "lastUpdated": "2026-03-08T22:15:00Z" }
```

Sub-agents increment `pending` when writing. Parent decrements when triaging. The session-start hook reads one small file instead of scanning a directory. This is premature optimization today, but trivial to add now and saves a filesystem operation pattern that won't scale.

### R3. Worktree Isolation Needs a Concrete Answer

Open Question #3 (worktree access to `.instar/state/`) is not just a future enhancement — it's a blocker for any agent that uses worktrees today. If sub-agents in worktrees can't write to the discovery directory, the protocol silently fails for a significant use case.

**Concrete proposal:** After worktree task completion, the parent agent copies any `.instar/state/discoveries/*.json` files from the worktree back to the main tree. This is a 3-line shell script in the worktree teardown path. Document it in Phase 1, not "future work."

### R4. Define Concurrency Bounds

The spec doesn't address what happens when 10+ sub-agents run in parallel, each potentially writing discoveries. This is fine for filesystem correctness (different filenames), but the triage phase could face:
- 50+ pending discoveries after a batch operation
- Parent agent spending significant time triaging instead of doing primary work
- Token budget pressure from reading many discovery files in one session

**Suggestion:** Add a soft cap. If pending discoveries exceed 20, the session-start hook should recommend batch triage rather than individual review. Consider a `/triage-discoveries --batch` mode that summarizes clusters of related discoveries.

### R5. Git Sync Decision Should Be Made Now

Open Question #1 (should discoveries sync via git?) has infrastructure implications. The `.instar/state/` directory is already in the git-sync path based on the existing architecture. If discoveries are explicitly excluded (`.gitignore`), that's a deliberate choice. If they're included by default, the `processed/` growth problem compounds across machines.

**Recommendation:** Pending discoveries should sync (they represent actionable state). Processed discoveries should NOT sync (they're historical records that have already been routed). Add `processed/` to `.gitignore` in Step 1.

---

## Observations

### O1. The Design Correctly Avoids Polling

The "zero overhead when unused" principle is well-applied. No background process watches the directory. The check is event-driven (session start, post-task completion). This is the right pattern for file-based IPC at this scale.

### O2. Schema Is Appropriately Detailed

The discovery schema captures enough context for meaningful triage without being burdensome to produce. The `selfAssessment` fields are particularly good — they give the parent agent a fast filter without reading the full description.

### O3. Token Budget Awareness Is Good

The spec explicitly calls out the <100 token budget for sub-agent prompt injection. This shows awareness of a real constraint. However, the discovery file *format specification* embedded in the prompt (Phase: Sub-Agent Prompt Integration) is approximately 80 tokens, leaving almost no room for the instructional text around it. Consider linking to a schema file rather than inlining the format.

### O4. Evolution System Integration Is Clean

The field mapping from discovery to evolution proposal is straightforward and doesn't introduce new abstractions. This is good — it means discoveries flow into an existing pipeline with known scaling characteristics.

### O5. Missing: Deduplication

Two sub-agents working in adjacent files could independently discover the same improvement. The spec has no deduplication mechanism. At low volume this is fine (the parent catches it during triage). At higher volume with batch triage, near-duplicates could waste evaluation cycles.

---

## Scalability Assessment (Phase by Phase)

### Phase 1: Capture — Low Risk

**At 10x (10 sub-agents/day):** No issues. 10 JSON files/day is trivial for any filesystem.

**At 100x (100 sub-agents/day):** Still fine for the pending directory (files are triaged and moved). The `processed/` directory accumulates ~100 files/day = 36,500/year. This approaches the caution threshold within a year.

**At 1000x (1000 sub-agents/day):** The pending directory could have burst peaks of 50-100 files if triage doesn't keep pace. The `processed/` directory hits 365,000 files/year — well past the performance cliff. Archival strategy is mandatory at this scale.

**Concurrent write safety:** Multiple sub-agents writing different files to the same directory is safe. The UUID-based naming prevents collisions. The only risk is partial reads (addressed in Critical Issue #2).

### Phase 2: Triage — Medium Risk

**At 10x:** Parent reads 1-5 discoveries per triage cycle. Negligible overhead.

**At 100x:** Parent reads 10-50 discoveries per triage cycle. Each file is ~1KB of JSON. Total I/O is under 50KB — fast, but the LLM evaluation time per discovery is the real bottleneck. At 2 minutes per discovery evaluation, 50 discoveries = 100 minutes of triage.

**At 1000x:** Triage becomes the dominant workload. The parent agent spends more time evaluating discoveries than doing primary work. Automated pre-filtering (by category, value, readiness) becomes necessary. The current "evaluate each one" model breaks down.

**Recommendation for 100x+:** Add a triage priority queue. Sort by `selfAssessment.value` descending, `readiness` (implementation-complete first). Allow bulk-dismiss of low-value/idea-only discoveries.

### Phase 3: Awareness — Low Risk

**At all scales:** The session-start hook reads a directory listing or an index file. This is O(n) in pending discoveries but bounded by triage frequency. If triage runs regularly, pending count stays low regardless of total throughput.

**Risk:** If triage falls behind (parent agent is busy), pending discoveries accumulate and the session-start message becomes noisy. Cap the display at 10 items with a "and N more" summary.

### Phase 4: Evolution Integration — Low Risk (Inherited)

Discovery-to-proposal routing is a one-time operation per discovery. The evolution system's own scaling characteristics apply from there. No new bottleneck is introduced.

---

## Viral Spike Scenario: What Happens at 1000x Sudden Growth?

Imagine a refactoring sprint where 50 sub-agents are spawned in parallel, each touching different parts of the codebase. Each sub-agent generates 2-3 discoveries.

**Immediate state:** 100-150 pending discovery files appear in `.instar/state/discoveries/` within minutes.

**Triage backlog:** The parent agent's next session-start hook reports "150 pending discoveries." The triage process would take hours of LLM evaluation time.

**Graceful degradation path:**
1. Session-start hook caps display at top 10 by value, shows "and 140 more"
2. `/triage-discoveries --batch` groups by category, presents summaries
3. Bulk-dismiss option for low-value/idea-only clusters
4. Auto-file as evolution proposals after 30-day TTL (already specified)

**What's missing:** There's no backpressure mechanism. Sub-agents will keep writing discoveries regardless of how many are pending. Consider a soft signal: if pending count > 50, sub-agents should raise their threshold for what's worth capturing (only high-value discoveries).

---

## Cost Scaling

| Scale | Files/Day | Storage/Year | Triage Time/Day | Concern Level |
|-------|-----------|-------------|-----------------|---------------|
| Current (1-5 sub-agents) | 1-3 | ~1 MB | Minutes | None |
| 10x (10-50 sub-agents) | 10-30 | ~10 MB | 30-60 min | Low |
| 100x (100-500 sub-agents) | 100-300 | ~100 MB | Hours | Medium — triage becomes bottleneck |
| 1000x (hypothetical burst) | 1000+ | ~1 GB | Impractical manually | High — needs automated triage |

Storage is never the constraint. LLM evaluation time for triage is the true cost scaling factor. Each discovery requires context loading + evaluation, which costs tokens and time. At 100x, the token cost of triage could exceed the token cost of the sub-agent work that generated the discoveries.

---

## Summary

The Discovery Protocol is well-designed for its target scale. The file-based IPC choice is correct given the constraints (worktrees, sandboxes, no guaranteed API access). The main scaling concerns are:

1. **Unbounded processed file accumulation** (fix: archival policy)
2. **No atomic write safety** (fix: write-then-rename)
3. **Triage time scales linearly with discovery count** (fix: batch triage, priority sorting, auto-dismiss)
4. **Worktree isolation is a real gap, not future work** (fix: copy-back in teardown)

None of these are architectural flaws. They're operational details that should be specified in v1 rather than discovered in production.
