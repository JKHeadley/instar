---
name: build
description: Rigorous build process with worktree isolation, structured phases, quality gates, layered testing, observability, and self-improvement. Use for any substantial build task. Structurally enforced via stop hook.
user_invocable: true
---

# /build — Rigorous Build Skill

> Structure > Willpower. The pipeline won't let you skip the parts that matter.
> ALL development happens in an isolated worktree — zero conflict with other work.

**When to use**: Any task that's more than a quick fix. Multiple files, needs tests, or would benefit from a plan.
**When NOT to use**: Single-file edits, config changes, quick lookups.
**Suggest to user when**: They describe a substantial feature, say "build", "implement", "create", or scope a multi-step task.

---

## Step 1: Initialize Build (MANDATORY)

```bash
python3 playbook-scripts/build-state.py init "TASK DESCRIPTION" --size SMALL|STANDARD|LARGE
```

Size determines protection level:
- **SMALL** (light): 3 stop-hook reinforcements, basic observability
- **STANDARD** (medium): 5 reinforcements, full observability + review
- **LARGE** (heavy): 10 reinforcements, full observability + multi-agent review

**Model routing**: Use **Opus** for all coding, testing, architecture, and verification. Haiku only for quick file searches.

---

## Step 2: Create Worktree (MANDATORY)

ALL build work MUST happen in an isolated git worktree. This prevents conflicts with other development:

```bash
python3 playbook-scripts/build-state.py worktree-create
```

This creates:
- A new branch (`build/<task-slug>`) from your current branch
- A worktree at `.instar/worktrees/build-<task-slug>/`
- All subsequent work happens in that directory

**CRITICAL**: After creating the worktree, `cd` into it:
```bash
cd .instar/worktrees/build-<task-slug>/
```

All code changes, tests, and builds happen here. The main working directory is untouched.

---

## Step 3: Register Stop Hook

The stop hook STRUCTURALLY PREVENTS exit until the build completes:

```bash
python3 -c "
import json
with open('.claude/settings.json') as f:
    s = json.load(f)
hooks = s.setdefault('hooks', {}).setdefault('Stop', [])
if not any('build-stop-hook' in str(h) for h in hooks):
    hooks.append({'matcher': '', 'hooks': [{'type': 'command', 'command': 'bash .instar/hooks/instar/build-stop-hook.sh', 'timeout': 10000}]})
    with open('.claude/settings.json', 'w') as f:
        json.dump(s, f, indent=2)
    print('Build stop hook registered')
"
```

---

## The Pipeline

```
Phase 0: CLARIFY (optional)    Score ambiguity, ask questions
Phase 0.5: MUST-HAVES          Goal-backward truths + artifacts + key_links (+ STRIDE on LARGE)
Phase 1: PLAN                  Architecture + test strategy
Phase 2: EXECUTE               Build incrementally with tests + atomic per-task commits
Phase 3: VERIFY                Independent review + real-world testing
Phase 4: HARDEN                Observability + self-improvement
Phase 5: COMPLETE              Merge worktree, deploy, capture learnings + SUMMARY deviations
```

Advance phases with: `python3 playbook-scripts/build-state.py transition <phase> --evidence "reason"`

---

## Phase 0: CLARIFY (skip if task is clear)

Score ambiguity across 5 dimensions (scope 30%, requirements 25%, architecture 20%, success criteria 15%, dependencies 10%).

If weighted score > 0.20: Ask ONE clarifying question targeting the weakest dimension.

---

## Phase 0.5: MUST-HAVES (goal-backward) — cherry-picked from GSD planner

Before planning HOW, state WHAT must be observably true. Goal-backward beats jumping straight to a task list — it surfaces the verification gates and the wiring checks that ad-hoc planning forgets.

Write a `must_haves` block to `.instar/state/build/must-haves.md`:

```markdown
## Truths (observable, from the consumer's perspective)
- "<thing that must be TRUE when this is done — e.g. GET /x returns 200 with real data, not 503>"
- "<another truth — e.g. component Y is constructed AND started in the boot path>"

## Artifacts (what must exist + be substantive + be wired)
- path: src/...    provides: "<what>"    contains: "<grep-able signature>"

## Key links (the WIRED check — grep patterns proving real wiring, not just file existence)
- from: src/server/routes.ts  to: src/server/xRoutes.ts  via: "createXRoutes mounted"  pattern: "createXRoutes"
- from: src/commands/server.ts  to: src/core/X.ts  via: "new X(...) constructed at boot"  pattern: "new X"
```

