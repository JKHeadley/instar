---
title: "Project Scope — Keep Multi-Spec Plans From Falling Off The Radar"
slug: "project-scope"
author: "echo"
review-convergence: false
approved: false
---

# Project Scope

> Multi-spec build plans like the OpenClaw imports (~19 candidate features across 3 rounds) keep falling off the radar after the first few items ship. Today's Initiative Tracker tracks single multi-phase efforts, but has no layer above an initiative — no way to bundle 19 related initiatives into one project with rounds, drift checks, and automatic round advance. This spec adds that layer.

## ELI16 version

Today the agent has a tracker for one feature at a time. It works fine when you're shipping one feature. But when you have nineteen related features that need to ship over weeks — like the OpenClaw imports we just triaged — the tracker can't see the whole list. The first few features get attention, and the rest get forgotten. We've watched this happen twice (OpenClaw first pass forgot 10 of 13, before that PR-hardening Phase B/C/D forgot until a parallel session caught it).

The fix is a small layer on top of the existing tracker:

- A **project** is a named bundle of features.
- Each project has **rounds** — groups of features you ship together in one autonomous session.
- Each feature in a round has a **pipeline stage**: outline written, full spec drafted, spec convergence passed, building, merged.
- A **session-start digest line** keeps every active project visible at the top of every new conversation, so the agent can't forget what's open.
- **Automatic drift checks** before each round catch stale spec premises (the same kind of catch that retired the six-signal-gate spec).
- **Auto-advance between rounds** with a 24-hour observation window, so forward motion is the default and the user has a brake handle.

The user reads project state on the dashboard or in the session-start orientation. The agent uses a thin skill to advance items. No new database, no new ledger format — extends the existing initiatives ledger by one optional field.

## Problem statement

Long-running, multi-spec efforts keep failing the same way:

- **OpenClaw imports (first pass, 2026-05-08)** — 13 candidate items, only 2 shipped before the rest were forgotten. Both authored items had full specs already; the other 11 sat as one-paragraph outlines. No surface kept the outlines visible. The agent moved on once shipping work ended.
- **PR-hardening Phase B/C/D (2026-04-17)** — Phase A shipped, handoff note existed, but no systemic surface said "you owe this a decision." Caught a day later when a parallel session spotted the handoff note.
- **Threadline growth work** — various strands across days, no single view. Repeated rediscovery cost.

The Initiative Tracker (shipped 2026-04-18) addressed one source of this: solo multi-phase efforts get a card on the dashboard. But it has two structural gaps for multi-spec project work:

1. **No project layer.** An initiative is flat — it has phases, but phases are named strings (`off → shadow → on`), not themselves initiatives. You can't bundle 19 initiatives under one parent and progress them in rounds.
2. **No pipeline awareness.** A spec-driven feature progresses through outline → full spec → convergence → build → merge. The tracker's phase string captures none of this — every feature looks the same regardless of how far through the pipeline it is.

The user has to mentally hold the project roster, the rounds, and each feature's pipeline stage. That mental model is exactly what falls off after a few weeks.

## Proposed design

### Concept model

```
Project (new)
├── round[0] = [Initiative A, Initiative B, Initiative C]
├── round[1] = [Initiative D, Initiative E]
└── round[2] = [Initiative F]

Each child Initiative carries:
  - pipelineStage: outline | spec-drafted | spec-converged | building | merged | skipped
  - parentProjectId: <project id>
```

A project is just another row in the existing initiatives ledger, with `kind: "project"` and a list of child initiative IDs grouped into rounds. Children are regular initiative records with one new optional field (`pipelineStage`) and a back-pointer to the parent.

### Phase 1 — what this commit ships

1. **Extend `Initiative` type** in `src/core/InitiativeTracker.ts`:
   - New optional field: `kind?: "task" | "project"` (default `"task"`, no migration needed for existing records)
   - New optional field: `pipelineStage?: "outline" | "spec-drafted" | "spec-converged" | "building" | "merged" | "skipped"`
   - New optional field: `parentProjectId?: string`
   - New optional field: `rounds?: Array<{ name: string; itemIds: string[]; status: "pending" | "in-progress" | "complete" }>` (project-kind only)
   - New optional field: `sourceDocs?: string[]` — links to audit/plan markdown files that birthed this project

