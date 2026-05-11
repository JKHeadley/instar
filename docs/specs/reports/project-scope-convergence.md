# Convergence Report — Project Scope

**Spec:** `docs/specs/PROJECT-SCOPE-SPEC.md`
**Iterations:** 5
**Final verdict:** CONVERGED — all 7 reviewers report zero material new findings
**Completed:** 2026-05-11
**Branch:** `feat/project-scope-spec`

---

## ELI16 Overview

Today the agent has a tracker for one feature at a time. It works fine when you're shipping one feature. But when you have nineteen related features that need to ship over weeks — like the OpenClaw imports we just triaged — the tracker can't see the whole list. The first few features get attention, and the rest get forgotten. We've watched this happen twice. The OpenClaw first pass shipped 3 of 13 items and the other 10 sat untouched. Before that, PR-hardening Phase B/C/D was forgotten until a parallel session caught it.

This spec adds a small layer on top of the existing tracker so projects of nineteen features stay visible until they're all done. A **project** is a named bundle. Each project has **rounds** — groups of features you ship together in one autonomous session. Every feature carries a **pipeline stage** that tracks how far through the build process it is (outline written → full spec drafted → spec convergence passed → user approved → built → merged). A **session-start digest** keeps every active project visible at the top of every new conversation, including after context compaction — so the agent can't forget what's open. **Drift checks** run before each round to catch stale spec premises. The whole thing is **structurally gated** so the agent can't claim a round is complete unless every item in it has a verified merged PR on main with CI green. The next round needs the user's acknowledgment for the first auto-advance, and after two unacknowledged auto-advances the project is paused.

The user reads project state on the dashboard or in the session-start orientation. The agent uses a thin skill to advance items. No new database, no new ledger format — extends the existing initiatives ledger with a small set of optional fields.

What the user sees once it ships: at the top of every new conversation, one line per active project showing "3 of 19 done, next round: X, Y, Z." A dashboard tab with progress bars per round. A Telegram notification when a round completes, with a 24-hour brake handle ("reply 'pause openclaw' to hold"). Drift-check alerts when a spec's premise has gone stale relative to the current code. Verified evidence that each merged item is actually on main, re-checked periodically.

What the user doesn't have to do: remember the roster. Mentally track which items are still open. Notice that work has stalled. Re-confirm approvals across sessions. The infrastructure handles the visibility.

---

## Original vs Converged

The spec changed substantially across five iterations. Each iteration tightened a different angle the original missed. Here's what actually changed, in plain English:

**Drift check was a gate. Now it's a signal.** The original spec treated the LLM's drift verdict as the authority — if it said `no-drift`, the round could start; if it said `premise-violated`, the round halted. A reviewer pointed out this directly contradicts Echo's own "signal vs authority" memory rule: any LLM-mediated check can be biased by injected content in the spec or source files. The converged spec splits these: drift is one of several inputs to a deterministic gate. The actual round-start authority requires verifiable artifacts (spec frontmatter tags, merged PR SHAs that GitHub reports as merged, CI status), not the LLM's opinion.

**Pipeline transitions had no enforcement. Now they require artifacts.** The original spec listed pipeline stages (outline → spec-drafted → spec-converged → building → merged) but didn't validate them server-side. A clever or buggy caller could PATCH any item to `merged` without a real PR. The converged spec defines per-edge validators: `spec-converged` requires the spec's frontmatter has `review-convergence: true` AND the convergence report file exists, `merged` requires `gh pr view` reports state=MERGED with a real merge-commit reachable from `origin/main` and CI green. Forged transitions are rejected with 409.

**`merged` was set-once and never re-checked. Now there's a reconciler.** The original spec assumed once an item was marked merged it stayed merged. A reverted PR or a force-push could silently break this. The converged spec adds a `ProjectIntegrityReconciler` that runs on every GET (debounced 6h per child, capped at 3 children per GET) and as a periodic job — if a merged-state item's PR isn't on main anymore, it transitions to `regressed` and rolls the round status back.

**Squash-merge breakage was missed entirely. Now it's the default path.** The original spec checked PR head SHAs against `origin/main` via `git merge-base --is-ancestor`. But Echo uses squash merges — the head SHA never lands on main; the squash commit does. The original check would have broken every `building → merged` transition in production. The converged spec uses `gh pr view --json state,mergeCommit` to get GitHub's actual merge commit, not the PR's head.

