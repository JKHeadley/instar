---
title: "Project Scope — Keep Multi-Spec Plans From Falling Off The Radar"
slug: "project-scope"
author: "echo"
review-convergence: true
review-iterations: 5
review-completed-at: "2026-05-11T17:30:00Z"
review-report: "docs/specs/reports/project-scope-convergence.md"
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-05-11"
approval-note: "Approved via Telegram topic 9003 — 'approved!' — after reading the convergence report and full spec at the private viewer links."
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
- **Drift checks** run before each round. The drift check is a *signal* — its verdict is one of several inputs the gate uses to decide whether the round may start. The gate itself is deterministic and based on verifiable artifacts (spec frontmatter tags, the merge status of the PRs as reported by `gh pr view`).
- **Round advance** is structurally gated: a round can only complete when every item in it has a verified merged PR. The next round needs explicit user acknowledgment for the first auto-advance of a project, and after two unacknowledged auto-advances the project is paused.

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

The drift checker emits a *signal* — `no-drift`, `minor-drift`, `premise-violated`, or `manual-review-required`. A signal is one of several inputs to the *authority* — a deterministic gate that decides whether the round may start. The drift-check verdict alone never authorizes or blocks a transition. Authority requires verifiable artifacts (frontmatter tags, `gh pr view` reports a PR as MERGED, CI status, side-effects review presence). This protects against prompt injection in the LLM-mediated check and matches Echo's existing signal-vs-authority memory rule.

### P2. Artifact-bound stage transitions

Every `pipelineStage` transition requires server-side verification of the artifact the transition claims. `outline → spec-drafted` requires a markdown spec file at a path under `docs/specs/`. `spec-drafted → spec-converged` requires `review-convergence: true` in that file's frontmatter plus a matching convergence report in `docs/specs/reports/`. `spec-converged → approved` requires `approved: true` in frontmatter. `approved → building` requires a TaskFlow record id. `building → merged` requires a PR number; the validator queries the GitHub API via `gh pr view <num> --json state,mergeCommit` and confirms `state == "MERGED"` AND `mergeCommit.oid` is reachable from `origin/main` AND CI for that mergeCommit is green. Transitions that fail their artifact check are rejected with 409, not warned.

**Squash/rebase compatibility:** the head SHA of a PR is NOT what lands on main when a squash or rebase merge is used. The validator therefore uses GitHub's reported `mergeCommit.oid`, not the PR's head SHA. This matches Echo's actual workflow (squash merges are the default).

### P3. Persistent state, no in-memory timers

The 24-hour auto-advance window is a persisted ISO timestamp polled by the existing job-tick infrastructure, not an in-memory `setTimeout`. Survives server restarts, sleep/wake, and crashes. On server start, a reconciler scans for past-due timers and either fires them (if conditions still hold) or marks the project for user attention (if state has drifted).

### P4. Optimistic concurrency on shared state — and recovery, not field-merge, on git-sync conflicts

Project records and round state are mutated through optimistic-concurrency-control. Every mutating endpoint requires an `If-Match: <version>` header. Mismatch returns 409 with the conflict body `{currentVersion, conflictingPaths?: [], rebaseHint?: string}`. The round runner is the only writer of round-status during an active round; all other paths use OCC to avoid clobbering its work.

**Git-sync conflict semantics (corrected from iter 2):** on a git-sync merge conflict between two machines on the same project record, the merge is treated as a *reconciliation event*, not a field-wise three-way merge.

**Integration point:** the integration ships a **custom git merge driver** for `.instar/initiatives.json`, registered via `.gitattributes`:

```
.instar/initiatives.json merge=instar-initiatives
```

The driver `scripts/git-merge-driver-initiatives.js` runs at `git merge` time BEFORE any in-process parser sees the file. It:

1. Parses both sides (ours, theirs, base) as JSON — never lets raw conflict markers reach `InitiativeTracker.load()`.
2. For each conflicting record: compares `version` fields; the higher version wins as the base.
3. The losing side's per-field writes (those that don't appear in the winning record) are captured as `ConflictPatch` entries and appended to that record's `awaitingReconciliation: ConflictPatch[]` array.
4. Writes the resolved JSON back; merge completes cleanly with no in-tree conflict markers.

```typescript
type ConflictPatch = {
  patchId: string;       // uuid
  recordId: string;
  path: string;          // JSON path inside the record
  oursValue: unknown;
  theirsValue: unknown;
  baseValue?: unknown;
  losingMachineId: string;
  capturedAt: string;
};
```

5. Auto-advance is disabled while any project's `awaitingReconciliation` is non-empty (gate check in Phase 1.5 preflight).

**Driver installation (per-clone):** `.gitattributes` registers the merge attribute; the driver itself must be registered in local git config (`git config merge.instar-initiatives.driver "node scripts/git-merge-driver-initiatives.js %O %A %B %P"`). The instar server's first-start path (`src/commands/server.ts`) checks for this registration and runs the config command if missing. Server refuses to start if the script file is absent. Documented in `docs/multi-machine.md`.

**Defense in depth — pre-parser:** even with the merge driver, `InitiativeTracker.load()` detects raw conflict markers (`<<<<<<<`) at parse time and refuses to start the server with a clear error message (rather than crashing on `JSON.parse`). The tracker's `reload()` path (used on git-sync pull events at runtime) also detects raw markers and halts any active round-runner with `awaitingUser: 'conflict markers in initiatives.json — driver may not be registered'`, rather than continuing with partial state.

This avoids the case where field-wise LWW silently breaks OCC guarantees (e.g., two machines incrementing `unacknowledgedAdvanceCount` produce a corrupt count).

### P5. Machine ownership for multi-machine coherence

Echo runs across multiple machines that share `.instar/` via git-sync. Round-related auto-actions only fire on the machine that owns the round (recorded as `ownerMachineId` on the project record at round-start). Heartbeat is a separate file `.instar/machine-health/<machineId>.json` (git-synced, updated every 30 minutes by each machine). Leader election fires only when the owner's heartbeat is >48h stale. The claim is OCC-protected and goes through a documented endpoint (`POST /projects/:id/claim-ownership`).

**Ownership-handover safety:** the claimer must (a) commit-and-push the claim before acting on it, (b) wait 60 seconds for git-sync to converge, (c) re-read the project record before any auto-action. On reconnect, an offline-then-back owner must reconcile by checking the canonical `ownerMachineId` from sync-merged state before any auto-advance fires.

## Architecture overview