Each truth becomes a Phase 3 verification gate. Each key_link's grep pattern becomes the WIRED check (run `/verify-claim` against it). This is what prevents shipping a component that compiles + passes unit tests but is never instantiated (the dead-code failure).

### STRIDE threat pass (LARGE builds only; optional for STANDARD)

For LARGE builds, also enumerate threats. Output a small register to `.instar/state/build/threats.md`:

```markdown
| ID | STRIDE category | Threat | Mitigation | Bound test |
|----|-----------------|--------|------------|-----------|
| T-01 | Information disclosure | <e.g. diagnostics endpoint leaks raw user content> | <allowlist filter> | tests/.../x-pii.test.ts |
```

STRIDE = Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege. Most rows for a given build are empty — that's fine; the value is the one or two real threats it surfaces. Each mitigation binds to a specific test (no hand-waving). Skip the table entirely for SMALL builds.

**Quality Gate**: must-haves.md exists before Phase 1. On LARGE, threats.md exists too.

---

## Phase 1: PLAN

1. **Architecture**: Where does this live? What patterns to follow?
2. **Test Strategy** (MANDATORY): Define unit/integration/e2e tests BEFORE writing code
3. **Incremental Steps**: Each step produces working, testable code

Write the plan to `.instar/state/build/plan.md`.

**Quality Gate**: Plan MUST have test strategy. No plan = no execution.

---

## Phase 2: EXECUTE (in worktree)

The core build loop. For EACH step in the plan:

```
Write Code -> Write Tests -> Run Tests -> Fix -> Verify Full Suite
     ^                                      |
     +------------ (if failing) -----------+
```

### Per-step discipline:

1. Write the code (in the worktree)
2. Write tests IMMEDIATELY — unit + integration as appropriate
3. Run tests: `npm test` or equivalent
4. Run FULL test suite to catch regressions
5. Record: `python3 playbook-scripts/build-state.py step-complete N "Description" TESTS PASSING`

### Testing layers (non-negotiable):

| Layer | Tests | When |
|-------|-------|------|
| **Unit** (`tests/unit/`) | Individual functions, edge cases | Every new function |
| **Integration** (`tests/integration/`) | Components together, HTTP pipeline | After each component |
| **E2E** (`tests/e2e/`) | Feature alive in production path | After all components |

**NEVER** move to the next step with failing tests.

Max 3 fix cycles per step before escalation.

### Atomic-commit discipline (cherry-picked from GSD executor)

Commit per-task, not in one mega-commit at the end. A single 3000-line commit is unreviewable; per-task commits give a readable history and a clean revert surface.

- **One commit per plan step** once its tests pass — not one commit for the whole build.
- **Stage specific files by name** — `git add src/x.ts tests/unit/x.test.ts`. NEVER `git add -A` / `git add .` (sweeps in unrelated WIP, secrets, build residue).
- **Commit-message format**: `{type}({scope}): {summary}` — e.g. `feat(topic-intent): add EvidenceEvent projection`. Types: feat / fix / refactor / test / docs / chore.
- **Verify no accidental deletions**: `git diff --diff-filter=D HEAD~1 HEAD` after each commit.
- Track each commit's short SHA for the Phase 5 SUMMARY.

---

## Phase 3: VERIFY

### Verification scaled by size:

**SMALL**: Spawn one Explore agent for fresh-eyes code review.

**STANDARD**: Spawn 3 parallel review agents (correctness, gaps, untested paths).

**LARGE**: Spawn 5+ review agents covering security, architecture, scalability, and correctness.

### For all sizes:

1. **Real-world test**: If runtime, build and test actual endpoints
2. **Regression sweep**: Full test suite (`npm run test:all`), compare counts
3. **Zero-failure gate**: Must pass the Zero-Failure Standard

If verification fails: transition to fixing, max 3 cycles.

---

## Phase 4: HARDEN

### Scaled by size:

**SMALL**: Error handling + basic logging
- [ ] Errors surface (not swallowed)
- [ ] Basic logging for debugging

