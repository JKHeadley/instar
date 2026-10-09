---
title: "Feedback Triage and Execution"
slug: "feedback-triage-and-execution"
author: "echo"
parent-spec: "docs/specs/feedback-factory-operating-drain.md"
approval-note: "Operator (Justin, topic 18330, 2026-10-06 22:47 PDT): 'we need a very intelligent model sorting and ranking and prioritizing, and a way to decide which issues are worth working on, which should be held for later and which should be ignored. Finally, we need a way to start actually tackling these tasks.'"
lessons-engaged: "Close the Loop; Judgment Within Floors; Body and Mind; Verify the State Not Its Symbol; Never Silently Cut the Data; Decision Provenance; Maturation Path; Bounded Blast Radius; Self-Heal Before Notify; The Stop Reason Is the Work; Near-Silent Notifications"
ships-staged: true
parent-principle: "Canonical Pipeline Operational Completeness — Accepted Intake Must Drain"
parent-principle-fit: "The feedback pipeline accepts reports and turns them into work items, then stops: 426 items had no terminal disposition and no consumer. This spec gives every work item a governed disposition (work, hold, ignore) decided by a registered frontier-model agent within deterministic floors, and a consumer that advances work items to a merged fix."
approved: true
approved-at: "2026-10-08T05:52:00.000Z"
approved-by: "operator standing grant"
approved-basis: "Operator request in topic 18330 (2026-10-06 22:47 PDT) for exactly this feature, plus the standing grant of 2026-10-03 10:15 PDT (Telegram msg 121996): 'do everything without my approval unless it is a change to the constitution'. This spec changes no constitutional standard. The ELI16 link is sent to the operator for visibility."
review-convergence: "2026-10-08T05:50:31.315Z"
review-iterations: 10
review-completed-at: "2026-10-08T05:50:31.315Z"
review-report: "docs/specs/reports/feedback-triage-and-execution-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 1
contested-then-cleared: 1
---

# Feedback Triage and Execution

## Problem

The operating drain (parent spec) turns feedback clusters into Initiative work items and stops there by design. Observed on the operated host on 2026-10-06:

- 1,041 reports, 767 clusters, 426 Initiatives created since 2026-10-02.
- All 426 Initiatives are `normal` priority. Priority is mechanical: `high` only when a cluster has 5+ reports. 417 of 426 clusters have exactly one report.
- All 426 are still on their first phase (`class-review`, pending). Nothing reads an Initiative after it is created.
- The readiness model sees only title, type, report count and dates — never the report text — so it cannot judge severity or value.

The pipeline therefore only grows. Close the Loop is violated at the last edge: an accepted work item has no path to a deliberate end.

## Goals

1. **Triage**: a frontier model reads each work item's scrubbed evidence and decides `work`, `hold` or `ignore`, with a severity, a priority score and a stated reason.
2. **Disposition**: `hold` and `ignore` take the item out of the active queue with the reason recorded. Held items come back on a timer or when the cluster gets new reports; ignored items come back when the cluster gets new reports.
3. **Execution**: a bounded executor takes the highest-ranked `work` items and starts a real build session on each, ending in a pull request that goes through the repository's normal review and merge path.

## Non-goals

- Changing clustering or the readiness authority. Triage runs after readiness, on Initiatives the drain already created. Holds and ignores never write readiness state, so they can never create a new readiness epoch or a duplicate Initiative.
- **Writing the legacy `Cluster.status` lifecycle or report statuses.** The parent spec reserves `Cluster.status` and every terminal product-outcome claim to the legacy curator. Triage keeps its own disposition record (§2) and never calls the `processor/transitions.ts` state machine.
- Fleet dispatch delivery (`dispatch/`). Unchanged.
- Bypassing repository review. Executor pull requests merge only through this feature's review gate (§4, step 9); repository rules, where present, are a second layer.
- A general workflow engine. The executor is purpose-built and closed: one fixed sequence over two tables in the parent's drain database, reusing the parent's lease, epoch-fencing and outbox patterns, with no user-defined steps. Its size comes from confinement. Alternatives considered: GitHub Actions runners (excluded — the operator runs verification locally and Actions are not part of this repository's path); containers or VMs (stronger isolation, but no container runtime is guaranteed on the operated macOS host and the agent's toolchain lives on the host); the job scheduler (no confinement). The OS sandbox is native on the host; a container-based confinement adapter can be added later and is eligible as soon as it passes the canary.

## Terms

- **Owner / owner epoch** — the drain's single fenced writer machine and its monotonically increasing ownership number (parent spec). A write carrying a stale epoch is refused.
- **Authority record** — a row in the drain store's `authority_records` table pinning provider, model family, prompt and schema version for one decision point; approved once by the operator with the dashboard PIN.
- **Clean-door reviewer** — the existing `claude -p` reviewer call used by spec review, here used as a second model family for spot checks.
- **Green-PR Auto-Merge / protected paths** — the existing watcher that merges green PRs through `safe-merge`, never merging changes to protected paths (`.github/**`, merge tooling) without the operator.
- **Attention item** — an entry in the existing operator attention queue.

## Design

### 1. Triage authority

New decision point `feedback-triage` (decision-quality census: `category: 'gate'`, `gating: true`, `injectionExposed: true`). It is a second authority record in `authority_records` (`decisionPointId: 'feedback-triage'`), proposed by a triage proposal builder alongside the existing readiness one and approved once through a new card on the dashboard Feedback Drain tab (operator PIN, the same mechanism as readiness). Until it is approved, the triage tick does nothing and `GET /feedback-factory/triage/summary` reports `authority: 'awaiting-approval'`. Default authority: the same `capable` routing as readiness (GPT-6 Astra via codex-cli on Echo).

**Input packet** per item. Every text field is scrubbed with `scrubForStore` (called directly, as `FeedbackDrainService` does, so it is never a dry-run no-op) and wrapped as untrusted evidence:

- cluster id, title, type, report count, first/last seen, recurrence count;
- report descriptions: newest first plus the first-ever report, up to `reportsPerItem` (default 4) reports and `charsPerReport` (default 1,200), keeping the first 800 and last 400 characters of a long report. Derivation: `maxBatchChars` divided by a target of 4 items, leaving room for neighbours and instructions. When anything is cut, the packet carries an in-band marker naming what is missing: `[evidence truncated: showing R of K reports; report N: middle C of T chars removed]`;
- titles and current triage dispositions of up to 8 nearest clusters by the existing similarity function (duplicate candidates);
- merged pull requests from the last 30 days whose body or commit messages contain the exact cluster id or a member report's feedback id (one `gh` list call per tick, matched in memory; on error the field is `unknown`, never empty).

**Batching.** Batches are bounded by total size, `maxBatchChars` (default 24,000), and reuse the readiness arbiter's chunking and stage-budget code. Derivation: the readiness log shows ~31 s for 10 short candidates against a 60 s stage budget; 24,000 characters keeps a batch near that observed size.

**Output** (JSON, schema `feedback-triage-decision-v1`), one row per item:

```
{ "clusterId": "...",
  "disposition": "work|hold|ignore",
  "reason": "duplicate|already-fixed|not-a-defect|out-of-scope|low-value|needs-evidence|actionable",
  "duplicateOf": "<clusterId>|null",
  "fixedBy": "<PR number from the packet>|null",
  "severity": "critical|high|medium|low",
  "effort": "s|m|l|xl",
  "needsSpec": true|false,
  "userFacing": true|false,
  "priority": 0..100,
  "confidence": 0..1,
  "summary": "<= 400 chars, plain language",
  "brief": { "component": "<= 80 chars", "symptom": "<= 300 chars",
             "expected": "<= 200 chars", "reproduction": "<= 400 chars" } }
```

`brief` is the only evidence the executor ever receives (§4). Every brief field is bounded by length caps and a printable-character class; there is no phrase denylist, because reproduction steps legitimately contain commands and URLs. This is hygiene, not authority and not the security boundary (§4): over-long or non-printable content is truncated with a marker; it never holds or blocks an item.

**Deterministic floors** (code, applied after the model answers, in the listed order; every floor that fires is recorded). Floors that test severity use the model's raw value.

1. Unparseable, incomplete or schema-invalid output → the batch is retried once, then its items stay untriaged. Nothing is ever defaulted to a disposition. Three consecutive unusable batches start the self-heal path in §6.
2. `confidence < 0.7` → `hold`, reason `needs-evidence`.
3. Never-ignore: an `ignore` of anything rated `severity: critical|high`, or whose evidence matches the credential-exposure pattern set or the keyword floor `security|vulnerab|data loss|corrupt|leak`, is not applied directly. It goes to a second opinion from a model of a different family than the triage authority (the clean-door reviewer when triage runs on a non-Claude model; any other available family otherwise) with the same packet. No second family available → `hold`. Second-opinion calls have their own sub-cap of 30 inside `maxCallsPerDay`, and the summary shows the keyword-floor hit rate, so spam carrying alarm words cannot quietly drain the budget. Both say ignore → applied as an ignore (subject to the shadow rule, §7). Otherwise → `hold`, reason `needs-review`. This floor applies on every path, including re-triage.
4. Truncated evidence cannot be ignored: an `ignore` of an item whose packet carries the truncation marker → `hold`, reason `evidence-truncated`. Such an item is re-triaged on the next tick alone, with per-item budget equal to `maxBatchChars`. If it is still truncated (roughly more than 20 reports), it stays held and un-ignorable — a problem that many reports describe is not dismissed on partial evidence. `work` on truncated evidence is allowed (it only queues work) and is marked `evidenceComplete: false` for the executor.
5. `duplicate` requires `duplicateOf` to name a packet neighbour that was decided in an earlier tick and whose disposition is `work` or `hold` (never an ignored item, never an item in the same batch, so no chains or mutual pairs); otherwise → `hold`.
6. `already-fixed` requires `fixedBy` to name a PR in the packet's exact-id list; otherwise → `hold`, reason `possibly-fixed`, 7-day review. Most human-authored fixes will not cite feedback ids, so this hold is the expected path for them: it is short, re-triaged, and a `work` decision for an already-fixed problem is also caught cheaply by the executor's reproduction step.
7. Single-report severity: `critical` on a one-report cluster keeps its severity, but ranks after every multi-report `critical` (reporter text is unauthenticated, so one report is weaker evidence of reach). The model's assessment is not overridden.
8. Ignore-rate brake (counts would-ignores, so shadow mode exercises it): over a rolling window of the last 100 decisions (evaluated only once ≥ 20 exist in the last 24 h), if the ignore share exceeds the shadow-period baseline by more than 25 percentage points, the next ignores become `hold`, reason `ignore-rate-brake`, until it falls back within 15 points. During the first 100 decisions, before a baseline exists, the threshold is a fixed 95%, because the initial backlog is mostly single-report items and a high ignore share there is expected. One degradation report per episode (dedupe key `feedback-triage:ignore-rate`). The brake catches a sudden change in model behaviour, not a junk-heavy backlog.
9. Stale-write guard: each decision is bound to the cluster's `reportCount` at packet time. If the count has changed when the decision is written, a `work` decision is still applied; a `hold` or `ignore` decision is not applied, and the item is re-triaged on the next tick with the new evidence (this first re-triage is exempt from the throttle in floor 10).
10. Re-queue throttle: an item is re-queued at most once per 24 hours, however many reports arrive. Re-triage calls have their own sub-cap of 50 inside `maxCallsPerDay`.

**Severity rubric** (in the prompt): critical = data loss, security exposure or the agent unable to function; high = a core path broken with no workaround; medium = a broken path with a workaround or a degraded experience; low = cosmetic or a request.

**Duplicates feed their target.** When a `duplicate` is applied, the duplicate's report count is added to the target's triage-side effective recurrence (a derived figure in the `triage` table; the cluster record is not touched), so the canonical item ranks higher as duplicates accumulate.