```
                  ┌────────────────────────┐
                  │  Markdown plan doc     │
                  │  (.instar/projects/*)  │
                  └───────────┬────────────┘
                              │ POST /projects (or /projects/validate)
                              ▼
┌─────────────────────────────────────────────────┐
│  InitiativeTracker (existing) — extended fields │
│  Project record:  kind=project, rounds[],        │
│                    autoAdvanceAt, ownerMachineId │
│                    version (for OCC),            │
│                    awaitingReconciliation[]      │
│  Child records:   pipelineStage,                 │
│                    parentProjectId, prNumber,    │
│                    mergeCommitOid                │
└────────┬─────────────────────┬──────────────────┘
         │                     │
         │ /projects/:id/      │ session-start.sh
         │  next, advance,     │ compaction-recovery.sh
         │  halt, drift-check, │ → digest lines
         │  ack,               │
         │  claim-ownership,   │
         │  accept-partial     │
         │                     │
         ▼                     ▼
┌──────────────────┐   ┌─────────────────┐
│ ProjectRound-    │   │  Telegram       │
│ Runner           │   │  digest + ack   │
│  - Single entry  │   │  (with empty-   │
│    point for     │   │   default       │
│    round start   │   │   fallback)     │
│    (ack check    │   └─────────────────┘
│    here, not at  │
│    HTTP layer)   │   ┌─────────────────┐
│  - Halt switch   │   │  Dashboard      │
│    with per-step │   │  Projects tab   │
│    checkpoints   │   └─────────────────┘
│  - Lazy worktree │
│  - Dynamic stop  │
│    condition     │
│    (DB-driven)   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ ProjectDrift-    │  ←─ Signal source (P1)
│ Checker          │
│  - Path-jailed   │
│  - File-hashed   │
│  - Cache key     │
│    includes      │
│    prompt+model  │
│    versions      │
│  - JSON-schema   │
│  - Cited byte    │
│    ranges        │
│    verified      │
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
  mergeCommitOid?: string;             // GitHub-reported merge commit; recorded at building → merged
  ciCheckedAt?: string;                // ISO; last revalidation against origin/main
  skippedAt?: string;
  skippedBy?: string;
  skippedReason?: string;
  unskippedAt?: string;                // recorded on skipped → outline reverse transition
  driftCheck?: boolean;                // default true; false for infrastructure-of-tracker specs

  // Project-only fields:
  rounds?: Array<{
    name: string;
    itemIds: string[];                 // child initiative IDs in this round
    status: 'pending' | 'ready' | 'in-progress' | 'partially-complete' | 'complete' | 'complete-with-skips' | 'failed' | 'regressed';
    autoAdvanceAt?: string;            // ISO; populated when prior round completes
    completedAt?: string;
    haltedAt?: string;
    haltReason?: string;
    resumeAttempts?: number;           // counter; capped at 3
    lastDriftVerdict?: DriftVerdict;   // cached per round-attempt
  }>;
  sourceDocs?: string[];               // paths jailed to project-root allowlist
  autoAdvance?: boolean;               // default true
  telegramTopicId?: string;            // for round-complete and halt notifications
  ownerMachineId?: string;             // current round owner (P5)
  targetRepoPath?: string;             // absolute path to the target source repo; required
  unacknowledgedAdvanceCount?: number; // increments on each auto-advance without ack; pauses project at >= 2
  firstLaunchAckAt?: string;           // populated when user acks the first-launch digest
  lastAckedRoundIndex?: number;        // highest round index acked
  awaitingReconciliation?: ConflictPatch[]; // populated by git-sync conflict handler (P4)
  status?: 'active' | 'paused' | 'halted' | 'awaiting-user' | 'archived'; // canonical project-level state
  driftPromptTemplateVersion?: number; // for cache invalidation on prompt edits
}
```

**Status enum (canonical).** Project-level: `'active' | 'paused' | 'halted' | 'awaiting-user' | 'archived'`. Round-level: as above. `awaiting-user` covers any state requiring human attention (failed round, regressed item, reconciliation pending, etc.) and is surfaced explicitly.

**Immutability:** `kind` is rejected by `PATCH` after creation. `parentProjectId` mutations require the parent's id in the request body; the server validates that the parent's `rounds[].itemIds` actually contains this child.

**Serialization rule:** Optional fields with `undefined` values are omitted on write. Schema validation rejects `null`. Round-trip test asserts byte-identical output for unchanged records.

### Phase 1.2: Pipeline stage transition validators

A new module `src/core/StageTransitionValidator.ts` defines per-edge preconditions:

| From | To | Required artifact |
|------|----|-------------------|
| outline | spec-drafted | `specPath` exists; file is valid markdown; YAML frontmatter parses with safe-loader |
| spec-drafted | spec-converged | spec frontmatter has `review-convergence: true`; convergence report file exists at `docs/specs/reports/<slug>-convergence.md` where `<slug>` matches `^[a-z0-9][a-z0-9-]{0,63}$` |
| spec-converged | approved | spec frontmatter has `approved: true` AND `approved-by` AND `approved-date` |
| approved | building | TaskFlow record id provided; record exists with `status: running` |
| building | merged | `prNumber` provided; `gh pr view <num> --json state,mergeCommit,statusCheckRollup` reports `state == "MERGED"` AND `mergeCommit.oid` reachable from `origin/main` AND CI rollup green |
| building | regressed | merged-state check failed; auto-applied by the reconciler |
| merged | regressed | same; auto-applied; **also rolls back round status if applicable (see Phase 1.5)** |
| any | skipped | `skippedReason` non-empty AND `skippedBy` populated |
| skipped | outline | `unskippedAt` recorded; reason logged in notes |

**Slug regex constraint:** spec frontmatter `slug` MUST match `^[a-z0-9][a-z0-9-]{0,63}$` (same regex as project `id`). Convergence report path is constructed via `path.join(repoRoot, 'docs/specs/reports', slug + '-convergence.md')` and `realpath`-checked to remain under `docs/specs/reports/`. Slugs that fail this check reject the transition.

**Target repo:** `mergeCommit.oid` reachability is checked in the project's `targetRepoPath` (see Phase 1.1), NOT the agent's cwd. The reconciler `cd`s into `targetRepoPath` (or uses `git -C`) before running `git merge-base --is-ancestor`. Default for new projects: read `targetRepoPath` from plan-doc frontmatter; missing → reject project creation.

`POST /projects/:id/advance` calls the validator and rejects with 409 on artifact-check failure. A new `merged-state reconciler` runs on `GET /projects/:id` (**lazy**, debounced per-child: skip if `ciCheckedAt < 6h ago`, AND capped at ≤3 child-revalidations per GET to bound `gh pr view` shell-out cost; selection order is oldest `ciCheckedAt` first, ties broken by `roundIndex` ASC then `itemId` ASC, so no child can starve) and as a periodic job (every 6 hours, no per-call cap). On miss → transition to `regressed`, roll back round status, clear future `autoAdvanceAt`, surface via `awaitingUser`.

**API contract on lazy reconciliation:** `GET /projects/:id` is documented as **may mutate** (state can transition from `merged → regressed` during the read). Clients that need pure-read semantics use `GET /projects/:id?reconcile=false`.

### Phase 1.3: HTTP endpoints

All endpoints require the agent Bearer auth token. Unauth → 401. CORS off (local-only). All mutating endpoints require the `If-Match` header carrying the current `version`; mismatch → 409 with `{currentVersion, conflictingPaths?: []}` (NOT the full record — clients fetch on demand).

