---
name: docs-code-sync
description: Detect documentation drift from code changes and apply targeted updates
metadata:
  user_invocable: "false"
---

# docs-code-sync — Documentation Drift Detection & Auto-Update

## Purpose

Automatically detect when documentation has drifted from the codebase and fix it. Uses a three-phase pipeline: git-diff change detection (free), Haiku staleness triage (cheap), and Sonnet doc updates (only when needed).

## Context

- **Instar source**: `/Users/justin/Documents/Projects/instar/`
- **State file**: `.instar/state/docs-code-sync.json`
- **Handoff notes**: `.instar/state/job-handoff-docs-code-sync.md`
- **Full spec**: `specs/docs-code-sync.md`

## Execution

### Phase 1: Change Detection (zero LLM cost)

1. Read state file from `.instar/state/docs-code-sync.json`

2. **First-run bootstrap**: If the state file doesn't exist or `lastCheckedCommit` is missing:
   - Get current HEAD: `cd /Users/justin/Documents/Projects/instar && git rev-parse HEAD`
   - Write initial state file with `lastCheckedCommit` set to HEAD
   - Write handoff notes: "First run — bootstrapped state. Next run will detect changes."
   - Exit. Do NOT process any diffs on first run.

3. Get changed files since last check:
   ```bash
   cd /Users/justin/Documents/Projects/instar
   git diff --name-only --find-renames <lastCheckedCommit>..HEAD
   ```

4. Filter out irrelevant files. Skip anything matching:
   - `*.test.ts`, `*.spec.ts`, `__tests__/`
   - `builtin-manifest.json`, `package-lock.json`, `*.generated.*`
   - `*.png`, `*.jpg`, `*.gif`, `*.svg`, `*.ico`, `*.woff*`
   - `.env*`, `*.pem`, `*.key`, `*credentials*`

5. If no relevant files changed, update `lastCheckedCommit` to HEAD, write handoff notes ("no relevant changes"), and exit.

6. Group changed files by module (first directory under `src/`). For each changed file, get a concise diff:
   ```bash
   git diff <lastCheckedCommit>..HEAD -- <file> | head -100
   ```

7. **Large refactor check**: If >50 files changed, switch to summary mode:
   - Read commit messages: `git log --oneline <lastCheckedCommit>..HEAD`
   - Use the commit summary instead of per-file diffs for Phase 2

### Phase 2: Staleness Triage (Haiku)

#### 2a. Doc Discovery

For each changed module, find docs that might reference it:

**Check docCodeMap first** — if the module has known doc references with `lastVerified` < 30 days old, use those.

**Grep fallback** — for unmapped or stale-mapped modules:
```bash
# Search in instar docs
cd /Users/justin/Documents/Projects/instar
grep -rl "<module-name>" docs/ README.md CLAUDE.md --include="*.md" 2>/dev/null

# Search in echo context docs
grep -rl "<module-name>" /Users/justin/.instar/agents/echo/.instar/context/ /Users/justin/.instar/agents/echo/CLAUDE.md --include="*.md" 2>/dev/null
```

Also search for specific exported names, file paths, and API endpoints from the changed files.

**Always check structural docs** regardless of module:
- `/Users/justin/Documents/Projects/instar/README.md`
- `/Users/justin/Documents/Projects/instar/CLAUDE.md`
- `.instar/context/architecture.md`

**Cap at 50 pairs per run.** Priority: exact path match > exported symbol > module name > structural docs. Queue overflow to handoff notes.

Update `docCodeMap` with newly discovered relationships.

#### 2b. Staleness Assessment

**Batch by doc file** — all pairs for the same doc go in one Haiku call.

For each batch, use a Haiku subagent (or the cheapest available model) with this prompt:

```
You are checking if documentation is still accurate after code changes.

For each (code change, doc section) pair below, answer exactly one of:
- ACCURATE: {one-line reason}
- STALE: {what's wrong and what the doc should say instead}
- UNCERTAIN: {what you'd need to verify}

CODE CHANGES:
{list of file paths and diff summaries}

DOCUMENTATION SECTIONS:
{list of doc sections with line numbers}
```

**Process UNCERTAIN results:**
- Check the `uncertainQueue` in state file
- If this item was already there, increment `runsSeen`
- If `runsSeen` >= 3, send a Telegram attention queue alert
- If first seen > 14 days ago, auto-promote to STALE
- New UNCERTAIN items get added to the queue

### Phase 3: Doc Update (Sonnet, sequential)

Process stale docs one at a time. Maximum 5 updates per run.

For each stale doc section:

1. Read the full doc file
2. Read the relevant current code (the changed function/class, not the entire file — target the specific export +/- 30 lines of context)
3. Spawn a Sonnet subagent with this prompt:

```
You are updating a documentation section that has drifted from the codebase.

CURRENT DOC:
{fullDocContent}

STALE SECTION (lines {start}-{end}):
{staleSection}

STALENESS REASON:
{reasonFromTriage}

RELEVANT CODE (current):
{relevantCodeExcerpt}

Update ONLY the stale section. Preserve:
- The document's existing voice and style
- Heading structure and formatting
- Any content that is still accurate
- Cross-references to other docs

Do NOT:
- Rewrite sections that aren't stale
- Add new sections or documentation
- Change the document's overall structure
- Add disclaimers like "as of version X"

Output ONLY the updated section text. Nothing else.
```

4. Apply the edit using the Edit tool (match old section text, replace with new)
5. Commit with a clear message:
   ```
   docs: update {filename} — {brief reason}

   Detected code drift in {module}:
   - {change summary}

   Updated sections: {list}

   Auto-updated-by: docs-code-sync
   ```

**Cost cap check**: Before each Sonnet call, estimate token count. If cumulative run cost would exceed $5.00, queue remaining docs to handoff notes and stop.

### Phase 4: Reporting & State Update

1. Update state file:
   - Set `lastCheckedCommit` to current HEAD
   - Set `lastRunAt` to now
   - Update `docCodeMap` with verified relationships
   - Update `uncertainQueue`
   - Append to `runHistory` (cap at 50 entries)
   - Update `knownUndocumented` (deduped by module path)

2. Write handoff notes with:
   - What was checked and what was updated
   - UNCERTAIN items and their queue status
   - New undocumented modules
   - Any overflow items queued for next run
   - Cost summary

3. Send Telegram report if any changes were made or alerts exist:

   **If changes were committed:**
   ```
   docs-code-sync: {N} commits since last check. Updated {M} docs:

   1. {docPath} — {what changed and why}
   2. ...

   Cost: ~${X.XX} [{haiku}k Haiku + {sonnet}k Sonnet]
   ```

   **If alerts only:**
   ```
   docs-code-sync: ALERT
   - {alert details}
   ```

   **If nothing changed**, no Telegram message (silent success).

## Excluded Docs

These are never checked or modified:
- `CHANGELOG.md` — maintained by git-sync
- `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md` — static policy docs
- `docs/CRUCIBLE-REPORT-*.md`, `docs/dawn-audit-report.md` — historical snapshots
- `docs/research/`, `docs/positioning-*.md` — not code docs
- `specs/reviews/`, `.claude/skills/*/output/` — review artifacts

## Dry Run Mode

If invoked with args containing `--dry-run`:
- Execute Phases 1 and 2 normally
- In Phase 3, report what would be updated but do NOT edit or commit
- Still update state file (lastCheckedCommit, docCodeMap) so the next real run doesn't re-process

## Skip Ledger

Use the skip ledger to avoid re-processing:
- Workload ID: `docs-code-sync`
- Item ID: `commit-<SHA>` for each commit range processed
