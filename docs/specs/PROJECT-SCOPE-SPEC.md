---
title: "Project Scope — Keep Multi-Spec Plans From Falling Off The Radar"
slug: "project-scope"
author: "echo"
review-convergence: false
approved: false
---

# Project Scope

> Multi-spec build plans like the OpenClaw imports (~19 candidate features across 3 rounds) keep falling off the radar after the first few items ship. Today's Initiative Tracker tracks single multi-phase efforts, but has no layer above an initiative — no way to bundle 19 related initiatives into one project with rounds, drift checks, ownership across machines, and structurally-gated round advance. This spec adds that layer.

## ELI16 version

Today the agent has a tracker for one feature at a time. It works fine when you're shipping one feature. But when you have nineteen related features that need to ship over weeks — like the OpenClaw imports we just triaged — the tracker can't see the whole list. The first few features get attention, and the rest get forgotten. We've watched this happen twice (OpenClaw first pass forgot 10 of 13, before that PR-hardening Phase B/C/D forgot until a parallel session caught it).

The fix is a small layer on top of the existing tracker:

- A **project** is a named bundle of features.
- Each project has **rounds** — groups of features you ship together in one autonomous session.
- Each feature in a round has a **pipeline stage**: outline written → full spec drafted → spec convergence passed → approved by user → built and merged.
- A **session-start digest line** keeps every active project visible at the top of every new conversation, so the agent can't forget what's open. The same line is re-injected after context compaction.
- **Drift checks** run before each round. The drift check is a *signal* — its verdict is one of several inputs the gate uses to decide whether the round may start. The gate itself is deterministic and based on verifiable artifacts (spec frontmatter tags, merged PR SHAs that are actually reachable from main).
- **Round advance** is structurally gated: a round can only complete when every item in it has a verified merged PR on main with CI green. The next round needs explicit user acknowledgment for the first auto-advance of a project, and after two unacknowledged auto-advances the project is paused.

The user reads project state on the dashboard or in the session-start orientation. The agent uses a thin skill to advance items. No new database — extends the existing initiatives ledger with a small set of optional fields.

## Problem statement

Long-running, multi-spec efforts keep failing the same way:

- **OpenClaw imports (first pass, 2026-05-08)** — 13 candidate items, only 2 shipped before the rest were forgotten. Both authored items had full specs already; the other 11 sat as one-paragraph outlines. No surface kept the outlines visible. The agent moved on once shipping work ended.
- **PR-hardening Phase B/C/D (2026-04-17)** — Phase A shipped, handoff note existed, but no systemic surface said "you owe this a decision." Caught a day later when a parallel session spotted the handoff note.
- **Threadline growth work** — various strands across days, no single view. Repeated rediscovery cost.

The Initiative Tracker (shipped 2026-04-18) addressed one source of this: solo multi-phase efforts get a card on the dashboard. But it has two structural gaps for multi-spec project work:

1. **No project layer.** An initiative is flat — it has phases, but phases are named strings (`off → shadow → on`), not themselves initiatives. You can't bundle 19 initiatives under one parent and progress them in rounds.
2. **No pipeline awareness.** A spec-driven feature progresses through outline → full spec → convergence → approval → build → merge. The tracker's phase string captures none of this — every feature looks the same regardless of how far through the pipeline it is.

The user has to mentally hold the project roster, the rounds, and each feature's pipeline stage. That mental model is exactly what falls off after a few weeks.

## Design principles

These five principles are load-bearing throughout the spec. Every later section refers back to them.

### P1. Signal vs authority separation

The drift checker emits a *signal* — `no-drift`, `minor-drift`, `premise-violated`, or `manual-review-required`. A signal is one of several inputs to the *authority* — a deterministic gate that decides whether the round may start. The drift-check verdict alone never authorizes or blocks a transition. Authority requires verifiable artifacts (frontmatter tags, merged SHAs reachable from main, CI status, side-effects review presence). This protects against prompt injection in the LLM-mediated check and matches Echo's existing signal-vs-authority memory rule.

### P2. Artifact-bound stage transitions