```
GET    /projects                       — list project-kind initiatives
GET    /projects/:id                   — fetch one project + joined children
                                         (?fields=id,title,pipelineStage,driftStatus)
GET    /projects/:id/next              — next action with structured payload:
                                         {action, params, estimatedCost?, skillCommand?}
                                         Ordering: (roundIndex asc, pipelineStage asc, itemId asc); first action returned.
                                         Possible actions: 'run-spec-converge', 'await-user-approval',
                                         'run-drift-check', 'start-round', 'resolve-conflict',
                                         'accept-partial', 'ack-required', etc.
POST   /projects                       — create from plan doc; rate-limited 5/hour per agent token
                                         (counter persisted at .instar/local/projects-rate.json)
POST   /projects/validate              — dry-run plan-doc parse; no persist
POST   /projects/:id/advance           — advance one item one stage OR the active round
                                         (body: itemId, targetStage, artifact); If-Match required
POST   /projects/:id/drift-check       — run drift on the active round; mutex-guarded
POST   /projects/:id/halt              — immediate cancel; halts active TaskFlow, clears autoAdvanceAt
POST   /projects/:id/ack               — record user acknowledgment; resets unacknowledgedAdvanceCount;
                                         body: {forRoundIndex} — idempotent on lastAckedRoundIndex
POST   /projects/:id/accept-partial    — close partially-complete round: missing items → skipped
                                         (body: reason); transitions round to complete-with-skips.
                                         Counts as an ack for the current roundIndex (advances
                                         lastAckedRoundIndex); does NOT increment unacknowledgedAdvanceCount.
POST   /projects/:id/claim-ownership   — leader-election; checks heartbeat < 48h; OCC-protected;
                                         must commit+push+wait-60s before acting
POST   /projects/:id/resolve-conflict  — clear an awaitingReconciliation entry
                                         body: {patchId, action: 'accept' | 'reject', If-Match required}
                                         accept = apply losingMachineId's value; reject = drop the patch.
                                         Both outcomes appended to .instar/conflict-resolutions.jsonl
                                         (audit trail: {patchId, action, resolvedAt, resolvedBy}).
DELETE /projects/:id                   — archive; refuses if any round is `in-progress` (must halt first)
```

**First-launch out-of-band approval — moved into the runner (single chokepoint).** The HTTP layer no longer enforces this directly. ProjectRoundRunner.preflight() asserts `firstLaunchAckAt` is populated before allowing the FIRST round of any project to start. Any entry path (HTTP advance, `/project run-round` skill, auto-advance poller) goes through the runner and hits this check. Without ack, the runner returns 412 (Precondition Required).

**Telegram digest delivery semantics:** `POST /projects/:id/ack` records the ack. The runner sends digests with retry (3 attempts, exponential backoff); on permanent send failure, falls back to: (a) dashboard attention queue entry, (b) audit-log entry, (c) `awaitingUser` populated. Ack accepted via Telegram reply OR `POST /ack` OR dashboard button OR `/project ack` skill — any channel.

### Phase 1.4: Drift checker (signal-only, hardened)

`src/core/ProjectDriftChecker.ts` produces a verdict signal:

