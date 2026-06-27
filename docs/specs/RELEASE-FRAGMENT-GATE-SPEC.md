---
title: Release-Fragment Gate — a release must never silently skip merged work
date: 2026-06-27
author: echo
slug: release-fragment-gate
parent-principle: "Structure beats Willpower"
parent-principle-fit: "The release-note fragment (upgrades/next/<slug>.md) is required for a version to cut — the publish workflow refuses to bump without one — and a HARD local pre-push gate (scripts/pre-push-gate.js §3b) already blocks a fragment-less release-relevant push. Yet on 2026-06-27 PRs #1295/#1296/#1297 (real Dynamic-MCP fixes) reached main with no fragment and the publish ran GREEN and silently skipped: assemble-next-md found 'nothing to assemble', guide-check set skip=true, no version cut, fixes stranded ~7h, and a prior session misread the green run as an 'upstream pipeline hiccup'. The hard gate exists but runs in husky LOCALLY — it is bypassed by the server-side squash/bot/auto-merge path that never runs husky and by INSTAR_PRE_PUSH_SKIP=1. So the requirement is enforced everywhere EXCEPT where merges actually land, and its evasion is silent. Moving the SAME requirement to a server-side required CI check (un-bypassable) + making the residual silent-skip a LOUD agent-side event is the structural enforcement this principle demands: a guarantee at the merge boundary, not a local hook anyone can route around."
eli16-overview: RELEASE-FRAGMENT-GATE-SPEC.eli16.md
commitment: CMT-1819
review-convergence: "2026-06-27T18:53:02.190Z"
review-iterations: 3
review-completed-at: "2026-06-27T18:53:02.190Z"
review-report: "docs/specs/reports/release-fragment-gate-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 0
contested-then-cleared: 1
approved: true
approved-by: Justin
approved-via: "Telegram topic 28130 (2026-06-27 11:57 PDT): 'Approved and you have my preapproval for any decisions needed in this autonomy session', after reading the converged-spec ELI16 summary."
---

# Spec — Release-Fragment Gate

## Problem

The publish pipeline (`.github/workflows/publish.yml`) gates the version bump on
release-note content: `scripts/assemble-next-md.mjs` folds every
`upgrades/next/*.md` fragment into `upgrades/NEXT.md`; with no fragments the
`guide-check` step sets `skip=true` ("No NEXT.md found — nothing to publish") and
every downstream step (bump, publish, tag) is `if: skip != true`. The run exits
**green** having published nothing. The refusal is correct; its **silence** is the
bug.

### The requirement already exists — but only where merges DON'T happen

A hard gate already enforces the fragment:

- `scripts/pre-push-gate.js` **§3b** (the `#23` block) pushes a missing-fragment
  finding to `errors` (not `warnings`) for a release-relevant `src/` push, with the
  rationale literally "publish.yml SILENTLY SKIPS the release". It is a **hard**
  block — but it runs in **husky on `git push`**, bypassable by
  `INSTAR_PRE_PUSH_SKIP=1` and, crucially, by **any server-side merge** (GitHub
  squash-merge, the green-PR auto-merge, a bot merge) that never runs husky at all.
- `scripts/instar-dev-precommit.js` `inScope()` references `upgrades/next/` only in
  an **advisory** nudge.

So the requirement is enforced on a local `git push` and nowhere else. The
2026-06-27 incident merged via the server-side path, evaded the only hard gate, and
the publish swallowed the result silently. **The root cause is not "no gate" — it
is "the gate is bypassable at the real merge boundary, and its bypass is silent."**

### The incident (2026-06-27)