2. **New HTTP endpoints** under `/projects` (thin wrapper over `/initiatives`):
   - `GET /projects` — list project-kind initiatives
   - `GET /projects/:id` — fetch one project plus its children (joined)
   - `POST /projects` — create a project from a markdown plan doc (parses frontmatter, seeds child initiatives from the roster table)
   - `POST /projects/:id/advance` — move to next pipeline stage for one item, or advance the entire active round
   - `GET /projects/:id/next` — return what's next: pending drift check, next item to converge, next item to build, next round to start
   - `POST /projects/:id/drift-check` — run a drift check across pending items in the active round

3. **New skill** `.claude/skills/instar-project/`:
   - `/project create <plan-doc>` — register a project from a markdown plan
   - `/project status [id]` — emit current state in chat
   - `/project next [id]` — show next action
   - `/project advance [id] [stage]` — move an item to its next pipeline stage (manual override)
   - `/project drift [id]` — run a drift check now
   - `/project run-round [id] [roundIndex]` — start a round in autonomous mode (delegates to `/autonomous` with computed stop condition)

4. **Drift check primitive** — `src/core/ProjectDriftChecker.ts`:
   - Takes a pending item (initiative with a spec link)
   - Reads the spec markdown
   - Reads the current state of all file paths referenced in the spec
   - Calls a cheap LLM (Haiku-class) with the spec + current code summaries
   - Returns one of `{ "no-drift", "minor-drift", "premise-violated" }` plus a one-paragraph rationale
   - On `premise-violated`, the round runner halts and surfaces the rationale to the user

5. **Round runner** — `src/core/ProjectRoundRunner.ts`:
   - Given a project id + round index, compute the autonomous stop condition: "PRs for itemIds N, M, O all merged to main with CI green"
   - Run drift check across the round's pending items first; halt on `premise-violated`
   - Hand off to `/autonomous` with the computed stop condition
   - On round complete, mark the round `complete`, advance children to `merged`, kick off the 24-hour observation window
   - At end of observation window, auto-start the next round unless paused

6. **Session-start surfacing** — extend `.instar/hooks/instar/session-start.sh`:
   - Query `GET /projects?status=active`
   - For each active project, emit one line: `Project [openclaw-imports]: 3 of 19 done. Next round: pre-compaction flush, cold-start grace, structured errors.`
   - Lines appear in the orientation block; size budget < 200 chars per project

7. **Dashboard tab "Projects"** — extend dashboard:
   - Project cards with round progress bars
   - Drift status indicator per pending item
   - Last-touched + next-action fields
   - Read-only; mutations go through the skill or API

### Out of scope for Phase 1 (follow-ups, tracked in this project's roster)

- **Project-level digest job** — daily Telegram digest of active project state. Reuses existing initiative-digest infrastructure; small follow-up.
- **Cross-project drift** — checking whether two projects have intersecting scope. Needs a separate primitive; deferred.
- **Auto-seeding from PR labels** — detecting that a PR belongs to a project automatically. Phase 2.

### Decision A (Justin agreed): Drift check is automatic

Every round runs its drift check before the round begins. Cheap LLM cost (Haiku-class, ~5 cents per round). The check produces one of three verdicts; `premise-violated` halts the round and surfaces to the user. The alternative — opt-in drift checks — recreates the failure mode this spec is trying to fix (the agent forgets to run them).

### Decision B (Justin agreed): Round auto-advance with 24-hour pause

When a round completes, the project record auto-queues the next round's prep. A 24-hour observation window starts: a digest line goes to Telegram on completion (so Justin sees it), and unless he pushes back during that window, the next round begins. Strong default toward forward motion; the brake handle is one Telegram message away. Per-project override available (`autoAdvance: false`).

## Surface

| File | Change |
|------|--------|
| `src/core/InitiativeTracker.ts` | Add new optional fields. Backward-compatible — existing records have no `kind`, treated as `task`. |
| `src/core/ProjectDriftChecker.ts` | NEW. Reads spec + file paths, calls LLM, returns verdict. |
| `src/core/ProjectRoundRunner.ts` | NEW. Stop-condition computer + round lifecycle manager. |
| `src/server/routes.ts` | Add `/projects/*` route group. |
| `src/commands/server.ts` | Wire ProjectRoundRunner into server lifecycle. |
| `.claude/skills/instar-project/SKILL.md` | NEW skill, slash-command surface. |
| `.instar/hooks/instar/session-start.sh` | Add active-projects digest lines. |
| `dashboard/index.html` | New Projects tab. |
| `tests/unit/InitiativeTracker.project.test.ts` | New tests for project kind. |
| `tests/unit/ProjectDriftChecker.test.ts` | New tests for drift verdicts. |
| `tests/integration/projects-api.test.ts` | New tests for /projects routes. |