```typescript
type DriftVerdict =
  | { verdict: 'no-drift'; rationale: string; evidenceCitations: VerifiedCitation[] }
  | { verdict: 'minor-drift'; rationale: string; evidenceCitations: VerifiedCitation[] }
  | { verdict: 'premise-violated'; rationale: string; evidenceCitations: VerifiedCitation[] }
  | { verdict: 'manual-review-required'; reason: 'over-budget' | 'deleted-files' | 'empty-spec' | 'missing-frontmatter' | 'timeout' | 'failed-citation-verification' };

type VerifiedCitation = {
  file: string;          // relative to targetRepoPath
  byteRange: [number, number];
  excerpt: string;       // verified slice from the file at the time of the check
};
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

**evidenceCitations verification (signal-vs-authority enforcement):**
After the LLM returns, the checker opens each cited file, confirms `byteRange` is in bounds, and renders the slice as `excerpt`. Citations that don't resolve are dropped. If all citations drop OR the resolved excerpts don't intersect the file paths the spec actually names → verdict downgraded to `manual-review-required` with reason `failed-citation-verification`. The digest shows the verified excerpts verbatim (capped), not the LLM-claimed text.

**Authority separation (P1):** The drift verdict is recorded on the round as `lastDriftVerdict` and surfaced in the digest. The actual round-start gate combines:
- All round items at `pipelineStage: 'approved'` AND each item's spec frontmatter STILL has `review-convergence: true` AND `approved: true` (re-validated at pre-flight, not just at advance time)
- Drift verdict is `no-drift` or `minor-drift` (signal)
- Drift verdict is fresh (computed within last 24h, OR re-run is forced if any referenced-file hash changed)
- No active project halt or pause
- `ownerMachineId` matches current machine (multi-machine)
- `unacknowledgedAdvanceCount < 2` (brake)
- `firstLaunchAckAt` populated (first-round ack gate)

The gate's verdict (not the drift verdict) is what authorizes the start.

**Cache key (corrected from iter 2):**

```
cacheKey = sha256(promptTemplateVersion + modelId + specBodySha + sortedReferencedFileHashes)
```

`promptTemplateVersion` is bumped on every system-prompt change (committed in the same PR). `modelId` is the resolved model name from the intelligence-provider abstraction. Cache TTL = 24h. **mtime fast-path:** before computing the cache key, the checker compares (specPath mtime, referencedFile mtimes) to the last cached values; if all unchanged, the cache key is reused without re-hashing. Hashing only happens when an mtime moved.

**Failure modes:** timeout = 30 seconds, fail-closed (round halts with `manual-review-required`). One retry on timeout. Repeated failure (3 in a row across resumes within the same round) → round status `failed`.

**Cost ceiling (corrected from iter 2):** total drift-check spend per agent ≤ $1/day. Tracked via daily-rotated append-only ledger at `.instar/drift-spend-YYYY-MM-DD.jsonl` (one file per UTC day; old files retained ≤30 days then archived to a monthly tarball). Each row: `{recordId, projectId, estimatedCost, actualCost?, timestamp}`. Each call pre-reserves estimated cost via this read-check-append sequence under an **advisory file lock** on `.instar/local/drift-spend.lock` (POSIX `fcntl` flock; lock file lives under machine-local `.instar/local/` to avoid git-sync deltas on a 0-byte file) — protects against concurrent drift-checks across different projects on the same machine. After the call, an `actualCost` row reconciles. Cap check uses `sum(estimatedCost where actualCost is null) + sum(actualCost where present)` for the current UTC day, O(day-rows-only). Boundary: `spent + estimated > $1.00` → reject (strict greater-than). Per-machine ledger; on multi-machine, total is sum of machines' ledgers in git-sync — documented as "per-agent ceiling, up to N machines × $1/day in worst case" (not a true cross-machine atomic cap; deferred as same-PR-registered child `drift-spend-cross-machine`).

**Path jail for file reads:** all paths in `specPath`, `sourceDocs`, and the file references inside specs must (a) be relative to `targetRepoPath`, (b) resolve via `path.realpath` to a location inside `targetRepoPath`, (c) not traverse symlinks that escape. YAML frontmatter parsed with `js-yaml` safe-load. Tests cover `../`, absolute paths, symlink escape.

### Phase 1.5: Round runner (single entry point, dynamic stop condition, kill-switchable)

`src/core/ProjectRoundRunner.ts` is the SINGLE entry point for round-start. Every path (HTTP advance, `/project run-round` skill, auto-advance poller) calls `ProjectRoundRunner.preflight(projectId, roundIndex)`. The HTTP layer does NOT enforce gates that the runner already enforces.

**Pre-flight checks (single chokepoint):**
1. Lock file `.instar/local/round-runner.lock` is free. (Path is **machine-local**, NOT git-synced — see Phase 1.12.)
2. PID in lock (if present) is alive; if not, remove (handles crash without restart).
3. All round items at `pipelineStage: 'approved'` AND each item's spec frontmatter re-validates (`review-convergence: true` AND `approved: true` still set, convergence report still on disk).
4. Project `status: 'active'` (not `paused`, `halted`, `awaiting-user`).
5. `firstLaunchAckAt` populated (only required for the FIRST round of the project; deliberately a one-time gate covering round 0). For subsequent rounds, the brake is `unacknowledgedAdvanceCount < 2` AND `lastAckedRoundIndex >= currentRoundIndex - 2` (no more than two rounds-ahead-of-ack at any time).
6. `unacknowledgedAdvanceCount < 2`.
7. Owner machine == current machine (or owner empty AND this round is the first claim).
8. `targetRepoPath` exists and is a git repo.
9. No `awaitingReconciliation` entries pending.
10. Drift check: load cached verdict if fresh + present + all hashes match; otherwise run drift. `premise-violated` or `manual-review-required` → halt, write structured Telegram message, release lock.

**Per-step halt checkpoint:** between every numbered step below, the runner re-reads project `status` and aborts if `halted` or `paused`.

**Run loop:**
1. **Acquire lock** with PID + projectId + roundIndex. Refuse if exists and PID is alive.
2. **Compute INITIAL stop condition:** "all `prNumber` values for round itemIds present on `origin/main` with CI green (per Phase 1.2 validator)."
3. **For each itemId, lazy-allocate** worktree at `path.join(targetRepoPath, '.worktrees', projectId, String(roundIndex), itemId)` via `git -C targetRepoPath worktree add ...` as the autonomous run reaches that item. Worktrees live INSIDE the target repo, not the agent cwd. On first allocation in a target repo, the runner appends `.worktrees/` to `.git/info/exclude` (per-clone, not committed) so worktrees don't pollute `git status` or get caught by `git add -A`. Refuse if the path already exists. (Path uses `/` separators to avoid slug collision.)
4. **Delegate to `/autonomous`** with the project id + round index + initial stop condition passed via env. Autonomous skill runs in its own process; runner watches for exit AND polls the project record every 60s.
5. **Dynamic stop condition revalidation:** every poll cycle, re-read the round's `itemIds` from the project record. If an item was manually transitioned to `skipped` mid-round (or `outline`), the runner emits SIGTERM to the autonomous process's **process group** (`kill -- -PGID`) so spawned children (compilers, test runners) are also reaped. **The autonomous child is spawned with `detached: true` (Node `child_process.spawn`, or `setsid` equivalent) so the runner is NOT a member of the child's process group; `kill -- -PGID` targets only the child's group and never reaps the runner itself.** After SIGTERM, runner waits up to 5s; SIGKILL the group otherwise. Then runner recomputes the stop condition and **loops back to step 4** to relaunch `/autonomous` with the new condition — UNLESS the new stop condition is already satisfied by current artifact state, in which case proceed to step 6.
6. **On autonomous natural exit** (not SIGTERM-relaunch): for each itemId, verify the artifact (mergeCommit.oid reachable + CI green via `gh pr view`). If all verified → round.status = `complete`. If subset → round.status = `partially-complete` with missing items listed. Never mass-advance.
7. **Cleanup:** `git -C targetRepoPath worktree prune` for the round's worktree namespace.
8. **Release lock.**
9. **On `complete`:** populate `autoAdvanceAt = now + 24h` for the next pending round IF `autoAdvance: true` AND `unacknowledgedAdvanceCount < 2` AND project not first-launch-pending-ack for the next round (first-launch ack is a one-time gate). Send Telegram digest.
10. **On `partially-complete`:** do NOT auto-advance. Surface as `awaitingUser: 'round N partially complete; accept partial (M-of-K items skipped) or resolve missing items'`. User runs `POST /projects/:id/accept-partial` or `/project advance` per item.
11. **On `failed` (after 3 resume attempts):** round.status = `failed`, project.status = `awaiting-user`. Auto-advance poller skips. Only `/project resume --force` or `/project abandon` accepted.

**Halt switch:** `POST /projects/:id/halt` writes `haltedAt` to the active round, project.status → `halted`, signals the autonomous process via SIGTERM (5s grace, then SIGKILL). Lock released. Worktrees retained for inspection (cleanup deferred to user `/project resume` or `/project abandon`).

**Sentinel integration:** the existing MessageSentinel emergency-stop handler also halts any active round-runner-managed autonomous session via the same path.

**At most one round-runner active per machine.** Lock is mandatory.

**Auto-advance polling:** existing initiatives `nextCheckAt` tick scans for projects with `autoAdvanceAt <= now` AND `status: 'active'` AND owner machine matches current machine AND no active lock AND `unacknowledgedAdvanceCount < 2`. Fires the next round's pre-flight. Filtered server-side, NOT scanning full ledger.

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
target_repo_path: <absolute>  # required
source_docs:
  - <path>                    # required; relative to target_repo_path; jailed
goal: <multi-line string>
auto_advance: true            # optional, default true
telegram_topic_id: <string>   # optional
defers:                       # optional but recommended; structural follow-through gate
  - <slug>                    # each must exist as a registered child initiative
---
```

**Roster table format:** markdown tables under `### Tier N` headers, with columns `# | Item | Source | Effort`. The parser extracts each row as a child initiative seed at `pipelineStage: 'outline'`. Round groupings derived from tier headers.

**Validation:**
- All paths in `source_docs` and `specPath` (if extracted) resolve inside `target_repo_path`.
- No null/undefined leaks: any missing optional fields omitted from persisted records.
- YAML parsed with safe-load only.

**Idempotency:** re-parsing the same plan doc updates the project record + children without creating duplicates (matched by `id` slug).

**Reparse immutability table — what re-parse may change vs may not:**

| Field on child initiative | Reparse-mutable while `outline`? | Reparse-mutable while `≥ spec-drafted`? |
|---------------------------|----------------------------------|------------------------------------------|
| title | yes | yes |
| pipelineStage | no — never reset by reparse | no |
| specPath | yes | no |
| prNumber / mergeCommitOid / ciCheckedAt | no | no |
| parentProjectId | yes (initial set) | no |
| skippedAt/By/Reason | no | no |
| Round membership (rounds[].itemIds) | yes | yes (with warning on next preflight) |

**Mid-round mutation table — what `/project advance` / `PATCH` may do while round status is `in-progress`:**

| Mutation | Allowed mid-round? | Effect |
|----------|--------------------|---------|
| Child `→ skipped` | yes | Triggers runner SIGTERM → relaunch |
| Child `skipped → outline` | no | 409; must halt round first |
| Child `building → merged` | yes (via validator) | Counted toward stop condition |
| Child `merged → regressed` | yes (reconciler-only) | Rolls back round status |
| Round membership change | no | 409; must halt round first |
| `autoAdvance` flip | yes | Affects next round; current round unaffected |
| `targetRepoPath` mutation | no | 409 |

