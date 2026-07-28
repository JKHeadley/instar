---
title: Release-Readiness Visibility — canonical-source + speak-on-skip for self-driving loops
approved: true
eli16-overview: RELEASE-READINESS-VISIBILITY-SPEC.eli16.md
topic: 14100
review-convergence: "2026-05-27T19:31:40.008Z"
review-iterations: 3
review-completed-at: "2026-05-27T19:31:40.008Z"
review-report: "docs/specs/reports/release-readiness-visibility-convergence.md"
---

# Release-Readiness Visibility — making silent self-driving loops loud

**Status:** CONVERGED (3 iterations + v3-final polish, 2026-05-27). `approved:` flag still false — awaiting Justin's structural sign-off. Author: echo · Created: 2026-05-27 · Topic: 14100 ("Release Hygiene")
**Companion (required):** `RELEASE-READINESS-VISIBILITY-SPEC.eli16.md`
**Convergence report:** `docs/specs/reports/release-readiness-visibility-convergence.md`

> Per the instar-dev gate, no code ships until convergence (`/spec-converge`, ✅ done) and Justin sets `approved: true`.

## Convergence changelog (v1 → v2 — material findings addressed)

Iteration 1 (5 internal reviewers: security, scalability, adversarial, integration, lessons-aware; external cross-model reviewers skipped per the abbreviated-convergence allowance — framework-API approval not granted for this spec) surfaced **5 SERIOUS findings** in v1, all addressed below:

| # | Finding (reviewer) | v1 problem | v2 fix |
|---|--------------------|-----------|--------|
| F1 | Adversarial #1 + Security #1/#2 | Auto-fill could ship **placeholder text** (`"Review the commit for specifics"`) past the publish gate, fleet-wide | §4.1 — auto-draft now writes a specific `<!-- auto-draft-unreviewed -->` poison marker that BOTH `check-upgrade-guide.js` and `publish.yml`'s skip predicate explicitly reject. Drafted text sanitized (strip HTML comments, length-cap, escape markers). |
| F2 | Adversarial #2 | The alarm silences itself — Layer A clears the same conditions Layer B reads | §4.2 — Layer B's "blocked" detection is **decoupled from NEXT.md state**: gate on unreleased-feature-commits-without-covering-tag + presence of the unreviewed-marker. Auto-draft alone never clears the alarm. |
| F3 | Scalability #1 | Layer C did ~356 git shell-outs every 6h (one per spec × 178 specs) | §4.3 — single batched `git ls-tree main docs/specs/` + single ancestry pass; per-tick scope limited to specs newer than the last-processed commit. |
| F4 | Scalability #2 | Layer B re-ran the per-file diff loop every tick, uncached | §4.2 — readiness computation **cached on `main` HEAD SHA + last-tag SHA**; recompute only on SHA change. |
| F5 | Adversarial #5 + Security #4 + Integration #3 | Reading local `main` gives a false "all clear"; `git fetch` with no timeout could hang the reconciler | §4.3 + §9.1 (resolved) — bounded `git fetch --depth=... --no-tags --no-recurse-submodules` with timeout before each canonical read is **normative**, not optional; on fetch failure → low-priority Attention item, never silent fall-back. Local-tree fall-back is config-gated and emits a degradation event. |

Plus 8 MINOR findings addressed (sanitization details, lifecycle-owner class, supervision tier, stable dedupe key, observability route, migration mechanism naming, multi-machine clarification, rollback checklist). See the iteration-1 catalog in `docs/specs/reports/release-readiness-visibility-convergence.md` (written at Phase 4).

## Convergence changelog (v2 → v3 — iter-2 findings addressed)

Iteration 2 produced **2 CONVERGED** (security, lessons-aware) and **3 NEEDS-ITER-3** (scalability, adversarial, integration). One SERIOUS new blocker + 7 material findings, all addressed below:

| # | Finding (reviewer) | v2 problem | v3 fix |
|---|--------------------|-----------|--------|
| F6 | Scalability iter-2 N1 (SERIOUS) | Spec asserted `analyze-release.js --ref=FETCH_HEAD` exists; **it does not** — script hardcodes `${tag}..HEAD`. As-stated Layer B silently runs against local HEAD → recreates F5. | §4.2.2 — explicit enumeration of the script changes (add `--ref` arg parser; thread ref through `getLastReleaseTag`, `getChangedFiles`, `getFileDiff`, `getCommitsSinceTag`); Layer B activation **gated on those landing first** (sequencing in §10). |
| F7 | Adversarial iter-2 N1 (HIGH) | "Human review" of unreviewed-marker = stripping ~30 bytes; a tired human or a script bypasses the gate. | §4.1.1 — replace bare-strip with **review-receipt attestation**: removing an `auto-draft-unreviewed:<slug>` marker is only valid when accompanied (same section) by a `<!-- reviewed-by: <git-user> @ <ISO-date> -->` line. Validator rejects strip-without-receipt. |
| F8 | Adversarial iter-2 N2 (MEDIUM) | `canonicalRemote` config = a kill-switch: point at an up-to-date fork → fetch succeeds, alarm silenced forever. | §4.2.2 — allow-list canonical remotes against the hardcoded pattern `^(.+:|.+\/)?JKHeadley/instar(\.git)?$`. An override to a non-matching remote is permitted but raises a HIGH-priority Attention item immediately and stamps the readiness state file with `canonicalRemoteOverridden: true`. |
| F9 | Adversarial iter-2 N3 (MEDIUM) | `isEpisodeActive(commitSha)` keyed on the oldest-at-detection SHA; finalize misses if oldest churned, or collapses two episodes onto a stale SHA. | §4.2.5 — finalize calls `resolveEpisodesInRange(lastTagSha, newTagSha)`; sentinel auto-resolves every open episode whose oldestSha is an ancestor of `newTagSha`. New unit test for "oldest-commit churn during open episode." |
| F10 | Adversarial iter-2 N4 (LOW) | K=3 on Layer C's first-enabled tick = 18h silent baseline window. | §4.3.3 — first tick after `featureRollout.canonicalRefScan` flips ON uses K=1; steady-state K=3 thereafter. |
| F11 | Scalability iter-2 N3 (LOW) | Concurrent Layer B + Layer C fetch race when ticks coincide. | §4.2.2 — shared in-process **fetch-promise lock** (`Map<remote, Promise>`) so concurrent callers await the same fetch; advisory lock `.instar/state/.fetch.lock` for cross-process safety. |
| F12 | Integration iter-2 N1 (MEDIUM) | `migrateClaudeMd` block for the §4.2.7 CLAUDE.md template line was missing — new agents get it via init; existing agents diverge (Migration Parity violation). | §7 — explicit bullet: idempotent content-sniff in `migrateClaudeMd` keyed on the marker string `/release-readiness` or a distinctive comment. |
| F13 | Integration iter-2 N3 (LOW) | `scripts/rollback-release-readiness.mjs` doesn't reach agents on npm update (not under `dist/`, not in package `files`). | §10 + §4.2.7 — rollback is now an authenticated endpoint `POST /release-readiness/rollback` (callable by the agent from any session), not a local script. |

Plus minor wording per iter-2 (lock is intra-host §4.1.3; cache-miss cost called out §4.2.3; cat-file batch O(new-only) §4.3.2; non-leader cache lag note §4.2.7; fetch-failure dedupe between B & C §4.2.2). The 5 reviewers + iter-2 catalog will roll into Phase-4 report.

---

## 1. Problem — two silent gaps, one root

**Incident (2026-05-27).** npm publishing had been silently stuck since v1.3.26. A whole minor-release's worth of merged work — the mentor system, the feedback-factory port, multi-machine, threadline fixes, the failure-learning loop (≈36 feature commits / 15 new endpoints / 46 new files) — sat unreleased. Every agent, including Echo, ran stale code without knowing it. Echo only discovered it by going to activate a freshly-merged feature and finding its endpoints 404'ing on its own server.

**Sibling finding (same thread).** The InitiativeTracker's auto-registration (`FeatureRolloutReconciler`, the loop whose entire job is "never forget to mature a shipped feature") missed the just-merged failure-learning-loop spec — because it scans the agent's **local working tree**, and as the developer Echo is usually on a side-branch or temp worktree (cleaned up after merge). The newest, freshly-merged work is exactly what it skips — and it says nothing.

**The root they share:** a self-driving loop trusting whatever happens to be true *locally / in-the-moment*, with **no signal when it skips or no-ops**. Green merges, green CI, no published release, no alert.

### 1.1 Precise mechanism (grounded in the actual code)

The two loops fail **different halves** of the same principle:

| Loop | Reads canonical source (main)? | Speaks up on skip/block? |
|------|-------------------------------|--------------------------|
| **Publish** (`.github/workflows/publish.yml`) | ✅ yes — checks out `ref: main` | ❌ **no** — silent skip |
| **Board auto-register** (`featureRolloutScan.ts` → `FeatureRolloutReconciler`) | ❌ **no** — scans local working tree + local trace receipts | ❌ no — silent skip |

**Publish loop — the silent skip (`publish.yml:44-55`).** If `upgrades/NEXT.md` is missing OR still contains the placeholder markers `[Feature name]` AND `[Capability]`, the job sets `skip=true` and does nothing — no error, no annotation, no alert. **A stalled release is indistinguishable from "nothing to publish."**

**Board reconciler — the wrong source (`src/core/featureRolloutScan.ts`).** Reads `docs/specs/` from `repoRoot` (local working tree, `:66-69`) and local trace receipts `.instar/instar-dev-traces/*.json` (`:46-52`). It *infers* `merged = approved && traceExists` (`:82`); a comment at `:9-10` admits the shortcut: *"Precise git-merge introspection is a refinement."* It never consults git/main.

### 1.2 What this spec deliberately does NOT change

- The safety checks themselves stay as-is in their gating role. We add visibility and canonical sourcing, never relax a gate.
- Per-PR NEXT.md enforcement remains out of scope (§8).

## 2. What already exists (so we extend, not reinvent)