## Non-goals

- Not a replacement for the Initiative Tracker. Projects sit *on top of* initiatives; child initiatives are still regular initiatives.
- Not a ticket system. No assignees other than the agent. No priority fields outside round groupings.
- Not multi-user. Single owner per project; single agent per project.
- Not replacing `/build` or `/instar-dev`. The round runner *delegates* to these for per-item builds.
- Not modifying TaskFlow. TaskFlow tracks individual flows; projects track multi-spec rosters. Adjacent but separate.

## Rollback cost

Low. All new fields on `Initiative` are optional — existing records are untouched. `/projects/*` routes are isolated. The skill is opt-in. Rip-out is reverting the new fields, deleting the new files, and removing the routes + dashboard tab. No data migration needed.

## Threat model

- **Drift check false positive halts a healthy round.** Mitigation: rationale is surfaced to the user; user can mark `drift: ignored` and continue. Track false-positive rate; tune the prompt if >10%.
- **Drift check false negative misses real drift.** Mitigation: build phase has its own checks (side-effects review, signal-vs-authority review) that act as second-line defense.
- **Auto-advance starts a round the user didn't intend.** Mitigation: 24-hour observation window + Telegram digest gives explicit notice; per-project `autoAdvance: false` overrides.
- **Project metadata gets out of sync with reality.** Mitigation: pipeline-stage transitions are tied to verifiable artifacts (spec frontmatter, merged PR SHAs). No stage advances without the artifact.
- **Round runner crash mid-round leaves child initiatives in inconsistent state.** Mitigation: TaskFlow already provides crash recovery for the underlying autonomous run. Round-level state lives in the project record (atomic JSON write).
- **Cost runaway from drift checks.** Mitigation: Haiku-class model, ~5 cents per round, capped at one drift check per round (no re-checks unless user requests).

## Migration

No data migration. Existing initiatives become `kind: undefined` which the loader treats as `kind: "task"`. The OpenClaw imports project is created fresh via `POST /projects` from the existing plan doc (`.instar/projects/openclaw-imports.md`). Children are created from the roster table in that doc.

## Success criteria

1. A project can be created from a markdown plan doc; child initiatives are seeded with correct pipeline stages.
2. `GET /projects/:id/next` returns the right next action across all stages (drift-check pending, item to converge, item to build, round to start).
3. Drift check on a stale-premise spec (e.g., the retired six-signal-gate spec) returns `premise-violated`.
4. Drift check on a fresh spec returns `no-drift`.
5. Round runner correctly computes stop condition from round itemIds.
6. Round completes → 24-hour observation window starts → next round auto-starts on window expiry (in test mode, window shortened to seconds).
7. Session-start hook surfaces active projects in the orientation block.
8. Dashboard Projects tab renders correctly with round progress.
9. All new tests green, tsc clean.
10. The OpenClaw imports project, when registered, surfaces correctly at session start and via `/project status`.

## Open questions

- **Drift check model choice.** Haiku-class is the assumption (~5 cents/round). Alternative: use the existing intelligence-provider abstraction with the cheapest configured model per agent. Recommendation: latter — keeps it consistent with other gates.
- **Round runner failure recovery.** If autonomous mode hits its time limit before all PRs merge, does the round mark `in-progress` and resume, or `failed` and require user input? Recommendation: `in-progress` + resume; only `failed` after 3 consecutive resume attempts hit the same blocker.
- **Drift-check input size.** A spec with many file references could blow the model's context window. Recommendation: cap at 5 referenced files; if spec references more, summarize file-by-file in advance.
- **Cross-project drift detection.** Out of scope for Phase 1, but worth design thought: should the OpenClaw project be aware of, say, the PR-hardening project? Probably yes eventually; deferred.

## References

- `OPENCLAW-IMPORTS-INDEX.md` — original Echo-side audit, source for one project
- `INITIATIVE-TRACKER-SPEC.md` — sibling spec; this builds directly on top of it
- `.instar/projects/openclaw-imports.md` — the project plan doc this spec is shaped to handle
- `/autonomous` skill — round runner delegates to this
- `/spec-converge` skill — each child item passes through this
- `/instar-dev` skill — each child item is built through this