**STANDARD**: Above + health check + structured logs
- [ ] Health/status endpoint or check
- [ ] Structured logging
- [ ] Can trace what happened on failure

**LARGE**: Above + audit trail + failure patterns + self-improvement
- [ ] Audit log (JSONL) recording significant events
- [ ] Failure pattern detection
- [ ] Effectiveness scoring
- [ ] Queryable audit trail

---

## Phase 5: COMPLETE

1. **Final test run** — Full suite in worktree: `npm run test:all`
2. **Write SUMMARY.md with tracked deviations** (cherry-picked from GSD executor) — before merging, write `.instar/state/build/SUMMARY.md`:

```markdown
## What shipped
- <one line per plan step + its commit SHA>

## Deviations from plan (categorized)
- [Rule 1 - auto-fixed bug] <what + why>
- [Rule 2 - added critical missing functionality] <what + why — e.g. atomic-write, input validation>
- [Rule 3 - auto-fixed blocking issue] <what>
- [Rule 4 - architectural decision deferred/changed] <what + whether it needs user confirmation>

## Must-haves verification (from Phase 0.5)
- <each truth> → VERIFIED / HOLLOW / ORPHANED (run /verify-claim per key_link)

## Deferred (with backing infrastructure, NOT orphan TODOs)
- <item> → tracked via <scheduled job / commit-action / same-branch follow-up>
```

The deviation log is the antidote to "I changed a bunch of stuff during the build and don't remember what diverged from the plan." Empty sections are fine; the discipline is enumerating, not padding.

3. **Merge worktree** — commit any remaining changes with atomic per-file staging (NEVER `git add -A`), then merge back:

```bash
# In worktree: stage specific files, commit with {type}({scope}): {summary}
git add <specific files>
git commit -m "feat(scope): final integration"

# Back in main directory
cd /path/to/project
python3 playbook-scripts/build-state.py worktree-merge
python3 playbook-scripts/build-state.py worktree-cleanup
```

4. **Build & verify** — `npm run build` from main directory, verify zero errors
5. **Capture learnings** — Write to MEMORY.md if significant
6. **Generate report**:

```bash
python3 playbook-scripts/build-state.py report
python3 playbook-scripts/build-state.py complete
```

6. **Remove stop hook**:

```bash
python3 -c "
import json
with open('.claude/settings.json') as f:
    s = json.load(f)
s['hooks']['Stop'] = [h for h in s.get('hooks',{}).get('Stop',[]) if 'build-stop-hook' not in str(h)]
with open('.claude/settings.json', 'w') as f:
    json.dump(s, f, indent=2)
print('Build stop hook removed')
"
```

7. **Upstream if valuable** — If this build created something generalizable:

```bash
curl -s -X POST http://localhost:PORT/feedback \
  -H 'Content-Type: application/json' \
  -d '{"type":"improvement","title":"TITLE","description":"WHAT_WAS_BUILT_AND_WHY"}'
```

---

## Resume After Session Death

```bash
python3 playbook-scripts/build-state.py resume
```

If resumable: load state, re-read plan, `cd` into worktree if it exists, run full test suite, continue.

---

## Worktree Lifecycle

| Command | What it does |
|---------|-------------|
| `worktree-create` | Creates branch + worktree for isolated development |
| `worktree-merge` | Merges build branch back to source |
| `worktree-cleanup` | Removes worktree and optionally deletes branch |
| `status` | Shows worktree info if active |

**Why worktrees?** Multiple builds can run in parallel. Each gets its own branch and directory. No merge conflicts during development. Changes only merge back when the build is verified and complete.

---

## When to Suggest /build

You should proactively suggest `/build` when:
- User says "build", "implement", "create", or describes a multi-file feature
- Task will touch 3+ files
- Task needs tests (most non-trivial tasks do)
- User describes something that would benefit from a plan

**How to suggest**: "This looks like a substantial task. I can use `/build` to work through it with a structured pipeline — planning, testing at every step, independent verification, and worktree isolation so nothing conflicts with your other work. Want me to use that?"

---

## Philosophy

Structure > Willpower. The pipeline won't let you skip testing, verification, or hardening. The worktree won't let you pollute the main branch. The stop hook won't let you quit mid-build. These aren't restrictions — they're how quality becomes automatic.