- **`scripts/analyze-release.js`** classifies every commit since the last tag and produces `generateChangeDescriptions()` (`:488-563`). Today: only grades the guide + recommends a bump; never drafts.
  - **CAVEAT (per iter-1 Adversarial #1):** `generateChangeDescriptions` emits placeholder strings for unstructured feature commits — `userImpact: 'Review the commit for user-facing changes'`, `agentImpact: 'Review the commit for specifics'` (`:543-547`). v2 sanitization in §4.1 treats this as poison until human-reviewed.
- **`scripts/check-upgrade-guide.js`** — prepublish gate: validates section presence, finalizes `NEXT.md → {version}.md`, writes a fresh `NEXT_TEMPLATE`.
- **`upgrade-guide-validator.mjs`** — owns `NEXT_TEMPLATE`, `REQUIRED_SECTIONS`, `validateGuideContent`, `parseBumpType`.
- **Attention Queue** (`POST /attention`, bearer-gated via `authMiddleware`) — the existing pull surface for near-silent signals.
- **Job system** — declarative `.instar/jobs/instar/*.md`. Installed via `InstallBuiltinJobs` (always-overwrite contract per its §Seamless Migration Guarantee), called from `PostUpdateMigrator.migrateBuiltinJobs` (`PostUpdateMigrator.ts:1257`). Operator-disabled state preserved per-slug in the schedule manifest.
- **`FeatureRolloutReconciler` + `featureRolloutScan`** (PR #401) — board auto-register, server-wired at boot + 6h cadence.
- **`SafeGitExecutor`** — audited git funnel using `execFileSync` (argv array, no shell). Already used by `analyze-release.js`. All git in v2 routes through it.

## 3. Design principle

> **Self-driving loops must (1) read the canonical source of truth (main), and (2) emit a visibility signal whenever they skip, no-op, block, or fail to evaluate.** A skip that produces no signal is a silent failure waiting to accumulate. This applies to the new code in this spec as much as to the loops it fixes — Layer B's own evaluation failures must signal, not silently catch.

## 4. Design

### 4.1 Layer A — Auto-draft the upgrade guide (root-cause removal, with publish-gate safety)

**New mode:** `node scripts/analyze-release.js --draft-guide` writes `upgrades/NEXT.md` from `generateChangeDescriptions(analysis)`, structured into the required sections + a seeded `<!-- bump: TYPE -->`.

#### 4.1.1 The unreviewed-content trust boundary (addresses F1)

The published guide is read into every agent's context fleet-wide. Auto-drafted content has not been reviewed by a human and **must not be allowed past the publish gate** until it is.

- **Poison marker:** every auto-drafted item is wrapped in a stable line marker `<!-- auto-draft-unreviewed: <slug> -->`. The full draft (when NEXT.md is absent/template) gets a top-of-file `<!-- auto-draft-unreviewed-block -->` marker.
- **Review-receipt attestation (addresses F7, iter-3 Adversarial V2).** Removing an `auto-draft-unreviewed:<slug>` marker is **only valid** when accompanied, within the same section, by a `<!-- reviewed-by: <git-user> @ <ISO-date> :hash=<sha256> -->` line. The validator computes the marker→receipt mapping per section and rejects strip-without-receipt. **`:hash=<sha256>` is required, not optional** (per iter-3 V2) — it captures the canonicalized section text at review time; a later edit that changes the hash auto-invalidates the receipt and re-blocks publish, preventing the failure mode where "I reviewed the draft" silently grants a free pass to subsequent edits. **Canonicalization for the hash:** LF line endings, trim trailing whitespace on each line, exclude the receipt line itself from the input. The receipt's `<git-user>` is matched against `git config user.email` and the date must be within the last 30 days; server clock (CI) is authoritative for the window.
  - **Scope note (iter-3 Adversarial V1):** the attestation is **anti-bypass** (defeats the `sed`/tired-human strip + script-driven removal), **not anti-impersonation** — an attacker with commit-write can set `git config user.email` to anything. Stronger identity (matching the receipt's `<git-user>` against the commit author of the strip via post-hoc `git log -p`) is a tracked Phase-2 hardening; not required for ratification.
- **Gate amendment (publish-time):**
  - `scripts/check-upgrade-guide.js` — `validateGuideContent` is extended to **fail validation** when any `auto-draft-unreviewed` marker remains *or* when a marker was removed without a matching `reviewed-by` receipt.
  - `.github/workflows/publish.yml:50` — the skip predicate is extended to also set `skip=true` when the unreviewed marker is present. This keeps the silent-skip semantics correct for the unreviewed case (nothing publishes) while §4.2's signal makes the skip visible.
- **Sanitization of drafted text** (addresses Security #1/#2):
  1. Strip HTML comments (`<!--…-->`) from any commit-message-sourced text before insertion (prevents forged `<!-- bump: -->` / `<!-- auto-draft-unreviewed -->` markers).
  2. Length-cap each item summary at 200 chars; truncate with ellipsis.
  3. Escape markdown control characters that could break section boundaries (backslash-escape leading `#`, `---`).
  4. Parse all markers only at line-start (e.g. `^<!--\s*bump:`) so embedded text can never forge them.
- **Placeholder-text neutralization** (addresses F1 root): for any feature commit where `generateChangeDescriptions` would emit one of the fallback strings (`'Review the commit for specifics'`, `'Review the commit for user-facing changes'`), the auto-draft writes `<!-- auto-draft-unreviewed: HUMAN-REQUIRED — describe user impact -->` instead. The marker forces a human edit before publish can clear; the fallback strings never reach the published artifact.

#### 4.1.2 Never-clobber merge

- **NEXT.md absent or pristine template** → write full draft, all items marked unreviewed.
- **NEXT.md has human content** → reuse `validateGuideCoverage` to compute the delta; append only uncovered items to a clearly-delimited `<!-- auto-draft: uncovered (unreviewed) -->` block (also gated by the unreviewed marker).
- **Idempotent:** re-running reconciles the auto-draft block against current coverage; never duplicates entries; never grows unboundedly (cap N items per block).

#### 4.1.3 Race guard against publish-finalize (addresses Security #5)

`check-upgrade-guide.finalizeGuide()` renames `NEXT.md → {version}.md`. Layer A must no-op if a finalize is in flight or just completed:
- Take a process-local advisory lock (`upgrades/.next.lock`, `O_EXCL`) before write. **NB:** this lock is intra-host only — it serializes drafters on the same agent host. The cross-host guarantee (the drafter on the agent host vs. `finalizeGuide()` running in GitHub Actions on a fresh checkout) comes solely from the post-finalize `{version}.md` existence check below + git's own ref-update atomicity at merge.
- Before write, check that `upgrades/{currentPackageVersion}.md` does NOT exist (i.e. finalize hasn't just run); abort with a degradation event if it does.

#### 4.1.4 Where it runs

Invoked by Layer B's recurring check (so NEXT.md stays seeded continuously) and as `npm run draft:guide` for a developer mid-PR. **It does NOT run inside `publish.yml`** — drafting at publish time would mask a missing human review.

### 4.2 Layer B — The release-readiness signal (decoupled, cached, fail-loud)

A cheap recurring check that makes a stalled release impossible to miss.

#### 4.2.1 Host

A new declarative job at `src/scaffold/templates/jobs/instar/release-readiness-check.md` — shipped to agents via `InstallBuiltinJobs` (always-overwrite of the template body; per-slug `enabled: false` preserved in the schedule manifest). Ships **off by default** under graduated rollout; Echo opts in first.

**Supervision tier (addresses Lessons #2):** Tier 0. Justification: the computation is mechanical (analyze-release JSON parse + threshold), and the user-facing wording is a fixed template (no LLM authorship). If a future variant adds LLM-shaped reasoning to the Attention-item text, the tier reclassifies to Tier 1.

#### 4.2.2 Canonical source — normative (addresses F5, F6, F8, F11)

- Before the readiness computation, run a bounded fetch: `git fetch <canonical-remote> main --depth=1 --no-tags --no-recurse-submodules` with a 30s timeout (configurable: `releaseReadiness.fetchTimeoutMs`).
- **Canonical remote allow-list (addresses F8, iter-3 Adversarial V3):** the effective remote URL is matched against the hardcoded canonical pattern `^(https://github\.com/|git@github\.com:)JKHeadley/instar(\.git)?$` — anchored on the known canonical host (`github.com`), not "any transport with a `JKHeadley/instar` suffix" (per iter-3 V3, the looser regex matched `git@evil.com:JKHeadley/instar.git`). The default remote is the first configured remote whose URL matches, falling back to `origin`. An override via `releaseReadiness.canonicalRemote` to a non-matching URL is *permitted* (forks legitimately exist) but the sentinel raises a **HIGH-priority Attention item** at startup — *"release-readiness canonical remote overridden to non-canonical URL — alarm cannot guarantee upstream visibility"* — and stamps the readiness state file with `canonicalRemoteOverridden: true` until reverted.
- **Fetch coordination (addresses F11):** concurrent fetch requests (Layer B + Layer C ticks coinciding) are coalesced via an in-process `Map<remote, Promise<FetchResult>>` — second caller awaits the first's promise rather than racing a duplicate `git fetch`. For cross-process safety on the same host, an advisory lock at `.instar/state/.fetch.lock` (`flock`-style, 60s break-stale) prevents two CLI invocations of the same tick from doubling up. The break-stale window is intentionally `2 × fetchTimeoutMs` (60s = 2 × 30s default) so a real in-flight fetch (bounded by the 30s timeout) cannot trip the break-stale; preserve this relationship if either is tuned (per iter-3 Scalability NF1).
- **Fetch failure:** do NOT silently fall back. Raise a **low-priority Attention item**: *"Release-readiness check could not reach canonical ref — last evaluated at <ts>."* Deduped per failure episode. **Cross-feature dedupe:** Layer C's local-fallback degradation event (§4.3.1) shares this episode key — a single fetch failure produces one signal, not two.
- **Analyzer is invoked against the fetched ref, not local HEAD (addresses F6, F-Adversarial #6):** Layer B activation is gated on a prerequisite script change to `analyze-release.js`. That script today hardcodes `${tag}..HEAD` in `getCommitsSinceTag`, `getChangedFiles`, `getFileDiff`, `getDiffStat` (lines 55-93) and parses only `--json`/`--recommend-only` flags (line 36-38). The prerequisite change must:
  1. Add `--ref=<rev>` to the arg parser (default `HEAD` — preserves today's behavior for the prepublish chain in `package.json`).
  2. Thread `refArg` through `getLastReleaseTag` (the tag-from-ref query), `getChangedFiles`, `getFileDiff`, `getDiffStat`, `getCommitsSinceTag` — replacing the literal `HEAD` with the parameterized ref.
  3. Layer B invokes `analyze-release.js --json --ref=FETCH_HEAD`.
  Until the prerequisite change has merged and is on `main`, Layer B's recurring job must remain `enabled: false` (sequencing in §10). The script-change PR ships independently of the sentinel/job PR.

#### 4.2.3 What it computes (decoupled from NEXT.md — addresses F2)

The "blocked" predicate has two **independent** conditions; either is sufficient:

1. **Backlog with unreviewed coverage:** there are commits classified as `features` or `fixes` since the last published tag (from `analyze-release --json`'s `commitClassification`) **AND** (`NEXT.md` is missing OR matches the publish-skip template predicate OR contains any `auto-draft-unreviewed` marker).
2. **Deep coverage gaps:** `analyze-release --json` reports `criticalGaps + highGaps > 0`.

The age signal: **days since the OLDEST unreleased feature commit** (not newest — prevents a trickle of merges from resetting the clock, per Adversarial #3).

**Caching (addresses F4):** the full computation is cached at `.instar/state/release-readiness.json` keyed on `{ canonicalHeadSha, lastTagSha, ourScriptVersion }`. A cron tick that finds the cache key valid does no git work beyond `git rev-parse FETCH_HEAD`. **Cache-miss cost (called out per iter-2 Scalability N2):** on a SHA change, the cache miss invokes `analyze-release.js --json` which today walks `getFileDiff` once per changed file (4 passes — routes, CLI, config, exports). For a ~46-file release backlog this is ~180 `git diff -- <file>` shell-outs. This is acceptable because cache miss only fires when canonical `main` advances (release-cadence rate, not cron-cadence rate); recompute does not run per tick. A future optimization could batch the four passes into a single whole-range diff walk — tracked but not blocking.

#### 4.2.4 Signal, not authority (near-silent)

- Below threshold (default: backlog age < 2 days) → **no message.** State file + log line only. Routine status never buzzes the user.
- At/above threshold → exactly ONE Attention-Queue item per stall episode (`POST /attention`). Priority by age (defaults: low ≥2d, medium ≥4d, high ≥7d).
- **Stable dedupe key (addresses Lessons #3):** the episode is keyed on **the SHA of the oldest unreleased feature commit** — stable across ticks, stable across re-evaluations, only changes when the backlog truly changes. Not a per-tick episode id (the scar from `feedback_notifications_near_silent`).
- **Hysteresis (addresses Adversarial #3 flap):** after an auto-resolve, the same episode cannot re-raise within 12 hours (configurable).
- The check **never publishes, never edits gates, never modifies NEXT.md state.** Signal-only.

#### 4.2.5 Lifecycle owner + race guard (addresses Lessons #1)

A single class `ReleaseReadinessSentinel` owns the episode lifecycle (detect → surface → auto-resolve → reap). Public surface:
- `tick()` — the cron entry point.
- `resolveEpisodesInRange(lastTagSha, newTagSha): Resolved[]` — consulted by `check-upgrade-guide.finalizeGuide()` when it ships a new tag. The sentinel iterates open episodes and auto-resolves every one whose `oldestSha` is an ancestor of `newTagSha` (`git merge-base --is-ancestor`). This addresses F9 — a finalize correctly closes episodes even when the oldest-unreleased SHA churned during the open window, and two open episodes spanning overlapping ranges both resolve cleanly. *(Replaces the v2 `isEpisodeActive(commitSha)` predicate, which had the SHA-churn miss documented in iter-2 Adversarial N3.)*
- `reapStaleEpisodes(now, ttl)` — TTL-reap (default 30 days) for episodes whose backlog vanished without a finalize (e.g. branch abandoned). Reaps the open Attention item with `status: resolved, reason: "stale"` — the reason is loud (recorded, auditable), not a silent catch.

#### 4.2.6 Fail-loud (addresses F-Security #3 + Scalability #5)

Any uncaught error inside `ReleaseReadinessSentinel.tick()` is caught at the top level and converted to a **low-priority Attention item** *"Release-readiness check failed to evaluate at <ts>: <error-class>."* Deduped per error-class episode. **A silent catch is forbidden** — it would re-create the exact silent-failure bug §3 fixes. The fail-loud path is unit-tested.

#### 4.2.7 Observability + rollback surface (addresses Integration #6, F13)

- **`GET /release-readiness`** (bearer-gated): returns `{ state, oldestUnreleasedCommit, backlogAgeDays, lastTickAt, lastSignalAt, openAttentionId, cacheHeadSha, canonicalRemoteOverridden }`. Cheap, static read of the state file. **Multi-machine note (per iter-2 Adversarial N5):** served from the local agent host's cache; on a follower (non-lease-holder) the state may lag the leader by up to one lease-handoff window. The route advertises this in its response header `X-Readiness-Source: leader|follower` so dashboard callers can show staleness if relevant.
- **`POST /release-readiness/rollback`** (bearer-gated, addresses F13, iter-3 Adversarial V5 + Security audit-log): authenticated revert endpoint that (a) flips `featureRollout.canonicalRefScan` to `false`, (b) disables the recurring job (`enabled: false` in the per-slug schedule manifest), (c) resolves all open release-readiness Attention items with `reason: "rolled-back"`, (d) leaves `.instar/state/release-readiness.json` in place (cheap, idempotent on re-enable). Callable from any agent session — agents do not need to clone the repo or run a local script.
  - **Rollback is itself a visibility surface, not a silent kill (iter-3 V5).** Every invocation MUST: (1) raise a **HIGH-priority Attention item** *"release-readiness alarm disabled by session <id> at <ts> — re-enable via POST /release-readiness/enable"*; (2) append an audit entry to `logs/sentinel-events.jsonl` (the existing sentinel audit trail); (3) append to a `rollbackHistory[]` array in the readiness state file with `{ts, sessionId, sourceIp, reason}`. Without these, the rollback endpoint would itself be the silent-failure surface this entire spec exists to prevent. The audit trail is unit-tested as part of §6.
- The CLAUDE.md template gains a one-line mention under "Registry First" (Agent Awareness standard) — see §7 for the matching `migrateClaudeMd` block.

### 4.3 Layer C — Reconciler reads canonical main + speaks on skip (feature-flagged, batched, degradation-safe)

Fix the wrong-source half of the board auto-register.

#### 4.3.1 Feature-flag + graceful degradation (addresses Integration #3)

- New config flag `featureRollout.canonicalRefScan` (default **off** under graduated rollout; flips on per the rollout track).
- When ON: scan against canonical main as below.
- When OFF: today's local-tree scan (preserves behavior; no boot risk).
- **Boot safety:** all canonical-ref work is inside a `try` whose `catch` falls back to the local-tree scan AND emits a single degradation event per failure episode. **The reconciler must never throw into boot.**

#### 4.3.2 Canonical-ref scan, batched (addresses F3)

- Use the same `releaseReadiness.canonicalRemote` + bounded `git fetch` from §4.2.2 (Layer C piggybacks on Layer B's fetch when both run within `releaseReadiness.fetchTimeoutMs` of each other — single fetch per cadence-window).
- **Single-call tree read:** `git ls-tree -r --name-only FETCH_HEAD docs/specs/` → set of spec paths on main, one call. For each path, read content via a single `git cat-file --batch` invocation (streaming all needed blobs in one process).
- **Single-pass merge introspection:** instead of per-spec `git merge-base --is-ancestor`, run one `git log FETCH_HEAD --name-only --pretty=format:%H` scoped to `docs/specs/` and `.instar/instar-dev-traces/` — build an in-memory map of spec-path → first-merge-commit. `merged` is now derived in O(1) lookup per spec.
- **Per-tick scope:** the scan only processes specs whose first-merge-commit is newer than the reconciler's `lastProcessedCommit` cursor (cursor stored alongside the existing OCC `version`). Bounded backfill (unchanged from PR #401) runs only on the first tick after enable. **`cat-file --batch` cost (per iter-2 Scalability N4):** the steady-state read set is `O(new specs since cursor)`, not `O(total specs)`. The bounded backfill (first-tick-after-enable) is the only `O(total)` operation and runs once.

Replaces the inferred `merged = approved && traceExists` shortcut with real merge-state from main.

#### 4.3.3 Skip signal — scoped to avoid noise (addresses Adversarial #4, F10)

When a tick's "should have registered" set is non-empty but the actual register-or-update count is zero, emit a degradation event. After K consecutive ticks (default K=3), escalate to a low-priority Attention item. **First-enabled tick (addresses F10):** the very first tick after `featureRollout.canonicalRefScan` flips ON uses K=1 — there is no baseline yet, and an immediate signal on first enable is the right zero-tolerance behavior. Subsequent ticks revert to K=3 (steady state).

**"Should have registered" is scoped to specs matching the existing registration predicate**, not "any newer spec":
- Frontmatter `approved: true` AND
- Frontmatter does NOT include `kind: meta` / `kind: report` (out-of-band specs that legitimately never register) AND
- Not on the existing reconciler skip-list.

Renames are detected via the `git log --follow` path on the new in-memory map (a rename is a non-skip; the existing record updates). Deletes are non-skips (the spec is gone from main; not eligible to register).

### 4.4 The unifying outcome

| Loop | Reads main | Speaks on skip |
|------|-----------|----------------|
| Publish | ✅ (already) | ✅ via Layer B (decoupled, fail-loud) |
| Board auto-register | ✅ via Layer C (feature-flagged) | ✅ via Layer C scoped skip signal |
| Layer B itself | ✅ (canonical fetch + cache) | ✅ (fail-loud is normative) |

## 5. Standards conformance (self-audit)

- **Structure > Willpower:** auto-seed > "remember to update NEXT.md"; recurring check > "remember to look"; reconciler reads main > "remember to be on right branch."
- **No-manual-work:** A removes authoring chore; B removes "did the release go?" check.
- **Signal vs authority:** B & C are signal-only; blocking authority stays with prepublish/CI gates. The publish-gate amendment in §4.1.1 is the *existing gate* learning to recognize unreviewed content — it does not introduce new blocking authority outside the gate.
- **Near-silent:** silent below threshold; single deduped item above; auto-resolves; stable SHA-keyed dedupe (not a resettable id, per the documented scar).
- **3-tier testing:** required (§6).
- **Migration parity:** new job template + always-overwrite contract + config-defaults via `migrateConfig` (§7).
- **Side-effects review:** owed at convergence Phase 4 across all 7 dimensions (over/under-signal, abstraction fit, interaction with finalize, rollback cost, etc.).
- **Verify-wired:** §6 requires wiring-integrity tests + the Phase-1 "feature is alive" E2E for the sentinel, the new route, and the Layer C canonical-scan path.
- **Bug-fix evidence bar:** §6 reproduces the original silent stall against a fixture, asserts it now surfaces — not just unit tests.

## 6. Testing plan (all three tiers — non-negotiable)

- **Unit:**
  - `--draft-guide`: empty/template NEXT.md → full draft with all required sections + seeded bump + unreviewed marker; populated NEXT.md → additive uncovered-delta block only, never clobbers; idempotent re-run; placeholder fallbacks neutralized to HUMAN-REQUIRED markers; HTML-comment sanitization; length cap; forged-marker rejection.
  - Publish-gate amendment: NEXT.md with unreviewed marker → `check-upgrade-guide.js` exits non-zero; `publish.yml` skip predicate (extracted into a unit-testable function) sets skip=true.
  - `ReleaseReadinessSentinel.tick()`: blocked-and-aged → signal; clean → no signal; backlog-cleared via finalize → auto-resolve race-guard; dedupe across ticks on SHA key; hysteresis prevents re-raise within 12h; thrown error → low-priority Attention (fail-loud).
  - Canonical fetch: timeout → low-priority Attention; success → cache populates; cache-hit avoids redundant git work.
  - Layer C: spec on main but absent locally → detected as merged; local-only spec → NOT merged; rename detected (no skip); delete detected (no skip); `kind:meta` excluded from "should have registered"; OFF flag preserves today's behavior.
  - Skip-signal scoping: tick that should register but doesn't → degradation; K consecutive → Attention.
- **Integration (HTTP):** `GET /release-readiness` returns expected JSON; `POST /attention` from the sentinel succeeds; bearer-gated correctly.
- **E2E (the "feature is alive" test):** reproduce the *original failure* — backlog of unreleased features + stale-template NEXT.md — and assert (a) the readiness check raises exactly one Attention item keyed on the oldest-commit SHA, (b) `--draft-guide` produces a NEXT.md that still **fails publish** until the unreviewed markers are removed, (c) removing the markers + finalize auto-resolves the Attention item atomically. Per the bug-fix evidence bar, the original silent stall must be reproduced and shown to now surface.

## 7. Migration parity

- New job template `src/scaffold/templates/jobs/instar/release-readiness-check.md` — installed via `InstallBuiltinJobs.ts` (always-overwrite template body; per-slug `enabled: false` preserved). Ships `enabled: false` in the schedule manifest. Reaches existing agents via `PostUpdateMigrator.migrateBuiltinJobs` (`PostUpdateMigrator.ts:1257`) on update.
- New config defaults under `releaseReadiness.*` (`backlogAgeDaysSilent`, `*Low/Medium/High`, `fetchTimeoutMs`, `canonicalRemote`, `hysteresisHours`, `skipEscalationK`) and `featureRollout.canonicalRefScan` — added to `ConfigDefaults.ts` AND patched into existing agents via `migrateConfig()` with existence checks (no clobber of operator overrides).
- **CLAUDE.md template change reaches existing agents (addresses F12, iter-3 Integration I3-N3).** §4.2.7 adds a paragraph under "Registry First" mentioning BOTH endpoints — `GET /release-readiness` (status) AND `POST /release-readiness/rollback` (revert) — so any agent learning the capability also learns the revert path. `src/scaffold/templates.ts` ships the new paragraph for fresh `init`. Per the Migration Parity Standard, existing agents pick it up via `PostUpdateMigrator.migrateClaudeMd` — add an idempotent content-sniff block keyed on the marker string `/release-readiness` (skip if present, append the canonical paragraph covering both endpoints if absent). Without this, new agents would diverge from existing agents on a documented capability — the exact failure the standard exists to prevent.
- New state file `.instar/state/release-readiness.json` — created on first tick (no migration needed; absent is the valid initial state).
- `analyze-release.js`, `check-upgrade-guide.js`, `publish.yml` — repo dev-tooling, no agent migration (confirmed: not referenced in `InstallBuiltinJobs.ts`, `templates.ts`, or any migration path). **However:** the `--ref` flag added per F6 must be backward-compatible — default `HEAD` preserves today's prepublish behavior (`npm run check:release` invoked from `prepublishOnly` chain in `package.json:41`). §6 includes a unit test asserting `--ref` absent ⇒ today's exact behavior (iter-2 Integration N2).
- `featureRolloutScan.ts` / `FeatureRolloutReconciler` — agent-installed runtime code; reaches existing agents on `instar` package update (standard npm path).

## 8. Out of scope

- Per-PR NEXT.md enforcement in the instar-dev commit gate.
- Relaxing/restructuring existing prepublish/CI gates beyond the unreviewed-marker amendment in §4.1.1.
- Changes to the release-tier / deployment-lockdown layers in `publish.yml`.

## 9. Open decisions (for iteration 2 + Justin)

1. **Canonical-ref read mechanism for Layer C** — **RESOLVED (normative):** bounded `git fetch --depth=1` then `git show FETCH_HEAD:...` / `cat-file --batch`. The "no-fetch / read local main" option is rejected (stale-local-main is the exact bug). Iter-1 Adversarial #5 + Security #4 + Integration #3.
2. **Backlog-age thresholds + hysteresis** — propose silent <2d, low ≥2d, medium ≥4d, high ≥7d; hysteresis 12h. Defensible? (Iter 2 may propose tighter.)
3. **K for Layer C skip-signal escalation** — default 3. Aligned with §4.2's escalation curve?
4. **Should `GET /release-readiness` be public (no-auth) for dashboard polling, or stay bearer-gated?** Lean bearer-gated for parity with other state endpoints; revisit if dashboard polling cost matters.
5. **Layer A in CI** — should a bot keep NEXT.md drafted on each main push, in addition to the readiness job + manual? Lean NO — keeps a human firmly in the edit loop.

## 10. Rollout + Rollback

**Rollout — implementation sequencing (addresses F6 + graduated-rollout track):**

The work ships in **three PRs**, in order, because PR-2 depends on a script-level prerequisite:

1. **PR-1 — analyze-release.js `--ref` prerequisite.** Adds the `--ref=<rev>` flag and threads it through `getLastReleaseTag`/`getChangedFiles`/`getFileDiff`/`getDiffStat`/`getCommitsSinceTag`. Default `HEAD` (preserves prepublish chain). Unit test covers `--ref` absent ⇒ today's behavior. Ships independently; can land before either of the next two.
2. **PR-2 — Layer A + Layer B (sentinel, route, job).** `--draft-guide` mode, publish-gate amendment, `ReleaseReadinessSentinel`, the new job template (ships `enabled: false`), `GET /release-readiness`, `POST /release-readiness/rollback`, all config defaults + migrations. **Hard requirement:** does not merge until PR-1 is on `main`. The CI check (per iter-3 Scalability NF2 + Integration I3-N1) MUST be a **required status check** in PR-2's branch protection (not just an opt-in job step) and MUST genuinely prove PR-1 landed, not just that the flag is silently accepted: invoke `analyze-release.js --ref=<a known prior-release tag SHA> --recommend-only` and assert the output differs from `--ref=HEAD` (i.e. the flag is actually threaded, not silently ignored).
3. **PR-3 — Layer C (canonical-ref scan).** `featureRollout.canonicalRefScan` default OFF, the batched `ls-tree` / `cat-file --batch` / single-pass merge scan, the K=1-then-K=3 skip signal. Independent of PR-2; can ship in parallel once PR-1 has landed. PR-3 carries the **same required-status-check** as PR-2 (`--ref=<known SHA>` differs from `--ref=HEAD`) — per iter-3 Integration I3-N2, do not rely on author memory to enforce the prerequisite.

`ships-staged: true` in frontmatter for the sentinel and the canonical-ref scan. Stages: dry-run (job ships `enabled: false`, log-only) → live (operator flips `enabled: true`, Echo first) → default-on. Layer C's `featureRollout.canonicalRefScan` advances on the same track.

**Rollback (addresses Integration #4, F13):**
- **Primary path (any agent, any session):** `POST /release-readiness/rollback` (§4.2.7) — bearer-gated, flips the flag OFF, disables the job, resolves open Attention items as `rolled-back`, leaves the state file in place. **No script clone needed.**
- Job file `.instar/jobs/instar/release-readiness-check.md` — additionally, `InstallBuiltinJobs` retires the template automatically (flips `enabled: false`) when the template is removed from `src/scaffold/templates/jobs/instar/` in a future package version.
- Config keys under `releaseReadiness.*` and `featureRollout.canonicalRefScan` — orphaned but harmless on package-level revert.
- State file `.instar/state/release-readiness.json` — left in place (cheap, ignored). Re-enable picks up the prior cache key on first tick.
- `featureRolloutScan.ts` changes — reverting the PR restores prior behavior (the OFF flag default means no-op on agents that never enabled it).

**Multi-machine note:** within a single agent, the multi-machine lease guarantees a single readiness-job runner (per the Cross-Machine Seamlessness standard). Across agents (Echo + others), each agent runs its own readiness check on its own attention queue — that's correct, not a dedupe gap. Followers serving `GET /release-readiness` may return cache that lags the leader by ≤1 lease-handoff (advertised via `X-Readiness-Source` header, per §4.2.7).