Every `pipelineStage` transition requires server-side verification of the artifact the transition claims. `outline → spec-drafted` requires a markdown spec file at a path under `docs/specs/`. `spec-drafted → spec-converged` requires `review-convergence: true` in that file's frontmatter plus a matching convergence report in `docs/specs/reports/`. `spec-converged → approved` requires `approved: true` in frontmatter. `approved → building` requires a TaskFlow record id. `building → merged` requires a PR number whose head SHA is reachable from `origin/main` and whose CI checks all succeed. Transitions that fail their artifact check are rejected with 409, not warned.

### P3. Persistent state, no in-memory timers

The 24-hour auto-advance window is a persisted ISO timestamp polled by the existing job-tick infrastructure, not an in-memory `setTimeout`. Survives server restarts, sleep/wake, and crashes. On server start, a reconciler scans for past-due timers and either fires them (if conditions still hold) or marks the project for user attention (if state has drifted).

### P4. Optimistic concurrency on shared state

Project records and round state are mutated through optimistic-concurrency-control — the same pattern TaskFlow ships. Every mutating endpoint requires an If-Match version header. Mismatch returns 409 with the current record so the caller can reconcile. The round runner is the only writer of round-status during an active round; all other paths use OCC to avoid clobbering its work.

### P5. Machine ownership for multi-machine coherence

Echo runs across multiple machines that share `.instar/` via git-sync. Round-related auto-actions only fire on the machine that owns the round (recorded as `ownerMachineId` on the project record at round-start). Leader election runs after 48 hours of owner-offline. This avoids the case of two machines both firing auto-advance after a sync.

## Architecture overview

```
                  ┌────────────────────────┐
                  │  Markdown plan doc     │
                  │  (.instar/projects/*)  │
                  └───────────┬────────────┘
                              │ POST /projects
                              ▼
┌─────────────────────────────────────────────────┐
│  InitiativeTracker (existing) — extended fields │
│  Project record:  kind=project, rounds[],        │
│                    autoAdvanceAt, ownerMachineId │
│                    version (for OCC)             │
│  Child records:   pipelineStage,                 │
│                    parentProjectId               │
└────────┬─────────────────────┬──────────────────┘
         │                     │
         │ /projects/:id/      │ session-start.sh
         │  next, advance,     │ compaction-recovery.sh
         │  halt, drift-check  │ → digest lines
         │                     │
         ▼                     ▼
┌──────────────────┐   ┌─────────────────┐
│ ProjectRound-    │   │  Telegram       │
│ Runner           │   │  digest         │
│  - Computes      │   │  + ack tracker  │
│    stop cond     │   │  + brake handle │
│  - Halt switch   │   └─────────────────┘
│  - Worktree mgmt │
│  - Delegates to  │
│    /autonomous   │   ┌─────────────────┐
└────────┬─────────┘   │  Dashboard      │
         │             │  Projects tab   │
         │             └─────────────────┘
         ▼
┌──────────────────┐
│ ProjectDrift-    │  ←─ Signal source (P1)
│ Checker          │
│  - Path-jailed   │
│  - File-hashed   │
│  - JSON-schema   │
│    output        │
└──────────────────┘
```

## Phase 1 — what this commit ships

### Phase 1.1: Extend Initiative type

Add the following optional fields to the existing `Initiative` interface in `src/core/InitiativeTracker.ts`:

```typescript
interface Initiative {
  // ... existing fields ...

  // Project-layer additions (all optional, backward-compatible):
  kind?: 'task' | 'project';          // immutable after creation
  schemaVersion?: number;              // bumped on backfill (P3)
  version?: number;                    // OCC counter (P4); increments on every PATCH
  parentProjectId?: string;            // back-pointer; only set if parent.rounds contains this id

  // Child-only fields:
  pipelineStage?: 'outline' | 'spec-drafted' | 'spec-converged' | 'approved' | 'building' | 'merged' | 'regressed' | 'skipped';
  specPath?: string;                   // relative to repo root; required for stages ≥ spec-drafted
  prNumber?: number;                   // required for stages = building or merged
  mergedSha?: string;                  // recorded at building → merged transition
  ciCheckedAt?: string;                // ISO; last revalidation against origin/main
  skippedAt?: string;
  skippedBy?: string;
  skippedReason?: string;
  driftCheck?: boolean;                // default true; false for infrastructure-of-tracker specs

  // Project-only fields:
  rounds?: Array<{
    name: string;
    itemIds: string[];                 // child initiative IDs in this round
    status: 'pending' | 'ready' | 'in-progress' | 'partially-complete' | 'complete';
    autoAdvanceAt?: string;            // ISO; populated when prior round completes
    completedAt?: string;
    haltedAt?: string;
    haltReason?: string;
  }>;
  sourceDocs?: string[];               // paths jailed to project-root allowlist (P5 of security)
  autoAdvance?: boolean;               // default true
  telegramTopicId?: string;            // for round-complete and halt notifications
  ownerMachineId?: string;             // current round owner (P5)
  unacknowledgedAdvanceCount?: number; // increments on each auto-advance without ack; pauses project at >= 2
}
```