**The runner had no kill switch and no concurrency story. Now both are explicit.** The original had a single `/autonomous` invocation per round but no halt path, no lock, no story for what happens when two rounds compete or a runner crashes mid-round. The converged spec defines a machine-local single-writer lock (`.instar/local/round-runner.lock`, gitignored), a `POST /projects/:id/halt` endpoint that sends SIGTERM to the autonomous process group (so spawned children get reaped too, with `detached: true` on spawn so the runner doesn't kill itself), a per-step halt checkpoint between every numbered step in the run loop, and a server-restart reconciler that recovers from stale state.

**Auto-advance had no brake. Now it has three.** The original spec auto-advanced rounds after a 24-hour Telegram digest. A reviewer flagged that if Justin's phone is off or Telegram is down, the agent silently chains through the entire project before he notices. The converged spec requires an explicit acknowledgment for the first round of any new project (no auto-fire), pauses the project after two unacknowledged auto-advances in a row, and gates every round on `lastAckedRoundIndex` being within two of the current round index.

**Multi-machine state had silent failure modes. Now it's coordinated.** Echo runs across machines that share `.instar/` via git-sync. The original spec didn't say what happens when both machines fire auto-advance after a sync, or how leader election works after one machine goes offline. The converged spec adds an `ownerMachineId` field on the project record, a heartbeat file per machine, a 48-hour staleness window before another machine can claim, a 60-second sync-settle period before the new owner acts, and an async `POST /claim-ownership` flow (returns 202 with operationId; finalizes after settle) to avoid blocking the HTTP handler.

**Git-sync conflicts used to crash the parser. Now there's a merge driver.** A reviewer pointed out that two-machine concurrent edits to `.instar/initiatives.json` produce raw `<<<<<<<` conflict markers that crash `JSON.parse()` before any reconciliation logic runs. The converged spec ships a custom git merge driver (`scripts/git-merge-driver-initiatives.js`, registered via `.gitattributes` and auto-installed by the server's first-start path) that produces structured `awaitingReconciliation` patches instead of leaving raw markers. As a defense-in-depth, the loader detects raw markers at load time and refuses to start with a clear error message.

**Path traversal was open in three places. Now it's jailed.** Plan-doc `source_docs`, spec `specPath`, and the file references inside specs all originally allowed any path. A reviewer pointed out that a malicious plan could read `/etc/passwd` or `~/.ssh/id_rsa`. The converged spec realpath-jails every path under `targetRepoPath` (a required field on every project), runs YAML through safe-load only, constrains spec frontmatter `slug` to the same regex as project `id` (so the convergence-report path can't traverse), and adds tests for `../`, absolute paths, and symlink escapes.

**Cost runaway was undefined. Now there's a ledger.** The original spec said drift-check cost was capped at $1/day per agent, with no detail. The converged spec persists a daily-rotated ledger (`.instar/drift-spend-YYYY-MM-DD.jsonl`), pre-reserves estimated cost atomically under an advisory file lock (`.instar/local/drift-spend.lock`) to prevent concurrent drift-checks on different projects from both crossing the boundary, and explicitly defers the cross-machine atomic cap as a same-PR-registered child initiative.

**"Out of scope" lists were a recurrence risk. Now they're tracked.** Echo has a MEMORY rule against the "out of scope" trap — splitting a comprehensive ask into "tactical now + later" without owned follow-through is how recurrence happens. The original spec had a "deferred" list that risked exactly this. The converged spec requires every deferral to be registered as a child initiative under the project-scope project itself in the SAME commit that ships Phase 1, enforced by a new pre-commit hook (`scripts/check-defers.sh`, path-filtered to `docs/specs/**/*.md`).