**Slug reuse after archive:** `POST /projects` with the slug of an `archived` project is rejected with 409 unless the plan-doc frontmatter contains `unarchive: true`, which un-archives the existing record and re-parses it (subject to immutability rules above).

**Dry-run:** `POST /projects/validate` returns the parsed structure with validation errors and the would-be child-initiative list; does NOT persist.

**Defers enforcement (replaces iter-2 success-criterion-only check):** a new pre-commit hook script `scripts/check-defers.sh` (installed in the same PR) is **path-filtered** — only runs when `docs/specs/**/*.md` files are in the staged paths. Scans any staged spec frontmatter for a `defers:` list and verifies each listed slug appears as a registered initiative at HEAD with `parentProjectId` set. Commit rejected if not. Closes the "out of scope" trap structurally.

### Phase 1.7: Skill surface

`.claude/skills/instar-project/SKILL.md` defines:

```
/project create <plan-doc-path>     — register a project from a markdown plan
/project status [id]                — emit current state in chat (no side effects)
/project next [id]                  — show next action (uses /projects/:id/next)
/project advance <id> <stage>       — manual stage transition; uses /projects/:id/advance
/project drift <id>                 — run drift check now
/project run-round <id> [roundIndex] — start a round (delegates to ProjectRoundRunner)
/project halt <id>                  — immediate cancel
/project ack <id> [roundIndex]      — record user acknowledgment
/project resume <id>                — resume a halted round (validates current state first)
/project resume --force <id>        — required for `failed` rounds after 3-attempt cap
/project abandon <id>               — archive a halted round; children remain at current stage
/project accept-partial <id> <roundIndex> <reason>  — close partially-complete round
/project claim-ownership <id>       — multi-machine ownership transfer
```

All commands route through ProjectRoundRunner where applicable; preconditions checked there, not at the skill layer.

### Phase 1.8: Tone-gated round-complete message

A template function `formatRoundCompleteMessage(round, event)` requires these fields and rejects send if any are missing:

```typescript
{
  whatLanded: string;          // bullet list of merged itemIds with titles; defaults to "No items shipped this round — halted at <step>"
  whatHalted?: string;         // for halt events
  evidenceCited?: string[];    // verified citations or PR mergeCommit.oid values
  rootCauseHypothesis?: string; // required for halt events; default for clean complete: "(none)"
  concreteNextStep: string;    // "Reply 'pause <project-id>' within 24 hours to hold"
  overrideLink?: string;       // dashboard deep link
  brakeHandlePhrase: string;   // canonical text for the user's hold path
}
```

**Empty-default for pre-flight halts:** when a halt fires before any items shipped, `whatLanded = "No items shipped this round — halted at pre-flight on <reason>"`. The template enforces *presence* of every required field, never *non-emptiness*, so the gate never silently rejects on a legitimate halt.

**Idempotency:** every outbound message carries `(projectId, roundIndex, eventKind, version)` as the idempotency key. Tone-gate retries that re-call the send path suppress duplicates via this key.

Message routed through the existing Telegram quality gate (ELI16 tone check).

### Phase 1.9: Session-start and compaction-recovery hooks

`.instar/hooks/instar/session-start.sh` and `compaction-recovery.sh` both read `.instar/projects-digest.cache` (FILE-FIRST, no HTTP). The cache is generated by `InitiativeTracker.flushDigestCache()` whenever any project mutation hits the write path (single chokepoint — invalidates from any source: HTTP, runner, reconciler, post-restore, git-sync). Format: one JSON line per active project with sanitized fields.

**Performance contract:**
- Hook total time budget: ≤ 50ms (file read only)
- On cache miss (file deleted, server never wrote one): emit `Active projects: state unavailable — run /project status when ready` and continue
- Compaction-recovery hook receives the same digest content (no extra HTTP call)

**Sanitization (read-time AND write-time — defense in depth):**
- Strip control chars + newlines from every user/agent-authored string
- Cap each title/round-name/item-title at 80 chars
- Cap projects shown to top 5 by `lastTouchedAt`; "+N more on dashboard" indicator
- Re-sanitize on read for defense against direct cache-file poisoning

### Phase 1.10: Dashboard Projects tab

Read-only tab with:
- Project cards showing title, round-by-round progress bar, current pipelineStage histogram
- Drift status badge per pending item (from the cached verdict; clicking does NOT trigger a new check)
- Halt button (calls `/projects/:id/halt`) and ack button (calls `/projects/:id/ack`)
- Poll interval: 15s (not faster)
- `textContent` rendering on every user/agent-authored string (XSS safe)
- 409 response handled silently: refresh + re-render, no error toast

Initiatives tab filter:
- `GET /initiatives?excludeKind=project&excludeParented=true` (server-side) hides project-kind and parented records by default
- "Show all" toggle round-trips
- New query params documented in the existing Initiative Tracker spec's "References" appendix

### Phase 1.11: TaskFlow integration

- Each per-item build is a TaskFlow record. The runner provides `parentProjectId + roundIndex + itemId` as TaskFlow `stateJson.context`.
- The round itself is **not** a TaskFlow record. Round status is derived from child TaskFlow statuses + the project's own `rounds[i].status`.
- On post-restore startup, reconciler scans for in-progress rounds with no live TaskFlow records → marks them `paused` with `awaitingUser: 'round was in-progress at snapshot; verify and resume'`.
- On `/autonomous` exit, the runner cleans up the autonomous skill's state file at the same time it releases the round-runner lock (single cleanup path, documented in `docs/multi-machine.md`).

### Phase 1.12: Concurrency, ownership, and multi-machine

- **OCC (P4):** every mutating endpoint requires `If-Match: <version>`. Server increments `version` on every successful write. Mismatch → 409 with `{currentVersion, conflictingPaths?: []}`. The full record is NOT returned (callers `GET` on demand to avoid 40KB 409 bodies on polls). Round runner re-reads + reconciles on 409, idempotently keyed by `(projectId, roundIndex, eventKind)`.
- **Single writer per machine:** lock file at `.instar/local/round-runner.lock` enforces one round-runner per machine. **Path is machine-local** (`.instar/local/` is in `.gitignore` — does NOT sync). Cross-machine single-writer enforcement comes from `ownerMachineId` (P5), not the lock file.
- **Stale-PID recovery:** on every preflight, check the lock's PID with `ps -p <pid>`; if dead, remove and proceed. No server restart required.
- **Machine ownership (P5):** `ownerMachineId` set at round start. Auto-advance polling only fires when current machine matches. Heartbeat file `.instar/machine-health/<machineId>.json` updated every 30 minutes by each machine, git-synced. Each machine writes only its own heartbeat file (one-file-per-machine convention; no cross-machine OCC needed). Leader-election claim only fires when owner's heartbeat is >48h stale.
- **Ownership claim path:** `POST /projects/:id/claim-ownership` returns 202 Accepted immediately with `{operationId, settleAt}` instead of blocking for the 60s sync settle (avoids client-timeout / gate-latency footgun per MEMORY `feedback_gate_latency_vs_client_timeout.md`). `operationId` is a `crypto.randomUUID()` (128-bit entropy). The claim is OCC-protected (If-Match on project version), checks heartbeat staleness, writes the new owner, commits-and-pushes the change to git-sync. The background worker waits 60s for sync convergence then re-reads heartbeat; aborts the claim if the original owner just heartbeated, otherwise finalizes ownership at `settleAt`. `GET /projects/:id/ownership-claim/:operationId` polls status. Operation records expire and are garbage-collected 1 hour after `settleAt`. Original owner that reconnects must re-read `ownerMachineId` before any auto-action (60s git-sync settle period enforced).
- **Git-sync conflict resolution (corrected from iter 2, P4):** on a record-level merge conflict, the merge IS a reconciliation event. Winning version is the higher `version`. Any writes from the losing side that don't appear in the winning record are surfaced as entries in `awaitingReconciliation: ConflictPatch[]`. Auto-advance is disabled while this array is non-empty. User resolves via `POST /projects/:id/resolve-conflict`. NO field-wise auto-merge for OCC-protected fields.

