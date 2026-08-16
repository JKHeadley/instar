# Docs-Code Sync Job Specification (v2)

> Keep documentation accurate by detecting code drift and applying targeted updates.

## Problem Statement

Documentation drifts from code silently. API signatures change, features get added or removed, architectural patterns evolve — but the docs that describe them stay frozen at whatever state they were when last manually updated. Nobody notices until someone reads stale instructions and gets confused, wastes time, or makes wrong assumptions.

This is especially acute in instar where:
- The codebase evolves daily (often multiple times per day)
- Documentation spans two locations (instar source docs + agent context docs)
- CLAUDE.md files serve as the primary interface for agents — stale CLAUDE.md means agents make wrong decisions
- There is no human doing regular doc maintenance

## Goals

1. **Detect drift** — Identify documentation that no longer matches the code it describes
2. **Fix drift** — Update stale docs automatically, preserving voice and style
3. **Be efficient** — Only examine what changed; don't burn tokens re-reading unchanged code
4. **Be autonomous** — Commit updates without requiring human approval; report what changed after the fact
5. **Learn over time** — Build a dependency map so future runs get faster

## Non-Goals

- Writing new documentation from scratch (that's a separate concern)
- Checking doc quality, grammar, or style (out of scope)
- Updating CHANGELOG.md (handled by git-sync)
- Rewriting docs that are merely suboptimal but still accurate

## Architecture

### Three-Phase Pipeline

```
Phase 1: Change Detection (programmatic, zero LLM cost)
    ↓
Phase 2: Staleness Triage (Haiku — cheap, fast)
    ↓
Phase 3: Doc Update (Sonnet subagent — only for confirmed-stale docs)
```

This tiered approach follows the LLM-Supervised Execution Standard (Tier 1 for triage, Tier 2 for updates).

### Phase 1: Change Detection

**Input:** Last-checked commit hash from state file
**Output:** List of changed code files grouped by module, with diff summaries

Steps:
1. Read `lastCheckedCommit` from `.instar/state/docs-code-sync.json`
2. Run `git diff --name-only <lastCheckedCommit>..HEAD` in the instar source directory
3. Filter out irrelevant files:
   - Test files (`*.test.ts`, `*.spec.ts`, `__tests__/`)
   - Generated files (`builtin-manifest.json`, `package-lock.json`)
   - Non-code assets (images, fonts)
   - Environment/secret files (`.env*`, `*.pem`, `*.key`, `*credentials*`)
   - Files in the exclusion list (configurable)
4. Group remaining files by module (top-level directory under `src/`)
5. For each changed file, extract a concise diff summary (function signatures changed, exports added/removed, types modified)

**First-run bootstrap:** If the state file doesn't exist or `lastCheckedCommit` is missing, set `lastCheckedCommit` to current HEAD and exit cleanly. The next scheduled run will handle actual changes. This prevents unbounded diff-from-epoch on first deploy.

**Cost:** Zero tokens. Pure git operations.

### Phase 2: Staleness Triage

**Input:** Changed modules + diff summaries from Phase 1
**Output:** List of (doc-section, reason) pairs flagged as stale

This phase has two sub-steps:

#### 2a. Doc Discovery

For each changed module, find potentially-affected docs using the dependency map:

1. **Cached lookup** — Check `docCodeMap` in state file for known doc→code relationships
2. **Grep fallback** — For unmapped modules, grep all doc files for:
   - File paths matching the changed files (e.g., `src/scheduler/JobScheduler.ts`)
   - Module names (e.g., `JobScheduler`, `scheduler`)
   - Exported function/class names from the changed files
   - API endpoint paths if the change is in a route handler
3. **Structural docs** — Always check these regardless of what changed:
   - `README.md` (capability list, feature matrix)
   - `CLAUDE.md` (capability index, anti-patterns)
   - Agent's `.instar/context/architecture.md`

**Discovery cap:** Maximum 50 (doc-section, change) pairs per run, prioritized by match precision: exact path > exported symbol > module name > structural docs. Excess pairs are queued to handoff notes for the next run.

Update the `docCodeMap` with any new relationships discovered via grep.

#### 2b. Staleness Assessment

For each (doc-section, code-change) pair, batch by doc file and send to Haiku:

```
You are checking if documentation is still accurate after a code change.

CODE CHANGE:
File: {filePath}
Diff summary: {diffSummary}
Full diff (if small): {diff}

DOCUMENTATION SECTION:
Source: {docPath}:{lineRange}
Content: {sectionContent}

Is this documentation section still accurate given the code change?
Answer exactly one of:
- ACCURATE: {one-line reason}
- STALE: {what specifically is wrong and what the doc should say instead}
- UNCERTAIN: {what you'd need to check to be sure}
```

**Batching:** Group all (doc-section, change) pairs for the same doc file into a single Haiku call. This minimizes calls while keeping context coherent.

**UNCERTAIN handling:** UNCERTAIN results go to a persistent queue in the state file. Items unresolved after 3 consecutive runs trigger a Telegram attention queue alert. Items older than 14 days are auto-promoted to STALE for a forced update attempt.

**Cost:** ~2-5k tokens per doc section assessed. Typically 10-30 sections per run = 20-150k tokens of Haiku. ~$0.02-0.15 per run.

### Phase 3: Doc Update

**Input:** Stale doc sections from Phase 2
**Output:** Updated documentation files with clear commit messages

Process stale docs **sequentially** (not in parallel) to avoid rate limits and partial-commit states. Maximum **5 doc updates per run** — excess queued to handoff notes for next run.

For each stale section, spawn a Sonnet subagent with:

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
```

After the update:
1. Apply the edit to the doc file
2. Run a quick sanity check: does the updated section still make sense in context?
3. Stage and commit the change

**Commit strategy:** One commit per doc file updated, with a message like:
```
docs: update {filename} — {brief reason}

Detected code drift in {module}:
- {change1}
- {change2}

Updated sections: {list}

Auto-updated-by: docs-code-sync
```

**Cost:** ~50-100k tokens per doc update (Sonnet at $3/M input, $15/M output). Typically 0-5 docs per run. Realistic cost per update: ~$0.50-1.50.

## Doc Scope

### Primary (checked every run)

| Location | Path | What |
|----------|------|------|
| Instar source docs | `/Users/justin/Documents/Projects/instar/docs/*.md` | Feature docs, standards, guides |
| Instar root docs | `/Users/justin/Documents/Projects/instar/README.md` | Project overview, feature matrix |
| Instar CLAUDE.md | `/Users/justin/Documents/Projects/instar/CLAUDE.md` | Agent-facing capability docs |
| Echo context | `.instar/context/architecture.md` | Architecture reference |
| Echo context | `.instar/context/development.md` | Dev patterns |
| Echo CLAUDE.md | `./CLAUDE.md` | Capability index, job conventions |

### Secondary (checked only when relevant modules change)

| Location | Trigger |
|----------|---------|
| `docs/specs/*.md` | Changes to the module the spec describes |
| `docs/design/*.md` | Changes to the module the design doc covers |
| `.instar/context/communication.md` | Changes to messaging or notification code |
| `.instar/context/safety.md` | Changes to safety/gate/coherence code |

### Excluded

| Location | Reason |
|----------|--------|
| `CHANGELOG.md` | Maintained by git-sync / release process |
| `CODE_OF_CONDUCT.md` | Static, not code-related |
| `CONTRIBUTING.md` | Process doc, rarely drifts from code |
| `SECURITY.md` | Policy doc, not code-derived |
| `docs/CRUCIBLE-REPORT-*.md` | Historical snapshots, not living docs |
| `docs/dawn-audit-report.md` | Historical snapshot |
| `docs/research/` | Research notes, not code docs |
| `docs/positioning-*.md` | Marketing, not code docs |
| Spec review output | `specs/reviews/`, `.claude/skills/*/output/` |
| `.env*`, `*.pem`, `*.key` | Secrets — excluded from Phase 1 |

## State Management

### State File: `.instar/state/docs-code-sync.json`

```json
{
  "schemaVersion": 1,
  "lastCheckedCommit": "abc123def456",
  "lastRunAt": "2026-03-28T18:00:00Z",
  "docCodeMap": {
    "docs/THREADLINE.md": {
      "codeRefs": ["src/threadline/", "src/messaging/threadline/"],
      "lastVerified": "2026-03-28T18:00:00Z"
    },
    "docs/LLM-SUPERVISED-EXECUTION.md": {
      "codeRefs": ["src/scheduler/", "src/core/types.ts"],
      "lastVerified": "2026-03-28T18:00:00Z"
    }
  },
  "uncertainQueue": [
    {
      "docPath": "docs/THREADLINE.md",
      "section": "Relay Connection",
      "reason": "Haiku unsure if retry logic change affects documented timeout values",
      "firstSeen": "2026-03-28T18:00:00Z",
      "runsSeen": 1
    }
  ],
  "runHistory": [],
  "knownUndocumented": []
}
```

**docCodeMap TTL:** Entries with `lastVerified` older than 30 days fall back to grep-based discovery rather than being trusted blindly. This handles renamed/deleted modules gracefully.

**runHistory cap:** Keep the last 50 entries. Older entries are dropped on write.

**knownUndocumented dedup:** Keyed by module path. Duplicate detections update `detectedAt` rather than adding new entries.

### Handoff Notes: `.instar/state/job-handoff-docs-code-sync.md`

Written after each run so the next run has context:
- What was checked and what was updated
- Any UNCERTAIN results and their queue status
- Newly discovered undocumented modules
- Any errors or skipped files
- Overflow items (excess pairs or updates queued for next run)

## Job Definition

```json
{
  "slug": "docs-code-sync",
  "name": "Docs-Code Sync",
  "description": "Detect documentation drift from code changes and apply targeted updates",
  "schedule": "0 */4 * * *",
  "priority": "medium",
  "expectedDurationMinutes": 15,
  "model": "sonnet",
  "enabled": true,
  "supervision": "tier2",
  "execute": {
    "type": "skill",
    "value": "docs-code-sync"
  },
  "gate": ".instar/scripts/docs-code-sync-gate.sh",
  "tags": ["cat:maintenance", "role:worker", "exec:skill"],
  "topicId": null,
  "telegramNotify": "on-alert",
  "grounding": {
    "requiresIdentity": true,
    "contextFiles": [".instar/context/development.md"]
  },
  "machines": null
}
```

### Gate Script: `.instar/scripts/docs-code-sync-gate.sh`

```bash
#!/usr/bin/env bash
# Exit 0 (run job) if there are new commits since last check
# Exit 1 (skip job) if no changes

INSTAR_DIR="${INSTAR_DIR:-$(dirname "$0")/..}"
STATE_FILE="$INSTAR_DIR/state/docs-code-sync.json"
INSTAR_SOURCE="/Users/justin/Documents/Projects/instar"

# First run — no state file means always run (will bootstrap)
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

LAST_COMMIT=$(python3 -c "import json,sys; print(json.load(open('$STATE_FILE')).get('lastCheckedCommit',''))" 2>/dev/null)

# Empty or unreadable — always run
if [ -z "$LAST_COMMIT" ]; then
  exit 0
fi

CURRENT_HEAD=$(cd "$INSTAR_SOURCE" && git rev-parse HEAD 2>/dev/null)

if [ "$LAST_COMMIT" = "$CURRENT_HEAD" ]; then
  exit 1  # No changes, skip
fi

exit 0  # Changes found, run
```

## Autonomy Model

This job is fully autonomous. It commits updates without human approval and reports what it did after the fact.

**Post-run Telegram report:** Every run that makes changes sends a summary:
- Which docs were updated and why
- The diff of each change (abbreviated if large)
- Any UNCERTAIN items escalated
- Any new undocumented modules detected

**Revert path:** If an update is wrong, tell Echo and it reverts the commit. All auto-commits are tagged with `Auto-updated-by: docs-code-sync` for easy identification.

**No approval gates.** The job runs, commits, and reports. The human reviews the report asynchronously and intervenes only if something is wrong. This is the correct loop for a single-operator system.

## Edge Cases

### New code with no matching docs
- Log to `knownUndocumented` in state file (deduped by module path)
- If the module is significant (>3 files or exports public API), include in the run report as "undocumented new capability"
- Do NOT auto-generate docs — flag in the report

### Deleted code still referenced in docs
- Phase 2 should catch this: the doc references something that no longer exists in the diff
- Phase 3 should remove or update the reference
- If the deleted code was the entire subject of a doc section, remove the section and note it in the commit message

### Renamed or moved files
- Git detects renames (`git diff --find-renames`)
- Update file path references in docs
- Update the `docCodeMap` to point to new paths

### Large refactors (>50 files changed)
- If more than 50 files changed since last run, switch to a broader strategy:
  - Skip per-file analysis
  - Instead, summarize the refactor (read commit messages)
  - Check each doc against the refactor summary
- This prevents a 200-file refactor from triggering 200 individual triage calls

### Conflicting doc updates
- If the doc file was also modified since last run (someone manually updated it), read the current version — don't overwrite manual edits
- If the manual edit already fixed the drift, skip it

### CLAUDE.md template changes
- If `/Users/justin/Documents/Projects/instar/src/templates/CLAUDE.md` changed, this may affect echo's CLAUDE.md
- Echo's CLAUDE.md has agent-specific content — update only the sections that match the template change, preserve agent-specific content

### First run / state loss recovery
- If state file is missing: set `lastCheckedCommit` to HEAD, write initial state, exit
- Next scheduled run handles actual changes
- This prevents unbounded diff-from-epoch

## Reporting

### Normal run (no staleness found)
```
docs-code-sync: 14 commits since last check. Checked 8 docs against changes in scheduler/, messaging/. All docs current. [45k Haiku tokens]
```

### Run with updates
```
docs-code-sync: 14 commits since last check. Found 2 stale docs:

1. docs/THREADLINE.md — Updated relay connection section to reflect new retry logic (src/threadline/RelayClient.ts)
2. CLAUDE.md — Updated capability index: added "Slack Adapter" entry

Committed as 2 separate commits. [45k Haiku + 120k Sonnet tokens, ~$1.20]
```

### Run with alerts
```
docs-code-sync: ALERT — 3 items need attention:
- New undocumented module: src/messaging/whatsapp/ (12 files, exports public API)
- UNCERTAIN item escalated (3 consecutive runs): docs/MULTI_MACHINE_VERIFICATION.md — unclear if syncWithRetry() replacement matches documented behavior
```

## Cost Estimate (at current March 2026 pricing)

| Model | Input/1M tokens | Output/1M tokens |
|-------|----------------|-----------------|
| Haiku 4.5 | $1.00 | $5.00 |
| Sonnet 4.6 | $3.00 | $15.00 |

| Scenario | Haiku tokens | Sonnet tokens | Estimated cost |
|----------|-------------|---------------|----------------|
| No changes (gate skip) | 0 | 0 | $0.00 |
| Small changes, no drift | 20-50k | 0 | ~$0.02-0.05 |
| Small changes, 1-2 docs stale | 30-50k | 50-150k | ~$0.80-1.70 |
| Large refactor, several docs stale | 100-200k | 200-500k | ~$3.00-8.00 |

**Per-run cost cap:** $5.00. If estimated token spend exceeds this, Phase 3 processes only the highest-priority docs and queues the rest.

**Realistic monthly cost:** At 6 runs/day with instar's active development pace, expect $30-90/month. Most runs find nothing (~$0.03). Active sprint days with multiple stale docs: ~$2-5/run.

## Testing Strategy

### Dry-run mode
The skill supports a `dryRun` flag. When true, Phases 1 and 2 execute normally but Phase 3 only reports what it *would* update without actually editing or committing. Use this for the first few runs to validate accuracy.

### Unit-level validation (before first deploy)
1. **Change detection accuracy** — Given a known git diff, does Phase 1 correctly identify and group the changed modules?
2. **Doc discovery coverage** — Given a known module, does Phase 2a find all docs that reference it?
3. **Staleness assessment quality** — Given a known stale doc+change pair, does Haiku correctly flag it?
4. **Update quality** — Given a flagged section, does the Sonnet update preserve style and fix the issue?

### Integration testing
1. Make a deliberate code change that invalidates a doc
2. Run the job
3. Verify it detects the drift, identifies the right doc section, and produces a correct update

### Ongoing validation
- Track false positive rate (flagged as stale but actually fine) in runHistory
- Track cost per run over time — should decrease as `docCodeMap` fills in
- UNCERTAIN escalation rate — if >30% of triage results are UNCERTAIN, Haiku prompts need tuning

## Dependencies

- Git CLI access to instar source repo
- Haiku model for triage (via Claude Code subagent)
- Sonnet model for updates (via Claude Code subagent)
- Read/write access to instar source docs
- Read/write access to echo's context docs and CLAUDE.md

## Resolved Questions (from v1 review)

1. **Auto-commit vs staged review?** → Auto-commit. Full autonomy. Report after the fact.
2. **Should this job also check echo's MEMORY.md?** → No. memory-hygiene handles that.
3. **Docs in other agent directories?** → v1 is echo-only. Generalizable later.
4. **Large refactors trigger immediate run?** → Not for v1. The 4-hour schedule is sufficient.