**Immutability:** `kind` is rejected by `PATCH` after creation. `parentProjectId` mutations require the parent's id in the request body; the server validates that the parent's `rounds[].itemIds` actually contains this child.

**Serialization rule:** Optional fields with `undefined` values are omitted on write. Schema validation rejects `null`. Round-trip test asserts byte-identical output for unchanged records.

### Phase 1.2: Pipeline stage transition validators

A new module `src/core/StageTransitionValidator.ts` defines per-edge preconditions:

| From | To | Required artifact |
|------|----|-------------------|
| outline | spec-drafted | `specPath` exists; file is valid markdown; YAML frontmatter parses with safe-loader |
| spec-drafted | spec-converged | spec frontmatter has `review-convergence: true`; convergence report file exists at `docs/specs/reports/<slug>-convergence.md` |
| spec-converged | approved | spec frontmatter has `approved: true` AND `approved-by` AND `approved-date` |
| approved | building | TaskFlow record id provided; record exists with `status: running` |
| building | merged | `prNumber` provided; `mergedSha` reachable from `origin/main` via `git merge-base --is-ancestor`; CI checks for that SHA all succeeded |
| building | regressed | merged-state check failed; auto-applied by the reconciler |
| merged | regressed | same; auto-applied |
| any | skipped | `skippedReason` non-empty AND `skippedBy` populated |

`POST /projects/:id/advance` calls the validator and rejects with 409 on artifact-check failure. A new `merged-state reconciler` runs on `GET /projects/:id` (lazy) and as a periodic job (every 6 hours) — for any child in `merged`, it verifies the SHA is still on `origin/main` and the recorded PR isn't reverted. On miss → transition to `regressed` and surface via `awaitingUser`.

### Phase 1.3: HTTP endpoints

All endpoints require the agent Bearer auth token. Unauth → 401. CORS off (local-only). All mutating endpoints require the `If-Match` header carrying the current `version`; mismatch → 409 with the current record body.

```
GET    /projects                       — list project-kind initiatives
GET    /projects/:id                   — fetch one project + joined children
                                         (?fields=id,title,pipelineStage,driftStatus for dashboard list)
GET    /projects/:id/next              — next action: drift-check pending, item to converge,
                                         item to approve, round to start
POST   /projects                       — create from plan doc; rate-limited to 5/hour
POST   /projects/:id/advance           — advance one item one stage OR the active round
                                         (body: itemId, targetStage, artifact); requires If-Match
POST   /projects/:id/drift-check       — run drift on the active round; mutex-guarded
POST   /projects/:id/halt              — immediate cancel; halts active TaskFlow and clears autoAdvanceAt
POST   /projects/:id/ack               — record user acknowledgment of last digest;
                                         resets unacknowledgedAdvanceCount
DELETE /projects/:id                   — archives the project; children retain pipelineStage
```

**First-launch out-of-band approval (P1 of security):** The FIRST autonomous round of a newly created project requires an `ack` recorded after the digest is sent. `/projects/:id/advance` for the first round returns 412 (Precondition Required) until an ack lands. Subsequent rounds use the auto-advance flow.

### Phase 1.4: Drift checker (signal-only, hardened)

`src/core/ProjectDriftChecker.ts` produces a verdict signal:

```typescript
type DriftVerdict =
  | { verdict: 'no-drift'; rationale: string; evidenceCitations: Array<{file: string; byteRange: [number, number]}> }
  | { verdict: 'minor-drift'; rationale: string; evidenceCitations: ... }
  | { verdict: 'premise-violated'; rationale: string; evidenceCitations: ... }
  | { verdict: 'manual-review-required'; reason: 'over-budget' | 'deleted-files' | 'empty-spec' | 'missing-frontmatter' | 'timeout' };
```