### Phase 1.13: Backup/restore and machine-local-vs-synced

**Snapshot include:** `.instar/initiatives.json`, `.instar/projects-digest.cache` (regenerable, included for fast post-restore startup), `.instar/drift-spend-*.jsonl` (daily-rotated files within retention window), `.instar/machine-health/`, `.instar/conflict-resolutions.jsonl`.

**Snapshot exclude:** `.instar/local/` (machine-local; includes `round-runner.lock`). Lock files never restored.

**Post-restore reconciler:**
- Any round with `status: 'in-progress'` and no live TaskFlow → downgraded to `paused`, `awaitingUser` populated.
- Any past-due `autoAdvanceAt` → reconsidered against current state, not auto-fired (logged for user attention).
- `.instar/local/round-runner.lock` removed at server start (per Phase 1.12).

### Phase 1.14: Out of scope for Phase 1 (tracked as same-PR child initiatives)

Each deferred item below is registered as a CHILD INITIATIVE of the project-scope project itself in the same commit that ships Phase 1, at `pipelineStage: 'outline'`. The `defers:` list in this spec's frontmatter names each slug; the new `scripts/check-defers.sh` pre-commit hook (Phase 1.6) enforces that each slug exists as a registered initiative at HEAD.

| Item | Why deferred |
|------|--------------|
| Project-level daily digest job (`project-daily-digest`) | Reuses initiative-digest infra; small follow-up |
| Cross-project drift / scope overlap (`cross-project-drift`) | Needs separate primitive; deferred. Phase 1 logs file-path overlap into a deferred-review queue (no blocking) |
| Auto-seeding projects from PR labels (`project-pr-label-autoseed`) | Detection logic non-trivial; Phase 2 |
| True cross-machine atomic drift-spend cap (`drift-spend-cross-machine`) | Phase 1 uses per-machine ledger summed via sync; atomic cap deferred |

## Surface

| File | Change |
|------|--------|
| `src/core/InitiativeTracker.ts` | Add new optional fields; serialization rule; `kind` immutability; backfill on first load (batched, single-write, idempotent); digest-cache invalidation in write path |
| `src/core/StageTransitionValidator.ts` | NEW. Per-edge artifact preconditions; uses `gh pr view` for merge state |
| `src/core/ProjectDriftChecker.ts` | NEW. Signal-only verdict with path jail, file hashing + mtime fast-path, JSON-schema output, cost ledger, citation verification |
| `src/core/ProjectRoundRunner.ts` | NEW. Single-entry-point round lifecycle with halt switch, lazy worktree allocation, SIGTERM, dynamic stop revalidation, per-step halt checkpoints |
| `src/core/PlanDocParser.ts` | NEW. Frontmatter schema + roster-table parser; safe YAML; path jail; dry-run mode |
| `src/core/ProjectIntegrityReconciler.ts` | NEW. Merged-state revalidation via `gh pr view` (lazy + periodic); round-status rollback on regressed |
| `src/server/routes.ts` | Add `/projects/*` route group with auth middleware and If-Match enforcement; `/initiatives` filter params |
| `scripts/git-merge-driver-initiatives.js` | NEW. Custom git merge driver for `.instar/initiatives.json` that produces `awaitingReconciliation` patches instead of leaving raw conflict markers. |
| `.gitattributes` | Register `.instar/initiatives.json merge=instar-initiatives`. |
| `src/commands/server.ts` | Wire reconciler + round-runner-tick poller; post-restore reconciler; merge-driver auto-registration on first start |
| `scripts/check-defers.sh` | NEW. Pre-commit hook for `defers:` list enforcement |
| `.claude/skills/instar-project/SKILL.md` | NEW skill |
| `.instar/hooks/instar/session-start.sh` | Read `.instar/projects-digest.cache` (50ms budget) |
| `.instar/hooks/instar/compaction-recovery.sh` | Same digest after compaction |
| `dashboard/index.html` | New Projects tab; Initiatives tab filter |
| `docs/multi-machine.md` | Document git-sync conflict resolution + ownership transfer + lock semantics |
| `.gitignore` | Add `.instar/local/` |
| `tests/unit/InitiativeTracker.project.test.ts` | Project-kind fields, immutability, OCC, backfill, digest-cache invalidation |
| `tests/unit/StageTransitionValidator.test.ts` | Each edge; `gh pr view` mocking; squash-merge SHA handling; slug regex rejection; reject paths |
| `tests/unit/ProjectDriftChecker.test.ts` | Path jail (../, absolute, symlink), prompt-injection delimiter, over-budget, hash cache, mtime fast-path, citation verification, cache key with prompt+model version |
| `tests/unit/ProjectRoundRunner.test.ts` | Halt switch, SIGTERM-then-SIGKILL within 5s, lazy worktree, per-item evidence, partial-complete, dynamic stop revalidation, single-entry-point ack enforcement |
| `tests/unit/PlanDocParser.test.ts` | Frontmatter schema, roster parsing, idempotent re-parse, dry-run, defers list |
| `tests/integration/projects-api.test.ts` | All endpoints; auth required; If-Match enforced; 409 conflict body shape; first-launch ack required regardless of entry path |
| `tests/integration/multi-machine.test.ts` | Two-machine ownership, auto-advance behavior, claim-ownership flow, ownership-handover safety, reconciliation conflict surfacing |
| `tests/integration/squash-merge.test.ts` | NEW. End-to-end: PR squash-merged on GitHub → `gh pr view` reports MERGED → transition succeeds (regression guard) |
| `tests/integration/git-merge-driver.test.ts` | NEW. Concurrent two-machine edits → merge driver produces `awaitingReconciliation` patches; raw conflict markers never reach `InitiativeTracker.load()`. |
| `tests/unit/InitiativeTracker.load.test.ts` | Loader rejects raw `<<<<<<<` conflict markers with a clear error instead of crashing on JSON.parse. |

## Non-goals

- Not a replacement for the Initiative Tracker. Projects sit *on top of* initiatives; child initiatives are still regular initiatives.
- Not a ticket system. No assignees other than the agent. No priority fields outside round groupings.
- Not modifying TaskFlow. Each per-item build IS a TaskFlow record, but the round itself is not.
- Not replacing `/build` or `/instar-dev`. The round runner *delegates* to these for per-item builds.
- Not implementing cross-project drift detection in Phase 1 (deferred as a same-PR tracked child).
- Not implementing PR-label auto-seeding (deferred as a same-PR tracked child).
- Not implementing true cross-machine atomic drift-spend cap in Phase 1 (deferred as a same-PR tracked child).
- Not multi-user. Single owner per project; single agent per project.