PRs #1295 (operator-approval tap auth), #1296 (config loader dropped
`sessions.dynamicMcp`), #1297 (load-ordering no-op) — all real `src/` fixes —
reached main with no fragment. Publish ran green and skipped. v1.3.685 stayed the
latest published version for ~7h. The unstick (PR #1298) was a single fragment; the
moment it landed, v1.3.686 cut normally — proving the pipeline was never broken,
just silent and locally-bypassed.

## Goal

A release-affecting change can **never** reach `main` and then silently fail to
ship. Enforce the fragment requirement **at the merge boundary, server-side** — under
branch-protection/ruleset coverage so the normal squash/auto-merge path cannot route
around it (admins, ruleset exceptions, and emergency direct pushes remain a
deliberate, logged escape, not a silent one — and the Layer-2 poller catches even
those) — and make any residual fragment-less-but-merged state a **loud, durable,
auditable event**, never a green no-op.

## Signal vs. Authority (mandatory declaration)

Per the constitution's *Signal vs. Authority* article and the design-pipeline P2
rule (any spec proposing a guard/checker must declare which it is):

- **Layer 1 (PR-time CI gate) is an AUTHORITY** — it blocks a merge. Its veto rests
  on an **objective binary** ("a fragment, or an auditable opt-out, is present —
  yes/no"), exactly the shape the existing `eli16-pr-gate` already establishes as an
  acceptable blocking precedent. The `release-relevant` path predicate is declared a
  **fallible signal**, never the thing that vetoes: a false positive is always
  escapable by adding a one-line opt-out fragment. The block is carried by the
  presence-or-optout condition, not by the predicate's correctness.
- **Layer 2 (publish-side + agent-side backstop) is a SIGNAL** — it never fails a
  build or vetoes a person; it surfaces. This matches the established posture of the
  `ReleaseReadinessSentinel` (publish.yml comment: "surfaces the blocked release as
  a signal") and keeps the publish *refusal* a deterministic refuse-to-self-act, not
  a veto.

## Frontloaded Decisions

Every build-time decision is resolved here with a concrete default; **no decision is
parked on the user.** (`## Open questions` is intentionally empty — see end.)

| # | Decision | Resolution (default) |
|---|----------|----------------------|
| D1 | Layer 2 publish-step: fail the run, or surface? | **Surface, never fail the run.** The work is safely merged; the defect is visibility, and a red `main` publish is itself noise. Layer 2 emits a loud `::warning::` + `$GITHUB_STEP_SUMMARY` and the durable signal is raised agent-side (D7). |
| D2 | Layer 1 first-ship posture | **Warn-only soak first** (comments via the gate, status reported but `neutral`/non-blocking), then flip to a **required, blocking** check. Flip criterion is a deliverable, not a later decision (D3). |
| D3 | Warn→block flip criterion (mechanical) | Scope is **instar-repo PRs to `main`** (the only population this workflow observes — `.github/` does not reach the fleet), NOT "the fleet". The gate emits a machine-readable verdict line per PR to a rollout log (`logs/release-fragment-gate-rollout.jsonl`: pr#, verdict, whether a fragment/opt-out was later added). A **false-positive** is defined objectively: a `FAIL` verdict that the author resolved by adding a one-line `internal-only` opt-out fragment (i.e. the change genuinely needed no user note) — distinguished from a true-positive `FAIL` resolved by adding a real fragment. **Flip when: ≥15 release-relevant instar-repo PRs have passed through the gate with zero false-positive `FAIL` verdicts over ≥7 days.** The registration itself (marking the check required in branch protection) is the operator's one admin action — surfaced as a ready-to-do item when the criterion is met, never a fuzzy judgment. |
| D4 | Include a Layer-0 husky advisory→hard change? | **No.** A hard local pre-push gate already exists (`pre-push-gate.js §3b`); the gap is server-side, which Layer 1 closes. Adding local-commit blast radius buys no incremental coverage. Excluded from this spec. |
| D5 | Build scope | **Layer 1 (warn-only→required) + Layer 2 (fix the agent-side Sentinel trigger + a non-load-bearing CI annotation).** Layer 0 excluded. |
| D6 | The `release-relevant` predicate | **A NEW single-source module `scripts/release-relevant-paths.mjs`** = the positive set (`src/`, `scripts/`, `.husky/`, skill code + `SKILL.md` under `skills/`) **+ explicit additions** (`package.json`, `package-lock.json`, `.github/workflows/**`, `.instar/config defaults` shipped in-repo, skill `templates/**`) **− explicit exemptions** (`**/*.test.ts`, `tests/**`, `docs/**`, `*.md` outside skill SKILL/templates, the fragment dir itself). Paths are **canonicalized** (normalized, `..`-rejected, case-folded on case-insensitive match) before matching. `inScope()` (precommit) and `pre-push-gate.js §3b` are **refactored to consume this module** so all three callsites share ONE definition (Structure beats Willpower / DRY). Publish-side Layer 2 biases **"relevant unless known-non-release"** (fail toward surfacing). |
| D7 | Layer 2 durable surface | **The agent-side `ReleaseReadinessSentinel`** (a poller that reads `main` independently of CI, so it catches even `[skip ci]` pushes that bypass the publish job). It already detects "unreleased feat/fix AND guide blocks publish"; this spec (a) adds a **fast trigger** for the specific "release-relevant merge with no fragment" case so it does NOT wait out the 2-day backlog floor, and (b) documents honestly that it is **dev-gated/ships-dark** — Echo dogfoods it; on the fleet the CI `::warning::` is the (ephemeral, best-effort) surface until the Sentinel graduates. The CI step NEVER claims to raise an Attention item (it architecturally cannot reach the agent's Attention store). |
| D8 | Opt-out mechanism | **Reuse the existing diff-verified `internal-only` fragment lane.** A genuinely no-user-impact change adds an `upgrades/next/<slug>.md` carrying the standalone `<!-- internal-only -->` directive (already understood by `assemble-next-md.mjs` and diff-verified by `pre-push-gate.js §3c`). This makes "needs a release but no user-facing prose" explicit and durable, satisfies the objective binary, and is auditable — **no new free-text PR-body marker** (which any fork author could self-assert, reintroducing a deliberate silent-skip at scale). |
| D9 | Bot-author exemption | **Exempt ONLY the release-cut bot's authenticated actor identity** (`github.event.pull_request.user.login` == the known github-actions release bot login AND `user.type == Bot`), NEVER a title/commit-message string. A `chore: release` PR title is fully author-controllable, so matching on it would let any human title a fragment-less PR `chore: release …` to bypass Layer 1 — keyed on identity, that spoof fails. NOT a blanket `user.type == Bot` exemption (fleet work is agent/bot-authored; a blanket bot exemption makes Layer 1 inert for its target population). Agent authors are gated as humans. Evasion unit test: a human-authored PR titled `chore: release` is still gated. |
| D10 | Fail posture of the gate code | **Fail-CLOSED.** A Layer-1 internal error (API error, malformed event, throw) reports the check **failed/red**, never green — a silent-skip inside the anti-silent-skip gate is the one outcome forbidden. Layer 2's detect, on its own internal error, raises the Sentinel's documented eval-failure signal, never a silent catch. |
| D11 | Layer-2 commit-window boundary | **Bound on the actually-published source SHA, not the release commit's ancestry.** The authoritative source is the **annotated `vX.Y.Z` tag** (written only by the release bot, so it is not PR-mutable): the publish records the built-from SHA in the tag message, and the detect uses `git log <lastPublishedSha>..HEAD`. (An in-repo `.instar/last-published.json` is NOT trusted as the boundary — it is PR-mutable and D6 even classes config defaults as release-relevant, so an attacker could advance it to ~HEAD and blind the backstop; the tag is release-bot-only.) This survives the publish-side rebase-retry loop that otherwise replants the release commit above a concurrently-merged fragment-less PR and buries it (false-negative). A **missing/unparseable boundary** (e.g. the first publish after this ships, before any new-format tag exists) raises the eval-failure signal and surfaces ALL reachable commits — **never** a silent `sha=HEAD` empty range. Requires `fetch-depth: 0` (or a targeted fetch of the boundary tag) — a depth-1 checkout cannot resolve the window. |

## Design

### Layer 1 — required PR-time CI gate `release-fragment-gate` (prevention)

A workflow mirroring `eli16-pr-gate.yml`'s **shape and discipline**:

- **Trigger / permissions (hard security requirements):** `on: pull_request`
  (NEVER `pull_request_target`), `permissions: contents: read` + `pull-requests:
  read`. The gate **never checks out or executes PR-head code**: the predicate /
  decision module is loaded **only from the base ref**
  (`github.event.pull_request.base.sha`), never the PR-head or merge ref — otherwise
  a PR author could rewrite `release-relevant-paths.mjs` to always-pass (neutering
  the gate) AND run arbitrary JS in the runner. The gate reads only the
  changed-file list + body. Untrusted PR body/title are passed via `env:` (not
  `${{ }}` interpolation into a shell) and read in Node from `process.env` — the
  exact injection-safe pattern `eli16-pr-description-check.mjs` already uses. **Labels
  are NOT an opt-out path** (the only durable opt-out is the committed `internal-only`
  fragment, D8 — a label is an ephemeral, triage-assignable self-assertion that would
  reopen the silent-skip-at-scale hole); the meaningful re-trigger is `synchronize`
  when a fragment commit is pushed.
- **Decision (pure function `checkReleaseFragment({ files, body, authorLogin,
  authorType, title })` + CLI wrapper):** FAIL iff — (a) changed files include a
  release-relevant path (D6 predicate), AND (b) the PR adds/modifies no
  `upgrades/next/*.md` file. The opt-out (D8) is itself an `upgrades/next/*.md` file,
  so its presence already satisfies (b) at the **file-list level** Layer 1 operates
  on — Layer 1 does NOT read fragment content (it has only the files API); the
  *legitimacy* of an `internal-only` opt-out is enforced downstream at
  `assemble-next-md` + `pre-push-gate.js §3c`, not here. The changed-file list is
  fetched via the PR **files API** (`status` field, so add-vs-modify is known) with
  **full pagination** (never a truncated list).
- **Presence-not-validity is deliberate, and safe.** Layer 1 checks fragment
  *presence*, not content (it has only the file list — reading content would require
  executing/checking-out PR-head, the N1 vector). A bogus/empty fragment therefore
  passes Layer 1 — but it does NOT re-open the silent skip: `assemble-next-md` THROWS
  on a content-less or unparseable fragment (a loud RED publish run), and the
  `internal-only` legitimacy is diff-verified by `pre-push-gate.js §3c`. So the worst
  a junk fragment buys is a loud failure downstream, never a silent green skip — which
  is the property that matters. (A future enhancement could add a cheap base-ref-safe
  content sniff; out of scope here.)
- **Rollout:** warn-only (non-blocking `neutral`) first; flip to required per D2/D3.
  **Registering it as a required status check on `main` is an explicit deliverable**
  — without that registration the gate is cosmetic. And because a required-check
  registration can silently drift off (a ruleset edit, a renamed check, branch-
  protection drift), a lightweight periodic audit asserts `release-fragment-gate` is
  STILL a required check on `main` and surfaces a loud signal if it has been
  de-scoped — closing the loop so the guarantee can't quietly evaporate the same way
  the original silent skip did. (Reuses the existing guard-posture/release-readiness
  surface rather than a new watcher.)
- **Cost:** per-PR `concurrency: { group: release-fragment-gate-${{ pr }},
  cancel-in-progress: true }` collapses an `edited`/`synchronize` storm; the job
  early-exits fast when nothing is release-relevant (it does NOT use a workflow-level
  `paths:` filter — a path-filtered required check sits "pending" forever and stalls
  merges). No full `actions/checkout` of the tree — vendor/sparse-fetch only the
  predicate module.

### Layer 2 — the durable backstop (signal)

Two non-load-bearing-in-CI parts that together guarantee the residual case
(direct push, `[skip ci]`, a bot path that somehow evades Layer 1) is never silent:

1. **Agent-side `ReleaseReadinessSentinel` (the durable surface, D7).** Extend its
   blocked-detection to fire FAST on "release-relevant commits since the last
   published SHA with no fragment" (path-predicate-aware, sharing D6), bypassing the
   2-day backlog floor for this specific case. It raises ONE deduped Attention item
   (its existing surface) — this is the durable, ack-able signal. Honest status: it
   is dev-gated/ships-dark (Echo dogfoods); the spec does NOT pretend it covers the
   fleet today.
2. **Publish-side loud annotation (best-effort, CI-only).** In `publish.yml`'s
   `guide-check` skip branch, when the skip would happen BUT the commits since the
   last published SHA (D11) are release-relevant, emit a loud `::warning::` +
   `$GITHUB_STEP_SUMMARY` naming the unreleased commits (count-capped). **Never fails
   the run** (D1), **never claims to raise an Attention item**, and treats all
   commit messages/filenames as **opaque data** — read via NUL-delimited
   (`-z`) git output into Node `execFile`/`spawn` argv arrays, **never** a shell
   string or `execSync` interpolation (the `instar-dev-precommit.js` string-interp
   pattern is the explicit anti-pattern NOT to copy), and never echoed raw through
   `::`-prefixed lines or `$GITHUB_OUTPUT`/`$GITHUB_ENV` (workflow-command
   injection). A committed off-switch file mirrors the existing
   `.instar/release-tier.json` precedent so the annotation can be silenced without a
   workflow edit.

### What this does NOT change

- The publish refusal (no fragment ⇒ no version) is CORRECT and stays. We add
  un-bypassable prevention + loud visibility; we never weaken the refusal.
- No change to `resolve-publish-version.mjs` / `resolve-release-tier.mjs` /
  `.instar/release-tier.json` semantics.

## Cross-machine posture

- **Layer 1** runs in GitHub Actions — machine-agnostic, no agent state, no
  multi-machine concern.
- **Layer 2 publish annotation** runs in Actions — machine-agnostic.
- **Layer 2 Sentinel** is **machine-local by design** (a single dev agent runs the
  `release-readiness-check` job; its dedup state lives in
  `.instar/state/release-readiness.json`). Posture: **single-owner** — only one agent
  runs the job. It deliberately needs **no fenced lease**: the dedup is advisory, the
  boundary truth lives in `main` (not agent-local state), so the worst case if two
  agents ran it is a duplicate Attention raise (re-derived from `main`), never a lost
  signal or a corrupted decision — the failure direction is safe. On identity/topic
  transfer the new host's first tick re-derives from `main`, so an episode is at worst
  briefly re-raised, never lost. Documented, not silently single-machine.

## Migration parity

- `.github/workflows/**` and `scripts/**` are **repo files**. `.github/` reaches
  only git-clone dev agents (Echo) via `git pull` and reaches the fleet not at all;
  `scripts/` IS in the npm `files` payload (`package.json`) so it ships to the fleet,
  replaced wholesale on npm update. **Neither needs a `PostUpdateMigrator` entry**
  (a migrator patches agent-authored installed files; these are wholesale-shipped
  repo files). Verified: `.husky/` is NOT in the npm `files` whitelist and
  `migrateHooks()` writes only `.instar/hooks/instar/` — so the excluded Layer 0
  (D4) would in any case NOT be a `migrateHooks()` concern; the earlier draft's claim
  was wrong and is removed.
- The Sentinel trigger change (D7) is `src/` code — ships in `dist` to the fleet via
  npm, gated by the existing dev-gate + `release-readiness-check` job `enabled:false`
  default (unchanged). No new migration.

## Test tiers

- **Unit:** the `release-relevant-paths` predicate — both sides of every boundary
  AND **adversarial evasion cases** (case-fold, `..` traversal, trailing slash, a
  runtime file shaped like a test path, the explicit config/template/lockfile
  additions, the docs/test exemptions). **Anti-drift ownership rule:** a guard test
  enumerates the current top-level shipped/runtime roots (derived from the npm `files`
  whitelist) and FAILS if a new top-level root appears that the predicate does not
  explicitly classify as relevant-or-exempt — so a future release-bearing directory
  can't silently fall through as a false-negative. The opt-out parser (standalone
  `<!-- internal-only -->` directive vs a prose mention of the marker — the
  prose-mention-must-not-exempt collision); `checkReleaseFragment` full decision
  table (both sides).
- **Integration:** the Layer-1 CLI over synthetic PR file-lists + bodies + labels +
  author types (fragment present ⇒ pass; release-relevant + no fragment + no optout
  ⇒ fail; internal-only fragment ⇒ pass; test-only ⇒ pass; release-cut bot ⇒ exempt;
  agent author ⇒ gated); the Layer-2 detect over a synthetic git log (release-relevant
  since published-SHA + no fragment ⇒ surfaced; fragment present ⇒ quiet; docs-only
  ⇒ quiet; the rebase-retry/concurrent-merge topology from D11 ⇒ still surfaced).
- **Wiring-integrity (required):** the Sentinel's new fast-trigger is actually
  invoked by the real tick with a non-null path predicate (not a no-op); the shared
  predicate module is the SAME one consumed by `inScope()` and `pre-push-gate.js §3b`
  (one import, not three copies); the gate's fail-closed path reports red on a thrown
  error.
- **E2E/CI:** a smoke proving the Layer-1 gate fails a release-relevant no-fragment
  PR and passes one with a fragment (and one with an internal-only fragment); a smoke
  proving the publish annotation fires on a no-fragment release-relevant skip and
  stays quiet with a fragment.

## Standards parent

Primary: **"Structure beats Willpower"** (exact registry article) — move the
fragment requirement from a locally-bypassable hook to an un-bypassable merge-boundary
guarantee. Secondary: **"No Silent Degradation to Brittle Fallback"** (exact registry
article) — a green publish run that silently skips merged work is the textbook
"looks-protected while fake-protected" degradation this article forbids; this spec
extends it from LLM-gating calls to the release pipeline. Also engages **"Close the
Loop"** (a release must not silently swallow merged work — every shipped change is
re-surfaced until it actually ships).

## Open questions

*(none)*