**Input bounds (normative):**
- Maximum 5 files referenced per spec
- Per-file cap: 2,000 lines or 80 KB (whichever is smaller)
- Total prompt budget: 50,000 tokens
- Over-budget → `manual-review-required` with reason `over-budget`; never silently summarize

**Prompt hardening:**
- Spec content wrapped in `<UNTRUSTED_SPEC_BODY>` block
- File content wrapped in `<UNTRUSTED_FILE_CONTENT path="..." hash="..."/>` block
- System prompt explicitly distrusts content inside these blocks
- Output is structured JSON with enum verdict, Ajv-schema-validated, parser rejects on schema fail

**Authority separation (P1):** The drift verdict is recorded on the round as `lastDriftVerdict` and surfaced in the digest. The actual round-start gate combines:
- All round items at `pipelineStage: 'approved'` or later (artifact)
- Drift verdict is `no-drift` or `minor-drift` (signal)
- No active project halt
- `ownerMachineId` matches current machine (multi-machine)
- `unacknowledgedAdvanceCount < 2` (brake)

The gate's verdict (not the drift verdict) is what authorizes the start.

**File hashing for cache:** drift verdict is keyed by `sha256(specContent + referencedFileHashes...)`. Re-runs reuse the cache unless any hash changes. Cache TTL is 24 hours.

**Failure modes:** timeout = 30 seconds, fail-closed (round halts with `manual-review-required`). One retry on timeout. Repeated failure (3 in a row across resumes) → manual-review-required.

**Cost ceiling:** total drift-check spend per agent ≤ $1/day. Over-budget → defer the next check to next day with a Telegram notice.

**Path jail for file reads:** all paths in `specPath`, `sourceDocs`, and the file references inside specs must (a) be relative to the repo root, (b) resolve via `path.realpath` to a location inside the repo root, (c) not traverse symlinks that escape. YAML frontmatter parsed with `js-yaml` safe-load. Tests cover `../`, absolute paths, symlink escape.

### Phase 1.5: Round runner (single-writer, kill-switchable)

`src/core/ProjectRoundRunner.ts` manages the lifecycle of one round:

1. **Pre-flight:** assert lock file `.instar/round-runner.lock` is free, all round items at `pipelineStage: 'approved'`, no project halt, owner machine == current machine.
2. **Acquire lock** with PID + projectId + roundIndex. Refuse if exists.
3. **Run drift check** via `ProjectDriftChecker`. On `premise-violated` or `manual-review-required` → halt, write structured Telegram message (see Phase 1.7), release lock.
4. **Compute stop condition:** "all `prNumber` values for round itemIds present on `origin/main` with CI green."
5. **Allocate per-item worktrees:** `.worktrees/<projectId>-<roundIndex>-<itemId>` for each itemId. Refuse if any exists.
6. **Delegate to `/autonomous`** with the computed stop condition and `projectId + roundIndex` passed via env. Autonomous skill runs in its own process; runner watches for exit.
7. **On autonomous exit:** for each itemId, verify the artifact (merged SHA reachable + CI green). If all verified → round.status = `complete`. If subset → round.status = `partially-complete` with missing items listed. Never mass-advance.
8. **Cleanup:** `git worktree prune` for the round's worktree namespace.
9. **Release lock.**
10. **On `complete`:** populate `autoAdvanceAt = now + 24h` for the next pending round IF `autoAdvance: true` AND `unacknowledgedAdvanceCount < 2` AND project not first-launch-pending-ack. Send Telegram digest.
11. **On `partially-complete`:** do NOT auto-advance. Surface as `awaitingUser`.

**Halt switch:** `POST /projects/:id/halt` writes `haltedAt` to the active round and signals the autonomous process to abort. Lock released. Worktrees retained for inspection (cleanup deferred to user `/project resume` or `/project abandon`).

**Sentinel integration:** the existing MessageSentinel emergency-stop handler also halts any active round-runner-managed autonomous session.

**At most one round-runner active per machine.** Lock is mandatory.