**Many smaller catches:** worktrees now live under `targetRepoPath` (not the agent's working directory) using `git -C` for every git invocation, auto-added to `.git/info/exclude` so they don't pollute `git status`. The session-start hook now reads a pre-rendered cache file (50ms budget) instead of hitting HTTP. Telegram digest delivery has retry + multi-channel fallback (Telegram + dashboard attention queue + audit log). The round-complete message goes through a structured template that requires `whatLanded`, `concreteNextStep`, and `brakeHandlePhrase` fields, with empty-default for pre-flight halts (so the tone gate never silently rejects a legitimate halt). 409 responses return version-only bodies (not 40KB full records) to keep dashboard polling cheap.

The shape of the design didn't change. The plumbing did, in roughly 70 specific places.

---

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes | Score trend |
|-----------|----------------------|-------------------|--------------|-------------|
| 1 | All 7 (4 internal + 3 external) | ~70 | Major rewrite | Grok 9, GPT 7, Gemini 8.5 |
| 2 | All 7 | ~30 | Major rewrite + new design principles section | Grok 10, GPT 8, Gemini 9 |
| 3 | All 7 | ~12 | Targeted rewrite covering squash-merge, OCC vs sync, state-machine completeness | Grok 10, GPT 9, Gemini 9.5 |
| 4 | All 7 | ~7 | Polish: process-group, merge-driver registration, accept-partial brake | Grok 10, GPT 9.5, Gemini 9.5 |
| 5 | All 7 | 0 (CONVERGED) | None needed | Grok 10, GPT 10, Gemini 10 |

The four internal reviewers (security, scalability, adversarial, integration) report CONVERGED in iter-5. All three external models report 10/10 APPROVE in iter-5. Scalability and integration converged at iter-3; security and adversarial converged at iter-5; externals tracked APPROVE-with-clarifications throughout, reaching pure APPROVE in iter-5.

---

## Full Findings Catalog

Findings are grouped by iteration and reviewer. Each entry shows: severity, perspective, finding summary, resolution applied.

### Iteration 1 (initial review)

The original spec was 200 lines covering the high-level design. The first round surfaced 70+ findings. Most clustered into ten themes:

| Theme | Reviewers | Resolution |
|-------|-----------|------------|
| Auth on `/projects/*` endpoints unspecified | Security | All endpoints require Bearer auth; unauth → 401 |
| Drift-check authority confusion (signal vs gate) | Security, Adversarial, GPT | P1 principle separates signal from authority; gate is deterministic |
| First-launch out-of-band approval missing | Security, Adversarial | Required ack before first autonomous round; runner-level chokepoint |
| Round runner has no kill switch or auth context | Security | `POST /halt`, SIGTERM via process group, MessageSentinel integration |
| Drift-check resource exhaustion possible | Security, Scalability | Input bounds, mutex, hash-keyed cache, $1/day cost ledger |
| Pipeline-stage forgery possible | Security, Adversarial | Per-edge artifact validators; reject on miss |
| Auto-advance has no brake | Adversarial, Gemini | First-launch ack + ≥2 unack pauses + multi-channel digest |
| Path traversal via plan-doc / spec refs | Security | Realpath jail under targetRepoPath; safe YAML; slug regex |
| Concurrent writes lose user PATCHes | Scalability, GPT | OCC version field on every record; If-Match enforcement |
| 24-hour timer not persisted | Scalability, Gemini | `autoAdvanceAt` ISO field polled by existing tick |
| Multi-machine state not coordinated | Integration, GPT | `ownerMachineId`, heartbeat, leader-election, 60s settle |
| `merged` set on reverted PR not detected | Adversarial | `ProjectIntegrityReconciler` lazy + periodic |
| TaskFlow integration ambiguous | Integration | Each per-item build = TaskFlow record; round = project-record only |
| Compaction-recovery hook unaware of projects | Integration | Extended to inject same digest after compaction |
| Worktree collisions across rounds | Adversarial, Integration | Unique-per-item path under `targetRepoPath` |
| Telegram delivery deadlock if user offline | Adversarial | Multi-channel fallback (Telegram + dashboard + attention queue) |
| Round complete on partial merges | Adversarial | Per-item evidence required; `partially-complete` status |
| Tone-gate rejects legitimate halts | Adversarial | Structured template with empty-default for pre-flight halts |
| Out-of-scope trap recurrence | Adversarial | Deferred items registered as child initiatives in same PR |
| Skipped items have no audit | Adversarial | Required skippedAt/By/Reason |
| `kind` and `parentProjectId` poisoning | Adversarial | `kind` immutable; bidirectional validation |
| Drift verdict gameable via file summaries | Adversarial | Untrusted-block delimiters; structured output; citation verification |
| Session-start prompt injection via project metadata | Security | Control-char strip + length cap at both write and read time |

### Iteration 2 (rewrite review)

The iter-1 rewrite was 480 lines covering 14 phases. Iter-2 found 30 net-new findings, mostly missing implementation details rather than design flaws:

| Finding | Severity | Resolution |
|---------|----------|------------|
| Wrong working directory for `git merge-base` (echo runs in agent dir, not target repo) | HIGH (Integration) | `targetRepoPath` required on every project; all git ops use `git -C` |
| Squash-merge SHA mismatch — `git merge-base` on PR head SHA fails | HIGH (Gemini) | Use `gh pr view --json state,mergeCommit`; check `mergeCommit.oid` |
| Lock file inside git-synced dir self-deadlocks across machines | HIGH (Gemini) | Lock moved to `.instar/local/round-runner.lock`, gitignored |
| Static stop condition vs mid-round skip hangs runner | HIGH (Gemini) | Dynamic stop revalidation; SIGTERM + step-4 loopback on item skip |
| Frontmatter re-validation gap at pre-flight | HIGH (Integration) | Runner re-verifies `review-convergence: true + approved: true` at preflight |
| Cost accounting store undefined across restarts/machines | HIGH (Scalability + Grok) | `.instar/drift-spend-YYYY-MM-DD.jsonl` daily-rotated; advisory flock |
| First-launch ack bypass via `/project run-round` skill | HIGH (Security/Adversarial) | Ack check moved to runner pre-flight (single chokepoint) |
| Drift cache key omits prompt/model version | HIGH (Security/Adversarial) | Cache key includes `promptTemplateVersion + modelId` |
| State-model enum incomplete (`paused`, `awaiting-user` referenced not declared) | HIGH (GPT) | Canonical project + round status enums defined |
| Git-sync field-merge contradicts OCC | HIGH (GPT) | Reconciliation-event semantics via custom merge driver; `awaitingReconciliation` for losing-side writes |
| Slug regex unconstrained — convergence report path traversal | MEDIUM (Security) | Slug must match `^[a-z0-9][a-z0-9-]{0,63}$`; realpath check |
| `evidenceCitations` unverified LLM output | MEDIUM (Adversarial) | Byte-range validated post-LLM; failed → manual-review-required |
| `partially-complete` round has no escape | MEDIUM (Adversarial) | `POST /accept-partial` endpoint; missing items → `skipped` with reason |
| Attempt-4 behavior undefined | MEDIUM (Adversarial) | `failed` terminal state; only `--force` resume or `abandon` accepted |
| Regressed item doesn't roll back round status | MEDIUM (Adversarial) | Reconciler rolls round status back from `complete` to `regressed` |
| Tone-gate can't populate fields on pre-flight halt | MEDIUM (Adversarial) | Empty-default for `whatLanded`; presence enforced, not non-emptiness |
| `skipped` silently terminal | MEDIUM (Adversarial) | `skipped → outline` allowed with `unskippedAt` |
| Worktree namespace slug collision | LOW (Adversarial) | Path uses `/` separator |
| Drift-cache hash recomputed every check | MEDIUM (Scalability) | Mtime fast-path before re-hashing |
| `projects-digest.cache` invalidation incomplete | MEDIUM (Scalability) | Invalidated in writer path (single chokepoint) |
| Per-item worktree allocation unbounded | MEDIUM (Scalability) | Lazy allocation as autonomous reaches each item |
| 409 with full body amplifies dashboard poll cost | MEDIUM (Scalability) | 409 returns version-only body |
| `/spec-converge` action surface missing | MEDIUM (Integration) | `/projects/:id/next` returns `{action, params, estimatedCost, skillCommand}` |
| `/autonomous` state vs round-runner lock collision | MEDIUM (Integration) | Single cleanup path on lock release |
| Initiatives tab filter unspecified | LOW (Integration) | Server-side `?excludeKind=project&excludeParented=true` |
| Dashboard ack vs Telegram ack composition | LOW (Integration) | `lastAckedRoundIndex` field; idempotent across channels |
| Defers asserted not gated | MEDIUM (Adversarial) | `scripts/check-defers.sh` pre-commit hook |

### Iteration 3 (tightening review)

Iter-3 surfaced 12 net-new findings. Internal scalability converged. Security and integration reached LOW-only. Adversarial held the line with 2 HIGH issues:

| Finding | Severity | Resolution |
|---------|----------|------------|
| Worktree path not under `targetRepoPath` (just `.worktrees/...`) | HIGH (Adversarial) | Explicit `path.join(targetRepoPath, '.worktrees', ...)` + `git -C` |
| `awaitingReconciliation` integration point unspecified | HIGH (Adversarial) | Custom git merge driver `scripts/git-merge-driver-initiatives.js` + `.gitattributes` registration + loader pre-parser |
| Reconciler `gh pr view` pile-up on dashboard polls | MEDIUM (Adversarial) | ≤3 children per GET cap |
| Cost ledger pre-reservation race across projects | MEDIUM (Adversarial) | Advisory file lock `fcntl flock` |
| `firstLaunchAckAt` only covers round 0 | MEDIUM (Adversarial) | Secondary brake: `lastAckedRoundIndex ≥ currentRoundIndex - 2` |
| `awaitingReconciliation` write vs OCC | LOW (Integration) | Mid-loop checkpoint on `awaitingReconciliation` non-empty |
| `claim-ownership` 60s wait blocks HTTP | LOW (Integration) | Return 202 + operationId; finalize in background |
| `/next` deterministic ordering | LOW (Integration) | `(roundIndex asc, pipelineStage asc, itemId asc)` |
| `check-defers.sh` runs on every commit | LOW (Integration) | Path-filtered to `docs/specs/**/*.md` |
| `/projects` rate-limit key | LOW (Adversarial) | Per agent token; counter at `.instar/local/projects-rate.json` |
| Heartbeat race test | LOW (Adversarial) | Single-writer-per-machine convention documented |
| `/resolve-conflict` body schema | LOW (Adversarial) | `{patchId, action: 'accept' \| 'reject'}` + If-Match required |

### Iteration 4 (polish review)

Iter-4 surfaced 7 net-new findings. Externals reached APPROVE; internals reached LOW + MEDIUM only:

| Finding | Severity | Resolution |
|---------|----------|------------|
| Process-group SIGKILL can kill the runner itself | MEDIUM (Security + Gemini) | Autonomous spawned with `detached: true`; `kill -- -PGID` targets child group only |
| Merge driver won't execute without per-clone `git config` | MEDIUM (Gemini + Security) | Server first-start auto-registers via `git config --local merge.instar-initiatives.driver ...`; refuses to start if script absent |
| `accept-partial` brake interaction unclear | MEDIUM (Adversarial) | Counts as ack for current roundIndex; advances `lastAckedRoundIndex`; does NOT increment `unacknowledgedAdvanceCount` |
| `.worktrees/` shows as untracked in `git status` | LOW (Adversarial) | Auto-appended to `.git/info/exclude` on first allocation |
| Reconciler ≤3 selection order unspecified | LOW (Adversarial) | Oldest `ciCheckedAt` first; ties by `roundIndex` ASC then `itemId` ASC |
| Resolve-conflict reject has no audit trail | LOW (Adversarial) | Both accept and reject append to `.instar/conflict-resolutions.jsonl` |
| operationId entropy + TTL | LOW (Security) | `crypto.randomUUID()` (128-bit); 1h TTL after settleAt |
| drift-spend.lock outside `.instar/local/` syncs across machines | INFO (Security) | Moved to `.instar/local/drift-spend.lock` |

### Iteration 5 (final convergence check)

All four internal reviewers and all three external models report **ZERO MATERIAL NEW FINDINGS — CONVERGED**.

Minor polish suggestions surfaced but classified as non-blocking by the reviewers themselves:
- Zero-item round success criterion (Grok)
- Heartbeat file corruption fallback in `InitiativeTracker.load()` (Grok)
- Windows detached-spawn documentation note (Grok)
- DriftChecker performance SLA (95% < 20s at 50k tokens) (Grok)
- `/projects` rate-limit reset cadence (Grok)
- Idempotent `.git/info/exclude` append (Adversarial LOW)
- `skipped → merged` reconciliation edge case (Adversarial LOW)
- Conflict-resolutions.jsonl retention policy (Adversarial LOW)
- `gh` CLI authentication in deployment env (Gemini operational note)

None require spec changes before `/instar-dev` can begin. They can be addressed as small implementation-time tweaks.

---

## Convergence Verdict

**Converged at iteration 5. No material findings in the final round. Spec is ready for user review and approval.**

The spec has grown from ~200 lines to ~750 lines across five iterations. The growth is in implementation specificity (per-edge validators, OCC semantics, merge-driver definition, persistence schemas, success criteria) rather than feature scope. The design shape — project layer over Initiative Tracker with rounds, drift signals, deterministic gates, structural brakes — is the same as iteration 1.

The convergence process surfaced two issues that would have made the feature non-functional in production: the squash-merge SHA mismatch (entire `building → merged` path broken under Echo's actual workflow) and the process-group SIGKILL self-suicide (runner would have killed itself when canceling a mid-round skip). It surfaced one issue that would have been a privacy/safety regression: path-jail bypass in `sourceDocs` and slug-derived convergence-report paths. And it surfaced one issue that would have been a multi-machine correctness bug: git-sync field-wise merge silently breaking OCC guarantees on counters like `unacknowledgedAdvanceCount`.

Net cost of the convergence process: 5 iterations × 7 reviewers = 35 reviewer-passes, roughly 1.5 hours of wall-clock time, on the order of $5-$10 in API spend. This is appropriate given the spec is foundational infrastructure that other multi-spec plans (OpenClaw imports, future builds) will sit on top of for the indefinite future.

**Next step:** User reads this report and applies `approved: true` + `approved-by: <name>` + `approved-date: <date>` to the spec frontmatter. `/instar-dev` then becomes able to act on the spec.
