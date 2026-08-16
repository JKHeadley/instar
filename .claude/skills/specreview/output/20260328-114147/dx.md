# DX / API Design Review — docs-code-sync

**Spec**: `specs/docs-code-sync.md`
**Review ID**: 20260328-114147
**Round**: 1
**Reviewer**: Developer Experience & API Design Specialist
**Date**: 2026-03-28

---

## Approval Status

**APPROVE WITH CONDITIONS**

The spec is fundamentally sound and describes a coherent, well-reasoned system. The three-phase pipeline design is solid, cost modeling is thoughtful, and the edge case handling shows genuine architectural maturity. However, three issues need resolution before this job goes to implementation: the gate expression is brittle and maintenance-unfriendly, the subagent interface is underdocumented, and first-run onboarding has a silent failure mode.

---

## Score: 7.5 / 10

Strong problem statement and pipeline architecture bring this up. The gate complexity and missing first-run experience pull it down.

---

## Research Findings

### How comparable tools handle this problem

**DeepDocs** (the closest commercial analog) watches codebases and docs together and proposes fixes as reviewable branches — not auto-commits. This matches the open question in the spec but the market is leaning toward "propose, don't auto-apply" for exactly the safety reasons the spec identifies.

**Documentation.AI and Mintlify** both offer Git-sync workflows defined in Markdown, not JSON — the configuration itself is human-readable and lives alongside the docs it governs. This is a DX pattern worth noting: config closer to the artifact it controls is easier to reason about.

**Drift detection in infrastructure tools** (DriftHound, Harness IaCM) universally separate detection from remediation into distinct phases with explicit approval gates between them — the same tiered approach this spec uses. This validates the three-phase design.

### Job configuration schema patterns

The AGENTS.md pattern (per Addy Osmani, Skywork, Particula) defines a repo-level playbook with Name, Purpose, Triggers, Permissions, Tools, and Safety Guardrails — very close to what the job JSON captures, but human-readable. The current job definition JSON is machine-first; the spec's prose carries the human-readable narrative separately. That's a reasonable split for instar's architecture.

### Gate expression anti-patterns

Cron job literature is consistent: gate conditions encoded as inline shell are a maintenance trap. Environment variables may not be available in the cron execution context. Partial success looks like success. Single-responsibility is the durable pattern — one condition, one check.

---

## Critical Issues

### 1. The `gate` expression is operationally fragile

**Current:**
```json
"gate": "cd /Users/justin/Documents/Projects/instar && [ \"$(git rev-parse HEAD)\" != \"$(cat /Users/justin/.instar/agents/echo/.instar/state/docs-code-sync.json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get(\"lastCheckedCommit\",\"\"))' 2>/dev/null)\" ]"
```

**Problems:**
- The entire expression is an escaped JSON string — any quote or backslash error silently fails
- It uses absolute hardcoded paths (`/Users/justin/...`) — breaks immediately if the agent moves machines or the user's home directory changes
- Python3 inline JSON parsing in a shell one-liner is fragile (no error handling, depends on python3 being on PATH)
- The cron execution environment may not have `git` or `python3` on PATH without explicit env setup
- If the state file doesn't exist yet (first run), the `2>/dev/null` silently swallows errors — the gate evaluates to true by accident, which is actually the desired behavior but is not documented as intentional

**Recommendation:** The gate should be a named script, not an inline expression:
```json
"gate": ".instar/scripts/docs-code-sync-gate.sh"
```
The script handles environment setup, path resolution via `$INSTAR_DIR`, and has proper error handling with documented exit codes. The spec should define what the gate script does in plain prose. This also makes the job definition readable at a glance.

### 2. First-run experience is undefined

The spec never addresses bootstrapping. When `docs-code-sync.json` doesn't exist:
- What does Phase 1 do? Check all commits? Check last N commits? Check since repo init?
- Does Phase 2 assess the entire doc corpus against the full codebase?
- What is the cost ceiling for a first run? (Could be extreme if repo has years of history.)

A new developer enabling this job has no idea what will happen on first run. The spec needs a documented bootstrap strategy:
- **Option A**: On first run, only check docs against HEAD state (no diff — just assess whether docs match current code)
- **Option B**: On first run, set `lastCheckedCommit` to HEAD and exit — let the next run handle actual changes
- **Option C**: On first run, take a configurable lookback window (e.g., last 7 days of commits)

Option B is the safest default and the cheapest, but the spec should say so explicitly.

### 3. Subagent interface contract is implicit

The spec shows example prompts for Phase 2b and Phase 3, but doesn't define:
- How the Haiku subagent is invoked (new Claude Code session? API call? Which instar primitive?)
- How its output is parsed — the spec shows `ACCURATE: reason`, `STALE: reason`, `UNCERTAIN: reason` format, but doesn't specify what happens when Haiku returns something that doesn't match this pattern (hallucinated format, empty response, error)
- Whether Phase 3 Sonnet runs one subagent per stale doc or one subagent for all stale docs
- The timeout or retry policy for subagent calls

This is a developer-facing gap: anyone implementing this from the spec will have to invent these details, then discover edge cases the spec didn't anticipate.

---

## Recommendations

### R1 — Invert the auto-commit default

The spec currently says auto-commit. The open question acknowledges "stage for review" as an alternative. Based on how comparable tools are evolving (DeepDocs, Documentation.AI all propose to branches), and given that this job is modifying files that agents depend on for decision-making, the safer default is:

**Stage changes + send a summary via Telegram, then auto-commit after N hours if no response.**

This gives the builder oversight without requiring active approval for every run, but catches the cases where the AI got something wrong. The spec could add a `supervision` mode: `"supervision": "tier2"` already signals this intent — make it concrete.

### R2 — Add a dry-run mode to the job definition

```json
"dryRun": false
```

Without this, the only way to test Phase 2 (does the triage correctly identify stale docs?) is to run the live job and risk actual commits. A dry-run flag would run Phases 1 and 2, produce a report of what would have changed, but skip Phase 3 entirely. This is table-stakes for any job that writes to the filesystem.

### R3 — Define a `minConfidence` threshold for Phase 2

Right now, UNCERTAIN results are logged to handoff notes and presumably ignored. But the spec doesn't say what the operator should do with them or how they're surfaced. Consider:

```json
"triageThresholds": {
  "staleMinConfidence": "high",
  "uncertainHandling": "flag-only" | "skip" | "escalate"
}
```

This makes the behavior configurable and visible in the job definition, rather than buried in implementation logic.

### R4 — The `docCodeMap` cold-start penalty is undocumented

On first run with an empty `docCodeMap`, Phase 2a falls back entirely to grep. The spec describes this as a fallback but doesn't document what the grep scope is — all files in both doc locations? That could be expensive. The spec should state:
- Grep scope on cold start
- Estimated cost for cold-start vs warm run
- Whether the map is seeded in any way (e.g., a pre-built seed file distributed with the job)

### R5 — Commit message format should include provenance tag

The current commit message format is clean. One addition: include a `[auto]` or `[docs-code-sync]` tag that makes automated commits distinguishable from human commits in `git log`. This helps reviewers understand provenance without reading the full commit body. Some teams use `chore(docs):` prefix for this purpose.

---

## Observations

### What's working well

**The three-phase pipeline is well-designed.** The separation of zero-cost detection, cheap triage, and expensive update is exactly the right architecture for cost-sensitive automation. The spec's cost table is unusually precise and demonstrates real understanding of token economics — this is rare in specs and should be noted as a strength.

**Edge cases are thorough.** Renamed files, large refactors, conflicting manual edits, CLAUDE.md template changes — the spec handles all of these explicitly. Most automation specs wave at edge cases; this one actually thinks them through.

**Reporting format is excellent.** The three-level reporting (normal / updates / alerts) gives operators exactly the right signal-to-noise ratio. The token usage in each report line is a developer-friendly touch.

**Non-goals section earns its place.** "Rewriting docs that are merely suboptimal but still accurate" is a precise and important boundary. Many automation tools don't draw this line and create churn.

**The handoff note mechanism is solid.** Passing context between runs via a markdown file is human-readable and debuggable, which is better than encoding it in JSON fields that require a tool to inspect.

### Minor DX friction points

- The state file path (`.instar/state/docs-code-sync.json`) and handoff note path (`.instar/state/job-handoff-docs-code-sync.md`) follow different naming conventions. Consistent naming reduces cognitive load: either `docs-code-sync.json` / `docs-code-sync-handoff.md`, or `job-docs-code-sync.json` / `job-docs-code-sync-handoff.md`.

- The "Structural docs" list in Phase 2a (always check README.md, CLAUDE.md, architecture.md) is hardcoded in the spec prose. If a developer adds a new structural doc, they'd need to modify the implementation, not the job config. Consider a `structuralDocs` array in the job definition or a config field.

- The `knownUndocumented` list in the state file will grow indefinitely. The spec doesn't define when entries are removed (e.g., when an undocumented module eventually gets docs). Add a lifecycle note.

- "For each stale section, spawn a Sonnet subagent" — if there are 5 stale sections in 3 different docs, does this spawn 5 subagents or 3? The batching strategy for Phase 3 is not specified, only for Phase 2.

---

## Scalability Assessment

**Short-term (1-5 agents, current usage):** The design scales fine. Cost is well-bounded by the gate skip and tiered models.

**Medium-term (multi-agent expansion):** The spec notes scope is "echo-only" for v1, but the architecture anticipates expansion. Two things will need to change: the doc scope table has hardcoded paths, and the state file is agent-local. When multiple agents run this job, you'll want a shared `docCodeMap` (or per-agent maps that can be merged). Worth flagging now even though it's out of v1 scope.

**Long-term (large codebase growth):** The large refactor threshold (>50 files) is a good safety valve. The main scalability question is `docCodeMap` management — over time, this map may have stale entries pointing to deleted docs or renamed files. The spec handles renamed files for code, but doesn't address map maintenance for deleted docs. Add a periodic map pruning step or validation pass.

**The 4-hour schedule** is well-chosen. Daily would miss mid-day drift; hourly would be over-sensitive. 4 hours matches a typical development cycle.

---

## Final Summary

This spec reflects careful thinking about cost, safety, and edge cases. The architecture is sound. The three issues that need resolution before implementation are all solvable without redesign:

1. Replace the inline gate expression with a script reference
2. Document and implement a specific first-run bootstrap strategy
3. Specify the subagent invocation contract and error handling

The auto-commit default is worth reconsidering — a "stage + notify + auto-commit after 4h" pattern provides safety without adding friction, and matches how the broader doc-sync tool market is evolving.

Once these are addressed, this is ready to build.
