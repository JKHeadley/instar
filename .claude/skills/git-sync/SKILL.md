---
name: git-sync
description: Intelligent multi-machine git sync with tiered model escalation — haiku for clean syncs, opus subagent for complex merge conflicts
metadata:
  user_invocable: "false"
---

# git-sync — Tiered Model Escalation Sync

## Purpose

Synchronize this machine's state with the remote repository. Uses tiered model selection: the main session (haiku) handles clean syncs and simple merges. Complex conflicts spawn an opus subagent for semantic resolution.

## Pre-flight

1. Read conflict severity from gate:
   ```bash
   SEVERITY=$(cat /tmp/instar-git-sync-severity 2>/dev/null || echo "clean")
   ```
2. Get current state:
   ```bash
   git status --short
   git log --oneline -3
   git fetch origin && git rev-list --left-right --count HEAD...@{u}
   ```

## Sync Strategy

### Only behind (remote has new commits, no local changes)
```bash
git pull --rebase
```
Report what was pulled.

### Only ahead (local changes, nothing new on remote)
```bash
git add -A
```
Compose a brief sync commit message categorizing the changes (state, config, skills, code, etc.):
```bash
git commit -m "sync: auto-commit"
git push
```

### Both sides have changes — TIERED RESOLUTION

First, commit local changes:
```bash
git add -A && git commit -m "sync: local changes"
```

Then attempt rebase:
```bash
git pull --rebase
```

**If no conflicts:** Push and report.

**If conflicts arise**, check severity and resolve based on tier:

#### Tier 1: Clean / State conflicts (handle directly)

For JSON state files (.instar/state/, activity caches, session data, ledgers):
- Take newer timestamps
- Union arrays by ID (no duplicates)
- Take max for counters and offsets
- For `.instar/config.json`: preserve local machine-specific values, take newer shared settings

For simple text conflicts (non-overlapping changes, whitespace):
- Resolve mechanically

After resolving:
```bash
git add . && git rebase --continue
git push
```

#### Tier 2: Complex conflicts (spawn opus subagent)

If SEVERITY is "code" OR if you encounter conflicts in:
- Source code files (.ts, .tsx, .js, .jsx, .py, .rs, .go)
- Identity/memory files (MEMORY.md, AGENT.md, USER.md)
- Skill definitions (.claude/skills/)
- Any conflict where both sides made semantic changes to the same logic

**DO NOT attempt to resolve these yourself.** Instead:

1. Collect the conflict context:
   ```bash
   git diff --name-only --diff-filter=U
   ```
2. For each conflicted file, read the full content including conflict markers
3. Get the merge base version for context:
   ```bash
   git show :1:<filename>   # base
   git show :2:<filename>   # ours
   git show :3:<filename>   # theirs
   ```
4. **Spawn an opus subagent** using the Agent tool with these parameters:
   - `model: "opus"`
   - `description: "Resolve git merge conflicts"`
   - Prompt must include:
     - The base, ours, and theirs versions of each conflicted file
     - A summary of what each side was trying to do (from recent git log)
     - Instructions to output the resolved file content
     - The instruction: "Resolve semantically. Preserve intent from both sides. If the changes are truly incompatible, prefer the local (ours) version but note what was dropped."

5. Apply the opus subagent's resolution:
   ```bash
   # Write resolved content to each file
   git add <resolved-files>
   git rebase --continue
   git push
   ```

6. Report what conflicted, what the opus subagent decided, and why.

### If clean (gate passed but nothing obvious)
Re-check with `git status` and `git fetch`. If truly nothing: exit silently.

## Safety Rules

- **NEVER** force push
- **NEVER** delete branches
- If a rebase goes wrong: `git rebase --abort` and report the issue
- If the opus subagent's resolution looks wrong (e.g., deleted large chunks of code), abort and report rather than pushing a bad merge
- Prefer clean history (rebase) over merge commits when possible

## Reporting

- Nothing happened: exit silently
- Clean sync: brief one-line ("Pulled 3 commits, pushed 2")
- Tier 1 conflicts resolved: describe what conflicted and the mechanical resolution
- Tier 2 conflicts resolved: describe what conflicted, the opus subagent's reasoning, and the resolution
- Unresolvable: report details, leave working tree clean (abort rebase), queue attention item

## Handoff Notes

Write sync results to `.instar/state/job-handoff-git-sync.md`:
- Last sync timestamp
- Any conflicts encountered and how they were resolved
- Any pending issues for next run