**Auto-advance polling:** existing initiatives `nextCheckAt` tick (already runs every minute) scans for projects with `autoAdvanceAt <= now` AND owner machine matches AND no active lock AND brake conditions clear. Fires the next round's pre-flight. Server-restart reconciler catches any past-due timers within one tick.

**Drift re-run on resume:** if the round resumes (3-attempt cap on transient failures), drift re-runs only if any `referencedFileHash` changed since the last verdict.

### Phase 1.6: Plan-doc schema and parser

`src/core/PlanDocParser.ts` parses a markdown plan doc into project + child initiative records.

**Frontmatter schema (Ajv-validated):**

```yaml
---
kind: project
id: <slug>                    # required; matches /^[a-z0-9][a-z0-9-]{0,63}$/
title: <string>
status: active
owner: Echo
source_docs:
  - <path>                    # required; relative; jailed (see Phase 1.4)
goal: <multi-line string>
auto_advance: true            # optional, default true
telegram_topic_id: <string>   # optional
---
```

**Roster table format:** markdown tables under `### Tier N` headers, with columns `# | Item | Source | Effort`. The parser extracts each row as a child initiative seed at `pipelineStage: 'outline'`. Round groupings derived from tier headers.

**Validation:**
- All paths in `source_docs` and `specPath` (if extracted) resolve inside the project root.
- No null/undefined leaks: any missing optional fields omitted from persisted records.
- YAML parsed with safe-load only.

**Idempotency:** re-parsing the same plan doc updates the project record + children without creating duplicates (matched by `id` slug).

### Phase 1.7: Skill surface

`.claude/skills/instar-project/SKILL.md` defines:

```
/project create <plan-doc-path>     — register a project from a markdown plan
/project status [id]                — emit current state in chat (no side effects)
/project next [id]                  — show next action
/project advance <id> <stage>       — manual stage transition; uses /projects/:id/advance under the hood
/project drift <id>                 — run drift check now
/project run-round <id> [roundIndex] — start a round (delegates to /autonomous)
/project halt <id>                  — immediate cancel
/project ack <id>                   — record user acknowledgment of last digest
/project resume <id>                — resume a halted round (validates current state first)
/project abandon <id>               — archive a halted round; children remain at current stage
```

All commands validate state-machine preconditions before acting; user gets structured error on precondition fail.

### Phase 1.8: Tone-gated round-complete message

A template function `formatRoundCompleteMessage(round)` requires the following fields and rejects send if any are missing:

```typescript
{
  whatLanded: string;          // bullet list of merged itemIds with titles
  whatHalted?: string;         // for halt events
  evidenceCited?: string[];    // drift-check evidenceCitations or PR SHAs
  rootCauseHypothesis?: string; // for halt events
  concreteNextStep: string;    // "Reply 'pause <project-id>' within 24 hours to hold"
  overrideLink?: string;       // dashboard deep link
  brakeHandlePhrase: string;   // canonical text for the user's hold path
}
```

Message routed through the existing Telegram quality gate (ELI16 tone check, no jargon without introduction, action-oriented).

### Phase 1.9: Session-start and compaction-recovery hooks

`.instar/hooks/instar/session-start.sh` and `compaction-recovery.sh` both query `GET /projects?status=active&fields=id,title,roundsSummary` and emit one line per active project. Performance contract:

- Hook total time budget: ≤ 500ms p95
- Curl timeout: 1.5s
- On timeout: emit `Project state unavailable — server warming` (one line) and continue
- Cached digest: `.instar/projects-digest.cache` (TTL 60s); round runner invalidates on any mutation
- Cap projects shown to top 5 by `lastTouchedAt`; "+N more on dashboard" indicator
- Sanitization: all titles, round names, and item titles stripped of control chars + newlines, capped at 80 chars before emission, to prevent prompt injection via project metadata

### Phase 1.10: Dashboard Projects tab

Read-only tab with:
- Project cards showing title, round-by-round progress bar, current pipelineStage histogram
- Drift status badge per pending item (from the cached verdict; clicking does NOT trigger a new check)
- Last-touched + next-action fields
- Halt button (calls `/projects/:id/halt`) and ack button (calls `/projects/:id/ack`)
- Poll interval: 15s (not faster)
- `textContent` rendering on every user/agent-authored string (xss safe)

Initiatives tab filter: default hides `kind: 'project'` AND records with `parentProjectId`. "Show all" toggle.