## Rollback cost

**Clean rollback (no active projects):** revert the new fields, delete the new files, remove the routes + dashboard tab. Existing initiatives retain only the additive fields, which are optional and ignored by old code.

**Mid-flight rollback (active project, some rounds shipped):**
1. `POST /projects/:id/halt` to drain the active round.
2. Snapshot `.instar/initiatives.json`.
3. Children retain their stage/PR data; they become standalone task-kind initiatives.
4. `parentProjectId` becomes orphan but harmless (optional field; ignored).
5. Merged PRs stay merged (project layer was advisory, not authoritative).
6. Documented procedure in the spec; tested in `tests/unit/InitiativeTracker.project.test.ts > 'mid-flight rollback leaves merged PRs intact'`.

## Threat model

| Threat | Mitigation |
|--------|------------|
| Drift verdict gamed by injected content | Untrusted blocks; structured output; citation verification; signal-only (P1) |
| Pipeline-stage forgery | Server-side artifact validators on every transition (P2); pre-flight re-validation of frontmatter |
| `merged` set on reverted PR | `ProjectIntegrityReconciler` re-queries `gh pr view`; transitions to `regressed`; rolls back round status |
| Squash-merge SHA mismatch | `gh pr view --json state,mergeCommit` uses GitHub's reported merge commit, not PR head SHA |
| Auto-advance chain outruns oversight | First-round ack required at runner level (not just HTTP); `≥2` unack pauses; multi-channel digest delivery |
| Two machines fire auto-advance after sync | `ownerMachineId` + heartbeat + claim-ownership protocol with 60s cooling period |
| Round-runner crash mid-round | Lock + TaskFlow record + post-restart reconciler; stale-PID recovery without restart |
| Concurrent writes lose user PATCH | OCC version (P4); 409 with version-only body; runner reconciles idempotently |
| Path traversal via `sourceDocs` / file refs | Realpath jail under `targetRepoPath`; symlink escape rejected; safe YAML |
| YAML injection in plan-doc | Safe-load only; schema-validated; unknown fields rejected |
| Session-start prompt injection via project metadata | Control-char strip; length cap; sanitization at write AND read time |
| Drift verdict spam | Per-project mutex; hash-keyed cache (TTL 24h); $1/day cost ledger |
| Halt + auto-advance race | Both paths take the project-record OCC mutex; auto-advance re-reads `status` immediately before firing |
| Skipped items hide forgotten work | Required `skippedReason + skippedBy + skippedAt`; surface in digest |
| Self-referential drift check on infra spec | `driftCheck: false` flag |
| Halted-round message degenerates to apology-only | Template requires structured fields; empty-default for pre-flight halts (presence enforced, not non-emptiness) |
| Justin offline misses 24h digest | Multi-channel delivery + ack-required for second advance + dashboard attention queue |
| Drift-spend exceeds cap via concurrent calls | Pre-reserve in append-only ledger; strict `>` boundary |
| First-launch ack bypass via skill | Ack check moved to ProjectRoundRunner.preflight() — single chokepoint |
| Cache poisoning via direct file write | Re-sanitize on read; defense in depth |
| Worktree slug collision | Path uses `/` separator; per-itemId namespace |
| Cache reuse after prompt-hardening fix | Cache key includes `promptTemplateVersion` + `modelId` |
| LLM fabricates evidence citations | Citation byteRange validated post-LLM; failed verification → manual-review-required |
| User skip mid-round leaves runner waiting | Runner polls project record every 60s; dynamic stop revalidation; SIGTERM on skipped-mid-round |
| Git-sync field-merge breaks OCC | Reconciliation-event semantics; `awaitingReconciliation` for losing-side writes; user resolves |
| Lock file syncs across machines | Lock path under `.instar/local/` (gitignored); cross-machine enforcement via `ownerMachineId` |
| Stale-PID lock blocks new run | Preflight checks `ps -p`; removes dead-PID lock without server restart |
| Slug path traversal in convergence-report check | Regex-constrained at parse time; realpath-checked under `docs/specs/reports/` |
| Tone-gate retry double-sends | Idempotency key `(projectId, roundIndex, eventKind, version)` |
| `partially-complete` deadlock | `/project accept-partial` resolves; missing items → skipped with reason |
| Attempt-4 infinite resume | `failed` terminal state; only `--force` resume or `abandon` accepted; auto-advance poller skips |
| `awaitingReconciliation` ignored | Auto-advance gated on empty array; surfaced in digest until resolved |
| Raw conflict markers crash JSON.parse | Custom git merge driver runs BEFORE in-process parser; loader also detects raw markers and refuses to start with clear error |
| Worktree in wrong repo (agent cwd vs target) | Worktree path uses `path.join(targetRepoPath, ...)` and `git -C targetRepoPath` |
| Orphan child processes after SIGKILL | Kill the autonomous process group (`kill -- -PGID`), not just the leader |
| Mid-round skip falls through to partially-complete | Step 5 explicitly loops back to step 4 to relaunch autonomous with new stop condition; step 6 only on natural exit |
| Cost ledger concurrent-call double-count | Advisory file lock (`fcntl flock`) on `.instar/drift-spend.lock` around read-check-append |
| claim-ownership 60s wait hits client timeout | Endpoint returns 202 immediately; background worker finalizes after settle |
| Drift cost ledger unbounded growth | Daily-rotated files; retained ≤30 days; archived to monthly tarball |
| Reconciler `gh pr view` shell-out pile-up on dashboard polls | Lazy reconciler capped at ≤3 child-revalidations per GET; periodic job unbounded |
| Lazy reconciler mutating during a read | Documented in API contract; `?reconcile=false` for pure-read |
| Slug reuse after archive silently un-archives | Reject 409 unless plan-doc has `unarchive: true` |
| Reparse silently changes immutable fields | Reparse immutability table enforced server-side |
| `firstLaunchAckAt` covers only round 0 | Documented; subsequent rounds gated on `lastAckedRoundIndex ≥ currentRoundIndex - 2` |

## Migration

**One-time backfill on first server start:** every existing initiative record gets `kind: 'task'` and `schemaVersion: 1` written. Records with `kind` already set are untouched. Backfill is idempotent (re-running is a no-op). Single batched file write at end (not per-record).

**No data loss:** all new fields are optional; old code reading new records ignores unknown fields.

**Strict validator on project-kind records:** must have `rounds` array (possibly empty), `id` matching project-slug regex, `targetRepoPath` populated, valid frontmatter. Records that fail load are logged + skipped, not deleted.

## Success criteria