**Rank key** for the work queue: severity tier, then priority band (`priority` ≥ 67 / 34–66 / ≤ 33 — a model scalar is not calibrated across batches, so only bands are compared), then effective recurrence, then oldest first-seen. Reporter counts are not used, because reporter identity is self-asserted.

**Why a model for every item.** Reports are free text; recurrence, age and keywords cannot judge severity, reach or whether something is a defect. The cost is bounded by the call caps. A rules-first pre-filter was considered and is not adopted: the deterministic rule below is recorded only as a comparison baseline and never decides or routes an item.

**Comparison default.** Each decision row also stores what a fully deterministic rule would have chosen, from facts the model does not produce: `ignore` if one report, older than 30 days and no keyword-floor match; `hold` if one report and newer; `work` otherwise. This, and a second baseline "hold everything", are what the model is measured against; precision of `work` decisions is reported on its own.

**Spend.** `maxCallsPerDay` (default 150) is counted in the drain's existing `authority_daily_usage` table for the triage authority. Triage also pauses while the subscription pool reports the account serving the triage call at ≥ 75% of either usage window, or cannot report it (the operator's Codex limit is 80%).

### 2. Disposition record

Triage state lives in new tables in the existing `feedback-drain.db` (owner-epoch fenced, inside the parent's backup set):

- `triage` — one row per Initiative: cluster id, disposition, reason, severity (stored and raw), priority, confidence, brief, rank key, floors fired, rule-default disposition, bound report count, hold count, `nextReviewAt`, `notifiedAt`, decided-at, authority epoch, packet reference.
- `execution` — one row per executor attempt (§4).
- Packets are stored under `state/feedback-factory/store/triage-packets/` (inside the backup set), 14-day retention, never served raw over HTTP, keyed by the log row's packet reference.

| Disposition | Triage row | Initiative |
|---|---|---|
| work | `work`, enters the ranked queue | stays `active`; `class-review` phase → `done` |
| hold | `hold`, `nextReviewAt` = now + 14 days (7 for `possibly-fixed`) | `paused` |
| ignore (any reason) | `ignored`, no timer | `paused` |

`paused` is reversible through the existing Initiative API; no disposition uses `archived` or `abandoned`, which are terminal. "Archived" in the operator's sense is the `ignored` disposition: off every queue, still readable, with its reason.

**Coming back.** Each triage tick first re-queues (subject to floor 10): held items whose `nextReviewAt` has passed, and held or ignored items whose cluster `reportCount` is now higher than the bound count. Re-queued items get a fresh packet and decision; their Initiative returns to `active` if the new decision is `work`. An item held three times is re-triaged with its hold history in the packet as a signal; no counter decides a disposition. After the third hold the review interval doubles each time (28, 56, then a 90-day cap) — a schedule, not a disposition.

Every hold reason has a defined trigger for coming back and an owner:

| Hold reason | Comes back on | Owner / visibility |
|---|---|---|
| `needs-evidence`, `ignore-shadow`, `possibly-fixed`, `evidence-truncated` | timer or new reports | agent; summary counts |
| `needs-review` (never-ignore floor) | timer or new reports | agent; action list when serious or multi-report |
| `execution-failed`, `not-reproducible`, `merge-unavailable` | new reports, or operator instruction in conversation | operator informed once via action list |
| `needs-review-tooling` | operator instruction in conversation | operator; action list |
| `needs-review-secret-shape` | operator approval through the dashboard PIN plan/commit flow (Frontloaded #7) | operator; action list |
| `ignore-rate-brake` | brake episode ends | agent; degradation report |

**Work-queue ceiling.** A `work` item not started by the executor within 30 days is re-triaged (subject to floor 10); the summary shows queue depth and the oldest item's age. The 30-day clock is paused while the executor is unavailable for a reason unrelated to the item (`approver-not-independent`, `profile-unenforceable`, `deps-unavailable`, `no-source-repo`, `auto-merge-disabled`).

**Operator changes win.** If the operator changes a feedback Initiative's status directly (for example reactivating a paused one), the next tick records that as an operator override on the triage row and re-queues the item for triage with the override in its packet; triage never silently reverts an operator's change.

**Initiative digest.** Feedback-linked Initiatives (those with a `feedbackWorkKey`) are excluded from the per-Initiative `ready-to-advance` and `stale` digest flags and shown as one summary line with counts and a link to the triage queue, so the queue cannot flood the digest.

**Audit.** Every decision, floor and transition appends to `logs/feedback-triage.jsonl` (ids, dispositions, reasons, scores, floors — no report text; rotated at 20 MB, 90-day retention).

**Grading** (decision-quality meter). Grades carry an evidence strength; headline metrics use only `strong`, and `medium`/`weak` are reported separately.
- `ignore` / `hold`: a later `work` decision after new reports arrive is recorded as `superseded`, not as `wrong` — the original decision did not see that evidence. A weekly sample of up to 10 ignore and would-ignore decisions (25 during shadow) is re-judged by a second model family on the same evidence the original saw: agreement → `right` (medium), disagreement → `wrong` (medium). After 30 quiet days: `right` (weak), reported separately and excluded from every graduation threshold.
- `work`: the confined failing-then-passing check is a publication gate, not a grade (the session wrote both test and fix). `right` (medium) when the operator approves the PR; `right` (strong) once it merges and its `verify` phase completes; `wrong` (weak) when two attempts end `not-reproducible`; infrastructure failures grade `unknown`. Merge outcome is recorded separately and is not a triage grade.

### 3. Ranked queue and status

- `GET /feedback-factory/triage/queue` — `work` items in rank order: id, title, summary, severity, priority, execution state (`queued` / `running` / `spec-pr-open` / `pr-open` / `merged` / `failed`), PR link.
- `GET /feedback-factory/triage/summary` — counts by disposition and reason, authority state, last tick, pause/self-heal state, floors fired today, rule-default agreement, calls used today.
- `POST /feedback-factory/triage/tick` and `POST /feedback-factory/execute/tick` — Bearer, owner-only, rate-limited, single-flight. A non-owner answers 409 naming the owner; the jobs treat 409 as a healthy no-op.
- The Feedback Drain dashboard tab gains a "Triage" section rendering the queue and summary in plain language, and the authority approval card.

### 4. Executor

Runs only on the drain owner, and only where `feedbackFactory.execute.sourceRepoPath` (default: the agent home when it is a git checkout of the instar source) is a checkout of the repository the feedback is about; otherwise the execute routes answer 503 with `reason: 'no-source-repo'`. The feedback factory collects feedback about Instar, so today that is the Instar repository; nothing in the executor is Instar-specific beyond that setting. Built-in job `feedback-factory-execute` (every 30 min, supervision tier1) calls the execute tick.

**Division of trust.** Everything that executes code from the attempt — the build session itself, the tests it wrote, the repository's lint and test gate — runs confined: no network, no credentials, no reads outside the attempt workspace and the read-only toolchain. Only trusted executor code holds credentials, and it never executes anything the session could have influenced: it never runs git (or any tool) inside the session's workspace. It reads changed files as plain bytes, copies them into a separate clone it created itself, and commits and pushes from there with hooks, external helpers and repository-local config disabled.

1. **Admission** (enforced in the executor's own code; SelfActionGovernor class `feedback-execute` registered for telemetry only): at most `maxConcurrent` (default 2) running attempts; at most `maxStartsPerDay` (default 6); at most `maxOpenPrs` (default 4) executor PRs awaiting review; spawn limiter not saturated; quota load-shedding inactive; no agent update pending.
2. **Claim**: CAS insert into `execution` with the current owner epoch, attempt number and a 6 h lease. A claim under a stale epoch is refused. Before attempt n > 1 the executor stops any earlier attempt's session by its recorded session id (through the existing remote-close route when that session ran on a previous owner).
3. **Workspaces**: trusted code fetches `origin/main` in `sourceRepoPath` and records the base SHA. It creates two standalone clones at that SHA under `<agent home>/.worktrees/`: the **session workspace** `feedback-<initiative-id>-a<n>/` (the session's only writable tree; its `.git/` is read-only to the session) and the **publish clone** `feedback-<initiative-id>-a<n>-publish/`, which the session can neither read nor write. Dependencies: trusted code keeps a dependency cache per lockfile hash under `<agent home>/.worktrees/.feedback-deps/<hash>/`, built from the base SHA's lockfile with `pnpm install --frozen-lockfile --ignore-scripts`, followed by building only a pinned allow-list of native dependencies from the base SHA (`better-sqlite3` and `sqlite-vec` via `pnpm rebuild`, then the repository's `scripts/fix-better-sqlite3.cjs` from the base SHA) inside the sandbox runtime. During this rebuild step only, network is limited to the npm registry, GitHub release-asset hosts and `nodejs.org` (for prebuilt binaries and headers); when the agent home already has a built binary for the same module version and Node ABI, it is copied instead and no network is used. No script from any feedback branch ever runs during install. The session workspace's `node_modules` is a read-only symlink to the cache. The cache keeps the two most recent lockfile hashes plus any in use by a running attempt; older ones are evicted through `SafeFsExecutor`, and the summary shows the cache size. If the install fails, the executor shows `deps-unavailable` in the summary within 300 s, retries with backoff (30 min, 1 h, 4 h), and raises one Attention item when the retries run out. Tool caches (vitest, esbuild) point at the attempt's own temp directory (`TMPDIR`). Every attempt gets its own fresh clones; a stopped session from an earlier attempt can never write into a later attempt's workspace. The scrubbed report evidence for the cluster (the same scrubbing as the triage packet, with in-band truncation markers) is written by trusted code as a read-only data file `.feedback-evidence.json` in the session workspace. Both clones are removed by the executor through `SafeFsExecutor` when the attempt ends, after the transcript reference is recorded.
4. **Confinement profile** — one policy, applied in two ways:
   - *Policy*: writes only in the session workspace (excluding its `.git/` and `.feedback-evidence.json`), its temp directory and the host test-runner holders file (so the concurrency cap keeps working); reads denied for the agent home except the session workspace and the dependency cache, and for `~/.config`, `~/.ssh`, the Claude and Codex credential directories and keychain paths; no network (empty allowlist, strict).
   - *Build session*: launched with new `SessionManager.spawnSession` options — `cwd` (limited to paths under `<agent home>/.worktrees/`), `omitAuthEnv` (drops `INSTAR_AUTH_TOKEN` and vault variables), and a framework confinement adapter. For `claude-code` the adapter writes the policy as a `--settings` file enabling the OS-level sandbox for Bash and child processes (`sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`) plus permission rules denying Read/Edit/Write outside the workspace, edits to the workspace's `.claude/`, WebFetch, WebSearch and MCP. At ship, `claude-code` is the only framework with an adapter that meets the policy; Codex's `workspace-write` sandbox limits writes and network but not reads, so `codex-cli` becomes eligible with an adapter that wraps the Codex session in the sandbox runtime and passes the canary. Eligibility is decided by the canary, not by framework name; an agent without an eligible framework sees the executor as `profile-unenforceable` while triage still works fully. This is an accepted, stated gap against Framework-Agnostic: confinement is a safety floor and no other framework meets it yet.
   - *Executor-run commands* (tests at base and head, the lint and test gate, and any `git status`/`git diff` the verification needs): run inside the session workspace through Anthropic's open-source sandbox runtime (`@anthropic-ai/sandbox-runtime`, the same OS mechanism Claude Code uses; a new, exactly pinned dependency) with the same policy, and with `omitAuthEnv`.
   - Resource limits on every confined command: wall-clock timeout (session: the lease; each test or gate run: 20 min), output captured up to 5 MB, workspace plus temp directory capped at 2 GB (checked between steps), and the host test-runner limiter for concurrency. A limit hit maps to `failed` with the limit named.
   - If the needed sandbox is unavailable, the executor refuses to start (`profile-unenforceable`).
5. **Confinement canary**, before each attempt, under both application paths. Must FAIL: reading the agent's config file from Bash and from a Node script; an outbound fetch from a Node script; a Bash write outside the workspace; a Write-tool write and a Read-tool read outside the workspace. Must also FAIL: a write to the session workspace's `.git/config`, and any access to the publish clone. Must SUCCEED: `git status` and `git diff` in the workspace, one test that opens a SQLite database, and, once per canary version stamp and dependency cache, the full lint and unit gate on the unmodified base (so an environment that is always red cannot masquerade as a failing fix). Any wrong result → `profile-unenforceable`, one Attention item per episode. The canary records the framework and sandbox-runtime versions it ran against; a version change forces a fresh canary.
6. **Prompt**: a fixed template containing only the Initiative id, cluster id, severity, the triage `summary` and `brief`, `evidenceComplete`, and the paths of the evidence and result files. Report text is not in the prompt, but it does reach the session's context when it reads `.feedback-evidence.json`; the safeguard is not prompt hygiene but confinement plus the diff, secret and human-review gates on the session's only output. Instructions: reproduce the problem with a failing test; if it cannot be reproduced, write the result file with `not-reproducible` and stop; if `needsSpec` is false, fix it and leave the changes uncommitted in the workspace; if `needsSpec` is true, write a spec draft under `docs/specs/` only. The session does not commit, push or use `gh`. `maxDurationMinutes` ≤ the lease.
7. **Result file**: `.feedback-result.json` at the workspace root: `{ outcome: 'fixed'|'spec-drafted'|'not-reproducible'|'gave-up', testFiles, testName, notes ≤ 1,000 chars }`. Missing or invalid → `failed`.
8. **Verification and publication** (trusted code orchestrates; every command that executes workspace code runs confined, step 4):
   - Change set: trusted code walks the session workspace (excluding `.git/`, `node_modules`, the evidence and result files) using `lstat` and no-follow opens; any symlink, device or other special file in the change set makes the attempt `failed` (reason `special-file`). It compares plain file bytes against the publish clone and builds the change set (added, modified, deleted files; at most 200 files and 2 MB). It runs no git and no tool in the session workspace.
   - Diff gate: a change set touching tooling or protected paths (`.husky/`, `scripts/`, `package.json`, lockfiles, test-runner configs, `.github/`, `.claude/`, `.gitattributes`, `.gitmodules`) is not published; the item moves to `hold`, reason `needs-review-tooling`, and appears in the action list.
   - Secret gate: the credential-exposure pattern set (`CredentialAuditEmit` / `DurableOutputScrubber` patterns) runs over every changed file, the result `notes` and the PR title and body. A match is a signal, not a verdict: nothing is published automatically, the item moves to `hold`, reason `needs-review-secret-shape` (matches confined to `tests/` fixtures are common in this repository), and the action list carries it with the matched file names (never the matched text). It stays held until the operator approves publication through the dashboard PIN plan/commit pattern; a conversational request only produces that plan. The trusted path then publishes it and records the PIN-bound approval.
   - `fixed`: (a) in a third, throwaway clone at the base SHA with only the changed files under `tests/` copied in (test files and test-support helpers), the named test must fail with an assertion failure, or with a missing export or module whose path is a source file in the change set (a test of a newly added function); any other import or compile error fails the check; the clone is deleted afterwards; (b) at the workspace state it must pass; (c) the repository's lint and unit gate must pass. All confined. Then trusted code writes the change set into the publish clone and commits and pushes branch `feedback/<initiative-id>-a<n>` from there with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, `--no-verify`, no external diff or textconv, and an explicit GitHub remote URL (the clone's own `origin` is the local source path). The hooks' checks already ran confined in (c). It opens the PR with `gh` and records the PR number and head SHA. Trusted code never runs `checkout`, `merge`, `rebase` or any other hook-capable git command against a tree the session touched. Any failure → `failed`.
   - `spec-drafted`: the change set must be exactly one new file `docs/specs/feedback-<initiative-id>.md` whose frontmatter carries no `review-convergence`, `approved` or related tags; trusted code publishes it the same way as a docs PR (`spec-pr-open`).
   - `not-reproducible`: recorded as the session's claim (weak evidence only).
9. **Outcome** (each tick; a `gh` error leaves the state unchanged and is reported as `unknown`):
   - **Review gate** (build and spec PRs; enforced by this feature, because `JKHeadley/instar`'s `main` ruleset does not require approval in general — it requires code-owner review on owned paths only).
     - *Who counts as the approver*: the repository owner's GitHub login when the repository is user-owned (read from the GitHub API each tick, so no agent-writable setting chooses it); for an organization-owned repository, a login set only through the dashboard PIN. Each tick the executor refuses to run (503 `approver-not-independent`) if that login equals the agent's own GitHub login, or appears as an account in the Playwright profile registry or as a tagged vault entry — i.e. if the agent itself could act as the approver. The operator can accept that condition only through the dashboard PIN plan/commit pattern (the agent renders the exact acceptance; the operator approves it with the PIN; the record binds to the PIN-authenticated session, never to a chat message, because the agent can post messages through the operator's own account). The executor then runs, and sessions spawned by this feature can never activate a browser profile holding the approver's account. On Echo today the profile registry lists `JKHeadley` (GitHub, operator-owned), so the executor starts in `approver-not-independent` and the question goes once into the first action list.
     - *Gate*: executor PRs open ready-for-review on branch `feedback/<initiative-id>-a<n>`, outside Green-PR Auto-Merge's namespace, with the existing `hold` label so that Green-PR Auto-Merge never arms them (the label does not stop a merge already armed in GitHub; the `--match-head-commit` pin and `--disable-auto` on every stop path do). Each tick, trusted code looks for an approving review by the approver whose commit is the PR's current head SHA; approvals by any other account are ignored. Start-of-tick checks also require the repository to allow auto-merge (503 `auto-merge-disabled` otherwise), so no PR is produced that can never merge. At PR creation the change set is checked against `.github/CODEOWNERS`; if a path needs an owner other than the approver, the action-list item says so.
     - *Merge*: once the approval is found, trusted code removes `hold` and runs `safe-merge --auto --match-head-commit <approved SHA>` (never `--admin`), so GitHub merges only that exact head once the repository's required checks pass, and refuses if anything was pushed after the approval. `safe-merge` exit 0 (merged) and 3 (already merged) → `merged`; exit 5 (armed: GitHub will merge once required checks pass) → `merge-armed`, starting a 24 h deadline, with the merge confirmed on later ticks by the PR's `mergedAt` being set and its `headRefOid` equalling the approved SHA (independent of squash or rebase merge commits). Exits 1 and 2, and a passed deadline, map to `merge-refused:<reason>` (e.g. `head-moved`, `reviews-required`, `checks-failed`, `deadline`); retried once after 1 h, then the item moves to `hold`, reason `merge-unavailable`, and is listed once in the action list. Every stop path for an armed PR — the operator's hold or stop, `enabled: false`, a stale epoch, re-triage away from `work`, `merge-refused` — runs `gh pr merge <n> --disable-auto` and records whether it worked; a failure to disarm is its own Attention line.
     - *Merged elsewhere*: if a PR is merged by anyone else, or at a head without a recorded approver approval, one Attention item is raised and `verify` cannot become done until the approver's approval of the merged SHA is recorded (it can be given after the fact). This is detection only; people with merge rights can still merge by hand.
   - Build PR merged → `merged`. Initiative `spec` (done, "not needed" recorded) and `build` → `done`. `verify` stays pending: the confined failing-then-passing check proves the test, not that the reported failure stopped (Bug-Fix Evidence Bar). `verify` → `done` only when the fix has shipped in a release (a release tag contains the merge commit, per `git tag --contains`; undeterminable → stays pending) and the cluster has received no new matching report for 30 days after that release; a new report reopens the item for triage instead. When triage marked the item user-facing, `verify` additionally requires a run of the existing live-user-channel test harness (Live-User-Channel Proof): the executor spawns a normal trusted session for it once the release-plus-30-days condition holds; a FAIL reopens the item for triage (reason `live-proof-failed`); if the harness cannot run, `verify` stays pending and the summary counts it. All phases done → the tracker marks the Initiative `completed`.
   - Spec PR merged through the review gate → the spec path continues. The executor then spawns a normal, trusted session that runs `/spec-converge` on the merged draft, with an instruction to flag any operational instructions in the draft (commands, URLs, credential references) as findings. That session is not confined: it reads text that originated in untrusted reports, after the operator reviewed it. This residual risk is accepted by name; it is bounded by the draft's one-file shape, the operator's review of the draft, and the operator's second review of the converged spec. The converged spec is opened as its own PR; the operator's approval of that PR is its `approved: true`. Building it then follows the normal `/instar-dev` Tier 2 path outside this lane.
   - `failed` → one retry, then the triage row moves to `hold`, reason `execution-failed`, with the transcript reference. `not-reproducible` twice → `hold`, reason `not-reproducible`. After a second `execution-failed` or `not-reproducible` episode for the same item, re-triage may no longer send it to the executor automatically; it is listed once in the action list (informational) and stays held until new reports arrive or the operator tells the agent what to do with it in conversation.

**Merging** happens only through the review gate: the executor merges a PR only at the exact head the operator approved, pinned with `--match-head-commit`; tooling and protected paths never reach a PR (diff gate). The human review is required by this feature because these PRs are code produced from untrusted external text — the self-unblock rung floor (policy-sensitive; capability ≠ authority) and Bounded Blast Radius make it a constitutional floor rather than a default-approver choice. It costs one batched tap per PR.

### 5. Operator surface

The queue, summary, merges and agreement figures are a pull surface: the dashboard Triage section and the GET routes. Nothing routine is pushed.

The only proactive message is an **action list**, sent by built-in job `feedback-factory-action-list` at most once a day at 08:00 in the agent's configured timezone (host timezone when unset), never between 23:00 and 07:30 (enforced in code), to `feedbackFactory.execute.actionTopicId` (the Attention hub when unset). It is sent only when there is something new needing the operator, each with a direct link:
- a build PR or spec PR awaiting the operator's approval;
- `needs-review` holds where the model rated `critical`/`high` or the cluster has ≥ 2 reports (other `needs-review` holds appear only as a count with a link to the queue).

Each item is stamped `notifiedAt` when sent and never sent again. A message carries at most 10 items; anything beyond that is one count line with a link to the queue, so a burst of reports cannot flood the operator.

### 6. Self-heal before notify (triage outages)

This ladder only re-probes (one canary batch); it mutates no drain state, so it is not one of the drain-recovery workflows the parent spec assigns to the shared SelfHealGate; once that gate exists, this ladder is expressed through it. When floor 1's three-consecutive-failure trigger fires, triage does not pause for the operator. Self-heal: re-probe the authority with one canary batch after 30 min, 1 h, then 4 h (`max-attempts: 3`, `max-wall-clock: 5.5 h`, dedupe key `feedback-triage:authority-unusable`, breaker: 3 episodes in 7 days escalate immediately as flapping, audit in `logs/feedback-triage.jsonl`). Within 300 s of the trigger (`max-notification-latency: 300s`, the `standards.selfHealBeforeNotify.recoverableLatencyCeiling`), the summary shows `authority: 'self-healing'` and one degradation-report row is written — a low-noise status, no push. A successful canary resumes triage silently. Exhaustion of the ladder raises one Attention item. A model/prompt/schema mismatch with the approved authority is not recoverable and raises the Attention item immediately (it needs a new approval).

### 7. Shadow ignore

On the development agent, `ignore` starts in shadow: a would-ignore is applied as `hold`, reason `ignore-shadow`, with the would-ignore reason recorded. During shadow the weekly cross-family sample is 25 decisions. When ≥ 30 shadow ignores carry medium-or-strong grades with ≤ 10% wrong, the summary reports `ignoreLiveRecommended: true`. The recommendation then goes once into the action list with its evidence (strong and medium grades reported separately); ignore goes live when the operator approves it through the dashboard PIN plan/commit pattern (a conversational request only produces the plan); the PIN-bound record sets `feedbackFactory.triage.ignoreLive: true`. It is reversible.

`work` and `hold` are not shadowed: neither loses information or takes an external action by itself (`work` only queues the item for the executor, whose output still needs human review to merge), and `hold` is the conservative default. Their decisions are still compared against both baselines from day one.

## Configuration and rollout

`feedbackFactory.triage` and `feedbackFactory.execute` blocks, registered in `DEV_GATED_FEATURES` (live on a development agent, dark on the fleet). Fields: `enabled`, `dryRun`, `ignoreLive` (false), `maxBatchChars` (24,000), `reportsPerItem` (4), `charsPerReport` (1,200), `maxCallsPerDay` (150), `sourceRepoPath`, `actionTopicId`, `maxConcurrent` (2), `maxStartsPerDay` (6), `maxOpenPrs` (4).

**Build order.** Two phases, each its own PR:
1. Phase 1 — triage, disposition, ranked queue, operator surface, PIN plan/commit routes, self-heal (§1–§3, §5–§7). This alone delivers ranking, work/hold/ignore and closure.
2. Phase 2 — the executor (§4). Before its PR merges, one focused review round (security and adversarial reviewers plus a cross-model pass) runs against the built executor code, not just this text, because the executor's safety rests on how the sandbox, git and GitHub behave in practice.

**Maturation:**
1. Test rung: a throwaway agent (`/test-as-self`) runs the full lifecycle against a fixture backlog — ingest → readiness → Initiative → triage (each disposition and every floor) → executor claim → restricted spawn → fixture PR outcome.
2. Development agent (Echo): after the one-time authority approval, `work` and `hold` live, `ignore` in shadow (§7), executor live (every build PR still needs human approval to merge). The 426-item backlog drains at the triage cadence (every 15 min) within `maxCallsPerDay`, ordered so that each group of similar clusters is triaged oldest-first across successive ticks, letting the canonical item be decided before its duplicates.
3. Fleet: triage graduates only after at least 14 days and at most 60 days on Echo with ≥ 40 medium-or-strong grades in total, ≥ 30 medium-or-strong ignore grades with ≤ 10% wrong, and fewer `wrong` grades than both baselines; weak (quiet-timeout) grades never count. If 60 days pass without the evidence, the summary says so and triage stays development-only. The executor graduates only to agents that are operated feedback hosts with a source checkout; it stays unavailable elsewhere by construction.

## Maturation plan

- **test-agent-live:** a throwaway agent (`/test-as-self`) runs the full lifecycle against a fixture backlog before either phase merges: ingest → readiness → Initiative → triage (each disposition and every floor) → for Phase 2, executor claim → confined spawn and canary → fixture PR outcome.
- **dev-agent-live:** Echo, after the one-time triage-authority approval: `work` and `hold` live, `ignore` in shadow (§7); the executor live once its preconditions hold (on Echo that includes the PIN-bound acceptance of `approver-not-independent`). Every executor PR still needs the approver's GitHub approval to merge.
- **fleet:** triage only, and only after the graduation criterion holds; the executor graduates only to operated feedback hosts with a source checkout and stays unavailable elsewhere by construction.
- **graduation criterion:** at least 14 and at most 60 days on Echo with ≥ 40 medium-or-strong grades in total, ≥ 30 medium-or-strong ignore grades with ≤ 10% wrong, and fewer `wrong` grades than both baselines; weak grades never count. If 60 days pass without the evidence, triage stays development-only and the summary says so.
- **dark-window:** fleet-dark (dev-gated) until the graduation criterion holds; ignore stays in shadow until the PIN-bound `ignoreLive` approval.

**Rollback:** `enabled: false` on either block. Rows stay readable; paused Initiatives stay paused and can be reactivated; nothing is deleted.

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| `feedback-triage` disposition, severity and priority | judgment-candidate | Arbiter: registered frontier-model triage authority. Floor: closed schema; invalid → untriaged; floors 2–10; every disposition reversible; ignore in shadow until evidenced; fully deterministic rule default recorded; fallback ladder ends at "leave untriaged and self-heal/report". |
| Never-ignore second opinion | judgment-candidate | Arbiter: second model family. Floor: disagreement or failure → hold. |
| Re-queue on timer or new reports | invariant | Deterministic timer, report-count comparison and 24 h throttle; the decision itself returns to the judgment point. |
| Executor admission | invariant | Deterministic caps, epoch fencing, spawn limiter, quota shedding, open-PR cap. |
| Executor outcome | invariant | PR identified by recorded branch and verified author; approved-head SHA match; lease expiry; `gh` error → unknown. |

## Multi-machine posture

- Triage and execution tables, packets, log: **unified** — single authoritative writer, the drain's fenced canonical owner (`isCanonicalOwner()`, owner epoch), stored in the backed-up `feedback-drain.db` directory. Ticks run only on the owner; elsewhere they answer 409 naming the owner. GET routes on a non-owner fetch the owner's response over the authenticated peer transport the existing `?scope=pool` routes use; when the owner is unreachable they serve the last fetched copy tagged `stale: true` with its age, or 503 naming the owner if none exists.
- Executor sessions run on the owner; their PRs land in the shared remote, so results are pool-visible. Claims are epoch-fenced and earlier attempts are stopped before retries, so an ownership change cannot run two builds for one item.
- No machine-local surface is introduced.

## Signals and what they prove (P20)

| Symbol | Claimed state | Corroboration | Unmeasurable |
|---|---|---|---|
| model disposition | item is / is not worth work | floors; re-triage on new reports; weekly cross-family sample; recurrence grading | invalid output → untriaged |
| `fixedBy` PR | problem already fixed | exact cluster/feedback id in the PR; item only parked and returns on any new report; grade stays `weak` until 30 quiet days | `gh` error → `possibly-fixed` hold |
| PR on recorded branch merged | the fix landed as reviewed | verified author; merged head = approved head; failing-then-passing test for `verify` | `gh` error → unchanged, `unknown` |
| call count / Codex usage | spend within caps | `authority_daily_usage` row; `/codex/usage` windows | unreadable → triage pauses |

## Frontloaded Decisions

1. Triage and executor never write `Cluster.status` or report statuses.
2. Hold and ignore both map to Initiative `paused`; no terminal Initiative status is used.
3. Spec-needing items: the confined session drafts a spec; the executor opens it as a docs PR; after the operator's GitHub approval it leaves the untrusted lane and is converged and built through the normal trusted path.
4. Every executor PR (build and spec) is merged only by the executor, at the exact head SHA approved by the repository owner's GitHub login (PIN-set login for organization repositories), via `safe-merge --auto --match-head-commit`; the executor refuses to run if the agent could itself act as that login; the action list carries each link once.
5. Triage model: the readiness `capable` routing; second opinion: a different model family; executor: Claude Code (the only framework whose confinement adapter meets the policy at ship); other frameworks join when an adapter passes the canary.
6. The triage authority needs one operator approval tap on the dashboard before triage runs; it reuses the readiness authority mechanism, including its PIN (a later change to that mechanism applies to both). It is placed in the first 08:00 action list.
7. Three operator authorities use the dashboard PIN plan/commit pattern, never a chat confirmation: accepting `approver-not-independent`, publishing a `needs-review-secret-shape` change set, and turning `ignoreLive` on. The routes are `POST /feedback-factory/triage/plan` (Bearer; renders the exact action, `action` ∈ `accept-approver-dependence` | `publish-secret-shape` | `ignore-live`) and `POST /feedback-factory/triage/commit` (dashboard PIN + plan id + nonce), surfaced as buttons in the dashboard Triage section. The PIN is required here despite the operator's general preference against PINs where the Bearer token already authorizes, because the agent holds the Bearer token and these are authorities it must not grant itself (Know Your Principal). On Echo (which holds `JKHeadley`) the executor waits for the first of these; triage is unaffected.
8. Numeric defaults as listed under Configuration. Cheap-to-change-after: read live and bounded by caps; no durable external effect depends on the exact values.
9. Development agent: work/hold live, ignore in shadow, executor live once its preconditions hold; the fleet waits for the graduation evidence above.

## Open questions

*(none)*

## Agent awareness and migration

- CLAUDE.md template: a "Feedback triage and execution" entry with the queue and summary routes and proactive triggers ("what are we working on from feedback?", "why was this report ignored?").
- `migrateClaudeMd()` content-sniffed section. Config defaults resolve in code through the dev gate. The three built-in jobs (`feedback-factory-triage`, `feedback-factory-execute`, `feedback-factory-action-list`) install through `installBuiltinJobs`, which the post-update migrator already calls.
- The tick routes and jobs are enrolled in `CANONICAL_INTAKE_SURFACES` (`canonicalPipelineRegistry`) as stages of `feedback-factory`.

## Testing

- Unit: every floor on both sides; rank key; stale-write guard and re-queue throttle; rolling ignore-rate brake; rule default; disposition → Initiative mapping; brief sanitisation; executor admission, epoch-fenced claim, settings-file construction, result-file parsing, confined failing-then-passing verification (assertion-failure check at base), tooling-path diff gate, byte-level change set into the publish clone, secret gate, hooks/config-disabled commit and push (a planted hook and a planted `.git/config` never run), single-new-file spec check, approver derivation and independence check, head-SHA-matched approval, pinned merge with every refusal mapped to a state, merged-elsewhere detection and after-the-fact clearing, workspace cleanup, outcome reading (recorded PR, approved-head rule with main-merge allowance, `gh` error), retry → hold; action-list once-only and quiet window; self-heal ladder.
- Integration: the four routes and the authority card; triage with a fake intelligence provider returning valid, invalid, low-confidence, critical-ignore, truncated-ignore, chain-duplicate and runaway-ignore outputs; the confinement canary's must-fail probes fail and must-succeed probes succeed in the real launch modes (Claude Code, Codex, sandbox runtime), and the executor refuses to start when a sandbox is unavailable.
- E2E lifecycle: production construction path — ingest → readiness → Initiative → authority approved → triage → (ignore → shadow hold → paused) and (work → executor claim → spawn recorded → fixture PR merged with matching head → Initiative completed); routes 200 when enabled, 503 when dark or without a source repo.

## Side effects and risks

- **Prompt injection from report text.** Report text reaches only the triage model, as quoted evidence; the model cannot choose ids, routes, sessions or commands. The executor session reads scrubbed reports only as a data file, never in its prompt; it and every command that runs its code (tests, lint, gate) are OS-sandboxed with no network, no credentials and no reads outside the workspace, verified by a canary before every attempt; trusted executor code holds the credentials and never runs git or any tool in the session's workspace — it copies changed files as bytes into its own clone, refuses tooling-path and secret-bearing changes, and pushes with hooks and repository config disabled; and nothing it writes is merged by the executor except at the exact head the operator approved. The brief is still shaped by attacker text, so it can describe a misleading problem; the confinement and the review are the safeguards, not the brief check.
- **Approver independence after acceptance:** once the operator accepts `approver-not-independent`, the review gate is structural for this feature's sessions, but any other full-tool agent session that opens the approver's browser profile could technically submit an approval. No existing log reliably records that (profile activations are logged, but direct browser launches against a profile folder are not), so this residual risk is accepted by name as undetected; the PIN-bound acceptance record states it.
- **Cost:** triage capped by daily calls and Codex usage; executor bounded by concurrency, daily starts, open-PR cap, spawn limiter and quota shedding.
- **Wrong ignore:** reversible, re-triaged on new reports, never applied to high-severity, security-shaped or truncated items without a second model family, rate-braked, shadowed until evidenced, and sample-audited weekly.
- **Spam:** unauthenticated reports can trigger re-triage at most once a day per item, cannot raise severity above `high`, and reach the operator's action list only when serious or multi-report.
- **Executor churn:** one retry, then hold with the transcript reference.