### Phase 1.11: TaskFlow integration

- Each per-item build is a TaskFlow record. The runner provides `parentProjectId + roundIndex + itemId` as TaskFlow `stateJson.context`.
- The round itself is **not** a TaskFlow record. Round status is derived from child TaskFlow statuses + the project's own `rounds[i].status`.
- On post-restore startup, reconciler scans for in-progress rounds with no live TaskFlow records → marks them `paused` with `awaitingUser: 'round was in-progress at snapshot; verify and resume'`.

### Phase 1.12: Concurrency, ownership, and multi-machine

- **OCC (P4):** every mutating endpoint requires `If-Match: <version>`. Server increments `version` on every successful write. Mismatch → 409 with current record body. Round runner re-reads + reconciles on 409, never blind-overwrites.
- **Single writer per project:** `.instar/round-runner.lock` enforces one round-runner per machine. Same-project concurrent rounds disallowed.
- **Machine ownership (P5):** `ownerMachineId` set at round start to the machine that initiated. Auto-advance polling only fires when current machine matches. Leader election: if no advance/ack for 48h AND owner machine hasn't reported via `git-sync` health-check, any other machine may claim ownership via `POST /projects/:id/claim-ownership`.
- **Git-sync conflict resolution:** on field-level merge conflict between two machines on a project record, last-writer-wins on `status` and `rounds[i].status`, union on `sourceDocs`, max on `version`, max on `unacknowledgedAdvanceCount`. Documented in `docs/multi-machine.md`.

### Phase 1.13: Backup/restore behavior

`.instar/initiatives.json` is included in instar's snapshot/restore set (no change). Post-restore reconciler:
- Any round with `status: 'in-progress'` and no live TaskFlow → downgraded to `paused`, `awaitingUser` populated.
- Any past-due `autoAdvanceAt` → reconsidered against current state, not auto-fired.
- Lock file removed on server start to clear stale-pid locks.

### Phase 1.14: Out of scope for Phase 1 (tracked as same-PR child initiatives)

Each deferred item below is registered as a CHILD INITIATIVE of the project-scope project itself in the same commit that ships Phase 1, at `pipelineStage: 'outline'`. Success criteria #11 enforces this.

| Item | Why deferred |
|------|--------------|
| Project-level daily digest job | Reuses initiative-digest infra; small follow-up. |
| Cross-project drift / scope overlap | Needs a separate primitive; deferred. Logged as a Phase 2 hard gate. |
| Auto-seeding projects from PR labels | Detection logic non-trivial; Phase 2. |

The "out of scope" trap (deferring without follow-through) is structurally blocked by registering each as a tracked child.

## Surface

| File | Change |
|------|--------|
| `src/core/InitiativeTracker.ts` | Add new optional fields; serialization rule; `kind` immutability; backfill on first load. |
| `src/core/StageTransitionValidator.ts` | NEW. Per-edge artifact preconditions. |
| `src/core/ProjectDriftChecker.ts` | NEW. Signal-only verdict with path jail, file hashing, JSON-schema output, cost cap. |
| `src/core/ProjectRoundRunner.ts` | NEW. Single-writer round lifecycle with halt switch + worktree allocation. |
| `src/core/PlanDocParser.ts` | NEW. Frontmatter schema + roster-table parser; safe YAML; path jail. |
| `src/core/ProjectIntegrityReconciler.ts` | NEW. Merged-state revalidation (lazy + periodic). |
| `src/server/routes.ts` | Add `/projects/*` route group with auth middleware and If-Match enforcement. |
| `src/commands/server.ts` | Wire reconciler + round-runner-tick poller. |
| `.claude/skills/instar-project/SKILL.md` | NEW skill. |
| `.instar/hooks/instar/session-start.sh` | Add active-projects digest (cached, sanitized). |
| `.instar/hooks/instar/compaction-recovery.sh` | Same digest after compaction. |
| `dashboard/index.html` | New Projects tab; Initiatives tab filter. |
| `docs/multi-machine.md` | Document git-sync conflict resolution rules. |
| `tests/unit/InitiativeTracker.project.test.ts` | Project-kind fields, immutability, OCC, backfill. |
| `tests/unit/StageTransitionValidator.test.ts` | Each edge's artifact preconditions; reject paths. |
| `tests/unit/ProjectDriftChecker.test.ts` | Path jail (../, absolute, symlink), prompt-injection delimiter, over-budget verdict, hash cache. |
| `tests/unit/ProjectRoundRunner.test.ts` | Halt switch, worktree allocation, per-item evidence, partial-complete. |
| `tests/unit/PlanDocParser.test.ts` | Frontmatter schema, roster parsing, idempotent re-parse. |
| `tests/integration/projects-api.test.ts` | All endpoints; auth required; If-Match enforced; first-launch ack required. |
| `tests/integration/multi-machine.test.ts` | Two-machine ownership and auto-advance behavior. |