1. A project can be created from a markdown plan doc; child initiatives are seeded with `pipelineStage: 'outline'`; round groupings derived from tier headers.
2. `GET /projects/:id/next` returns the right next action across all stages.
3. Drift check on a stale-premise spec (e.g., retired six-signal-gate spec) returns `premise-violated`.
4. Drift check on a fresh spec returns `no-drift`.
5. Drift check fed a prompt-injection payload returns the structured verdict unchanged (injection rendered as content).
6. Drift check over input budget returns `manual-review-required` with reason `over-budget`.
7. Drift cache key invalidates on `promptTemplateVersion` bump or `modelId` change.
8. Drift evidenceCitations with out-of-range byteRange → `manual-review-required` with reason `failed-citation-verification`.
9. Round runner correctly computes stop condition; verifies per-item evidence at round end; never mass-advances.
10. Round halt via `POST /projects/:id/halt` SIGTERMs the autonomous process within 5s and releases the lock.
11. First-launch advance through ANY entry path (HTTP, skill, auto-advance) requires `firstLaunchAckAt`; missing → 412.
12. Two auto-advances without ack → project paused; third advance attempt returns 412 until user resumes.
13. PR squash-merged on GitHub → `gh pr view` reports MERGED → `building → merged` transition succeeds (regression guard).
14. PR head SHA does NOT match the merge commit on squash merge; the validator uses `mergeCommit.oid`, not head SHA.
15. Reverted PR → `ProjectIntegrityReconciler` transitions item to `regressed` on next GET; round status rolls back from `complete` to `regressed`.
16. Concurrent PATCH with stale `version` → 409 with version-only body; full record NOT returned.
17. Two-machine simulation: only owner machine fires auto-advance; non-owner skips; claim-ownership requires heartbeat >48h stale + 60s settle.
18. Git-sync conflict on project record → losing-side writes surface in `awaitingReconciliation`; auto-advance disabled until resolved.
19. Plan-doc with `source_docs: ["/etc/passwd"]` or `slug: "../etc/foo"` → rejected by parser.
20. Session-start hook reads cache file in ≤50ms; with missing cache, falls back to one-line "state unavailable" message.
21. Dashboard Projects tab renders correctly; Initiatives tab default-hides project-kind and parented items via server-side filter.
22. All deferred follow-ups (digest job, cross-project drift, PR-label auto-seeding, cross-machine drift-spend cap) exist as registered child initiatives in the same commit; `scripts/check-defers.sh` pre-commit hook rejects the commit if not.
23. Round-complete message via Telegram includes whatLanded, concreteNextStep, brakeHandlePhrase; absence → send rejected by tone gate. Pre-flight halt message includes empty-default whatLanded; presence enforced, not non-emptiness.
24. Stale-PID lock removed without server restart on next preflight.
25. Skipped item can transition back to `outline` via `/project advance <id> outline` with `unskippedAt`.
26. User skips item mid-round → autonomous run receives SIGTERM within 60s + 5s grace + SIGKILL; runner recomputes stop condition.
27. Cost ledger at `.instar/drift-spend-YYYY-MM-DD.jsonl` reserves estimated cost atomically before each call; concurrent calls at $0.97 boundary → second rejected (via advisory flock on `.instar/local/drift-spend.lock`).
28. `partially-complete` round → `POST /projects/:id/accept-partial` transitions to `complete-with-skips`; missing items become `skipped` with the supplied reason.
29. Round status `failed` after 3-attempt cap; auto-advance poller skips; only `/project resume --force` or `/project abandon` accepted.
30. `targetRepoPath` enforced on project creation; merge-commit reachability checked in that repo, not agent cwd.
31. All new tests green; tsc clean.
32. OpenClaw imports project surfaces correctly at session start and via `/project status`.
33. Two-machine simulation: concurrent edits to the same project record → merge driver populates `awaitingReconciliation`; no raw conflict markers in `.instar/initiatives.json` after merge.
34. Worktree allocation uses `git -C targetRepoPath worktree add ...`; worktrees live under target repo, not agent cwd.
35. Process-group SIGTERM/SIGKILL reaps autonomous spawned children (compilers, test runners).
36. Mid-round item skip → runner SIGTERMs, recomputes stop condition, loops back to step 4 (NOT step 6). Round stays `in-progress` unless natural autonomous exit.
37. claim-ownership returns 202 + operationId; finalization at settleAt; status pollable via `GET /projects/:id/ownership-claim/:operationId`.
38. Cost-ledger advisory lock prevents two concurrent drift-checks on different projects from both crossing the $1/day boundary.
39. `GET /projects/:id?reconcile=false` produces stable read with no state mutation.
40. Server first-start runs `git config --local merge.instar-initiatives.driver ...` if absent; refuses to start if `scripts/git-merge-driver-initiatives.js` is missing.
41. Autonomous child spawned with `detached: true`; `kill -- -PGID` of child group does NOT reap the runner.
42. `accept-partial` advances `lastAckedRoundIndex` to the closed round's index; does NOT increment `unacknowledgedAdvanceCount`.
43. `.worktrees/` automatically appended to `.git/info/exclude` on first allocation per target repo.
44. `claim-ownership` operationId is `crypto.randomUUID()`; operation records garbage-collected 1h after settleAt.
45. `resolve-conflict` writes audit row to `.instar/conflict-resolutions.jsonl` regardless of accept/reject.
46. Tracker's `reload()` (git-sync pull) path detects raw conflict markers at runtime and halts active runner with `awaitingUser`, not just at `load()`.

## Resolved design choices

The following are now normative (resolved in convergence):

- **Drift check model**: cheapest configured intelligence provider; consistent with other gates.
- **Round runner failure recovery**: in-progress + resume up to 3 attempts; `failed` thereafter; only `--force` resume or `abandon`.
- **Drift-check input size**: hard 5-file cap; over-budget → `manual-review-required`.
- **Cross-project drift**: deferred to Phase 2 as a same-PR-registered child; Phase 1 logs file-path overlap into a deferred-review queue (no blocking).
- **Drift check authority**: SIGNAL only; deterministic gate combines drift + artifact + ownership + brake state.
- **First-launch approval**: required at runner pre-flight (single chokepoint).
- **Auto-advance window persistence**: persisted ISO timestamp polled by existing tick.
- **`autoAdvance: false` location**: optional field on the project record; parseable from plan-doc frontmatter.
- **Dashboard separation**: server-side filter on Initiatives tab.
- **Telegram topic**: per-project `telegramTopicId` with fallback.
- **Lock file location**: `.instar/local/` (gitignored, machine-local).
- **Heartbeat mechanism**: `.instar/machine-health/<machineId>.json`, 30-min cadence, git-synced.
- **Merge-state check**: `gh pr view --json state,mergeCommit`; uses `mergeCommit.oid` for squash-merge correctness.
- **Working directory**: every git operation uses `targetRepoPath` explicitly via `git -C` or `cd`.

## References

- `OPENCLAW-IMPORTS-INDEX.md` — original Echo-side audit, source for one project
- `INITIATIVE-TRACKER-SPEC.md` — sibling spec; this builds directly on top of it
- `.instar/projects/openclaw-imports.md` — the project plan doc this spec is shaped to handle
- `/autonomous` skill — round runner delegates to this
- `/spec-converge` skill — each child item passes through this
- `/instar-dev` skill — each child item is built through this
- `docs/signal-vs-authority.md` — load-bearing principle P1
- MEMORY: `feedback_signal_vs_authority.md`, `feedback_no_out_of_scope_trap.md`, `feedback_worktree_default_for_shared_repos.md`, `feedback_finish_means_merge.md`, `feedback_gate_latency_vs_client_timeout.md`