## Non-goals

- Not a replacement for the Initiative Tracker. Projects sit *on top of* initiatives; child initiatives are still regular initiatives.
- Not a ticket system. No assignees other than the agent. No priority fields outside round groupings.
- Not modifying TaskFlow. Each per-item build IS a TaskFlow record, but the round itself is not.
- Not replacing `/build` or `/instar-dev`. The round runner *delegates* to these for per-item builds.
- Not implementing cross-project drift detection in Phase 1 (deferred as a same-PR tracked child).
- Not implementing PR-label auto-seeding (deferred as a same-PR tracked child).
- Not multi-user. Single owner per project; single agent per project.

## Rollback cost

**Clean rollback (no active projects):** revert the new fields, delete the new files, remove the routes + dashboard tab. Existing initiatives retain only the additive fields, which are optional and ignored by old code. Low cost.

**Mid-flight rollback (active project, some rounds shipped):**
1. `POST /projects/:id/halt` to drain the active round.
2. Snapshot `.instar/initiatives.json`.
3. Children retain their stage/PR data; they become standalone task-kind initiatives.
4. `parentProjectId` becomes orphan but harmless (optional field; ignored).
5. Merged PRs stay merged (project layer was advisory, not authoritative).
6. Document this procedure in the spec; tested in `tests/unit/InitiativeTracker.project.test.ts > 'mid-flight rollback leaves merged PRs intact'`.

## Threat model

| Threat | Mitigation |
|--------|------------|
| Drift verdict gamed by injected content | Untrusted blocks in prompt; structured output; signal-only (P1). |
| Pipeline-stage forgery | Server-side artifact validators on every transition (P2). |
| `merged` set on a reverted PR | Periodic + lazy `ProjectIntegrityReconciler` revalidates SHAs on `origin/main`. Transitions to `regressed`. |
| Auto-advance chain outruns user oversight | First-round ack required; `unacknowledgedAdvanceCount ≥ 2` pauses. Multi-channel digest delivery (Telegram + dashboard + attention queue). |
| Two machines fire auto-advance after git-sync | `ownerMachineId` gate (P5). Leader election after 48h. |
| Round-runner crash mid-round leaves bad state | Lock + TaskFlow record + post-restart reconciler. Worktrees retained for inspection. |
| Concurrent writes lose user PATCH under runner | OCC version (P4). 409 on mismatch. |
| Path traversal via `sourceDocs` or spec file refs | Realpath + repo-root jail (P5 sec); symlink escape rejected. |
| YAML injection in plan-doc frontmatter | Safe-load only; schema-validated; rejected on extra/unknown fields. |
| Session-start prompt injection via project title | Control-char + newline strip; length cap; documented in hook. |
| Drift verdict spam by adversarial repeated calls | Per-project drift mutex; hash-keyed cache TTL 24h; $1/day cost ceiling per agent. |
| Halt + auto-advance race | Both paths take the project-record mutex; auto-advance reads `status` immediately before firing and aborts if halted/paused. |
| Skipped items hide forgotten work | Required `skippedReason + skippedBy + skippedAt`; surface in digest as separate count. |
| Self-referential drift check on project-scope spec | `driftCheck: false` flag on infrastructure-of-tracker specs. |
| Halted-round message degenerates to apology-only | Template function rejects send if `rootCauseHypothesis + concreteNextStep` missing. |
| Justin offline misses 24h digest | Multi-channel delivery (Telegram + dashboard + attention queue); ack required to arm timer for second auto-advance. |

## Migration

**One-time backfill on first server start:** every existing initiative record gets `kind: 'task'` and `schemaVersion: 1` written. Records with `kind` already set are untouched. Backfill is idempotent (re-running is a no-op).

**No data loss:** all new fields are optional; old code reading new records ignores unknown fields.

**Strict validator on project-kind records:** must have `rounds` array (possibly empty), `id` matching project-slug regex, valid frontmatter. Records that fail load logged + skipped, not deleted.

## Success criteria

1. A project can be created from a markdown plan doc; child initiatives are seeded with `pipelineStage: 'outline'`; round groupings derived from tier headers.
2. `GET /projects/:id/next` returns the right next action across all stages (drift-check pending, item to converge, item to approve, round to start).
3. Drift check on a stale-premise spec (e.g., the retired six-signal-gate spec) returns `premise-violated`.
4. Drift check on a fresh spec returns `no-drift`.
5. Drift check fed a prompt-injection payload in the spec body returns the structured verdict unchanged (injection text rendered as content, not interpreted as instruction).
6. Drift check over input budget returns `manual-review-required` with reason `over-budget`.
7. Round runner correctly computes stop condition from round itemIds and verifies per-item evidence at round end (no mass-advance).
8. Round halt via `POST /projects/:id/halt` stops the running autonomous session within 5 seconds and releases the lock.
9. First-round advance requires an ack; without an ack, the advance returns 412.
10. Two auto-advances without ack → project paused; third advance attempt returns 412 until user resumes.
11. `mergedSha` reverted on `origin/main` → `ProjectIntegrityReconciler` transitions item to `regressed` on next GET.
12. Concurrent PATCH with stale `version` → 409, current record returned.
13. Two-machine simulation: only owner machine fires auto-advance; non-owner skips.
14. Plan-doc with `source_docs: ["/etc/passwd"]` → rejected by parser.
15. Session-start hook with active project surfaces a one-line digest; with server cold, falls back to cached digest within budget.
16. Dashboard Projects tab renders correctly; Initiatives tab default-hides project-kind and parented items.
17. All deferred follow-ups (digest job, cross-project drift, PR-label auto-seeding) exist as registered child initiatives of the project-scope project in the same commit that ships Phase 1.
18. Round-complete message via Telegram includes whatLanded, concreteNextStep, brakeHandlePhrase; absence of these fields → send rejected by tone gate.
19. All new tests green, tsc clean.
20. The OpenClaw imports project, when registered, surfaces correctly at session start and via `/project status`.

## Resolved design choices

The following open questions are resolved in this spec (all decisions made in convergence):

- **Drift check model**: cheapest configured intelligence provider (typically Haiku-class), via the existing provider abstraction. Consistent with other gates.
- **Round runner failure recovery**: in-progress + resume up to 3 attempts on transient errors; failed thereafter, requires user input.
- **Drift-check input size**: hard 5-file cap; over-budget → `manual-review-required`; never silently summarize.
- **Cross-project drift**: deferred to Phase 2 as a same-PR-registered child initiative; Phase 1 logs file-path overlap into a deferred-review queue for visibility only (no blocking).
- **Drift check authority**: SIGNAL only; the gate combines drift + artifact + ownership + brake state.
- **First-launch approval**: required out-of-band ack before first autonomous round.
- **Auto-advance window persistence**: persisted ISO timestamp polled by existing tick.
- **`autoAdvance: false` location**: optional field on the project record; parseable from plan-doc frontmatter.
- **Dashboard separation**: Initiatives tab hides kind=project and `parentProjectId`-bearing records by default.
- **Telegram topic**: per-project `telegramTopicId` with fallback to agent-default.

## References

- `OPENCLAW-IMPORTS-INDEX.md` — original Echo-side audit, source for one project
- `INITIATIVE-TRACKER-SPEC.md` — sibling spec; this builds directly on top of it
- `.instar/projects/openclaw-imports.md` — the project plan doc this spec is shaped to handle
- `/autonomous` skill — round runner delegates to this
- `/spec-converge` skill — each child item passes through this (signal vs authority context)
- `/instar-dev` skill — each child item is built through this
- `docs/signal-vs-authority.md` — load-bearing principle P1
- MEMORY: `feedback_signal_vs_authority.md`, `feedback_no_out_of_scope_trap.md`, `feedback_worktree_default_for_shared_repos.md`, `feedback_finish_means_merge.md`
