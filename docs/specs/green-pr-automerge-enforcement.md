---
title: Green-PR Auto-Merge Enforcement — Phase 7 becomes machinery, not memory
approved: false
eli16-overview: green-pr-automerge-enforcement.eli16.md
topic: 24662
parent-principle: "No Manual Work (user *or* agent)"
ships-staged: true
lessons-engaged: [P1-structure-beats-willpower, P2-signal-vs-authority, P3-migration-parity, P4-testing-integrity, P7-llm-supervised-execution, P10-honest-coverage, P14-distrust-temporary-success, P17-bounded-notification-surface, P19-no-unbounded-loops, L5-state-detection-robustness, B10-verify-landed-before-claiming, B24-gate-latency-vs-client-timeout, graduated-feature-rollout, close-the-loop, cross-machine-coherence]
---

# Green-PR Auto-Merge Enforcement — Phase 7 becomes machinery, not memory

**Status:** v2 (post round-1 review). Author: echo · Created: 2026-06-12 · Topic: 24662
**Companion (required):** `green-pr-automerge-enforcement.eli16.md`

> Per the instar-dev gate, no code ships until convergence (`/spec-converge`) and Justin sets
> `approved: true`.

## The incident (2026-06-12, topic 24662) — and why prose already failed

PR #1084 (reap-notify + resume-queue) went fully green at 15:03 — converged+approved spec,
every commit through the instar-dev gates, all 22 CI checks passing. The authoring agent
(echo) then told the operator *"Merge is yours whenever you're ready."* Justin's correction:
this is a gravity well and a violation he has **already corrected before** (2026-06-09,
topic 23178) — by the time an agent-authored PR is green, it has passed every check and
balance the dev process defines; it is pre-approved by construction, and handing the click
back creates manual work.

The June-9 correction was already "fixed" — as prose. `skills/instar-dev/SKILL.md` Phase 7
("Auto-merge on green — EVERY tier — never pause to ask") and `scripts/safe-merge.mjs` both
shipped on 2026-06-09. They failed on 2026-06-12 for a structural reason: **the build
session died mid-build**, and the sessions that resumed the work re-derived their plan from
the worktree and the conversation — Phase 7 never entered their context. A skill phase is
willpower with extra steps; it does not survive session turnover. While the PR then sat
waiting for a human click, `main` moved and the PR went CONFLICTING — the gravity well
didn't just add a manual step, it cost a full conflict-resolve + CI round.

Two enforcement gaps, two layers:

- **Gap 1 — no machinery merges a green PR when no session remembers to.** (Session death,
  compaction, or plain drift: the merge depends on an agent *remembering* Phase 7.)
- **Gap 2 — nothing intercepts the hand-back at the chokepoint.** An agent ending its
  session with a green unmerged PR gets no structural pushback.

## What exists today (v1.3.500-era main, file:line grounded — corrected by round 1)

- **Phase 7 prose**: `skills/instar-dev/SKILL.md` §"Phase 7 — Auto-merge on green" —
  mandates `node scripts/safe-merge.mjs <PR#> --squash --admin` once green. Instructions
  only; no gate enforces it.
- **`scripts/safe-merge.mjs`** — the merge wrapper this spec builds on. Round-1 foundation
  audit found it is NOT sound enough to promote to unattended authority as-is:
  - It re-imposes the all-checks-green requirement that `--admin` removes — but **`--admin`
    bypasses ALL branch protection** (required checks, required reviews, up-to-date
    branch), and safe-merge re-imposes only the green-checks part (plus an e2e-ran check).
  - **TOCTOU**: no head pinning between its last check-poll and `gh pr merge` — a push in
    that window merges an unverified head (`gh pr merge --match-head-commit` exists for
    exactly this and is unused).
  - **False success**: `process.exit(m.status ?? 0)` exits 0 on a signal-killed/spawn-failed
    merge; it parses `gh pr checks` HUMAN output (no `--json`), and its `/\bpending\b/`
    wait-regex matches check NAMES (a check named `block-pending-migrations` would loop the
    wait to its 20-min cap).
  - **Hardcoded repo** (`REPO = 'JKHeadley/instar'`) with a bare-PR-number interface — a
    caller resolving a different repo would address the wrong PR.
  - No `--delete-branch` support.
  §3.1 hardens it in the same PR (R2 is now "hardened", not "unchanged").
- **`gh` identity is the OPERATOR'S, not the agent's** (round-1 ground truth: `gh auth
  status` on the dev machine resolves to the operator's login via env token). `--author
  "@me"` therefore selects the operator's and sibling agents' PRs too — §3.2's identity
  contract exists because of this.
- **`ReleaseReadinessSentinel`** (`src/monitoring/ReleaseReadinessSentinel.ts`): the
  precedent watcher — repo-gated, episode-keyed, fail-loud, attention-aggregated, with a
  **runtime rollback/enable route pair** and a registry classification of
  `DARK_GATE_EXCLUSIONS: deliberate-fleet-default` (NOT dev-gated — the dev-gate registry
  explicitly bars action-bearing features; `src/core/devGatedFeatures.ts:19-43`).
- **Stop-gate router**: an inline string template in
  `src/core/PostUpdateMigrator.ts` (`getStopGateRouterHook()`, ~:10596) installed to agent
  homes and **always-overwritten** by `migrateHooks()`. It is a THIN CLIENT: per-stop
  decisions are served by `POST /internal/stop-gate/evaluate` server-side (where config,
  gating, and timeouts live). Claude Code Stop events fire at every turn-end, not just
  session exit — per-stop cost budgets matter.
- **Multi-machine reality**: the dev agent runs on a machine pool with a fenced lease
  (`multiMachine.syncStatus.holdsLease`); any always-on watcher must assume a peer instance
  exists.

## Alternatives considered (round-1 external reviewers' challenge)

- **GitHub native auto-merge (`gh pr merge --auto`)**: armed per-PR at creation, merges
  when branch protection is satisfied. Rejected as the primary mechanism for three reasons:
  (1) arming is itself a per-PR session action — the exact "session forgot / died before
  arming" failure this spec kills; (2) native auto-merge honors branch protection's
  up-to-date-branch requirement, and this repo's `main` moves fast enough that PRs are
  near-instantly BEHIND — the wait-for-update-and-full-re-run loop is the conflict-rot
  treadmill safe-merge's `--admin` path exists to avoid (PR #1084 went CONFLICTING within
  the hour); (3) it cannot express instar's hold semantics, identity checks, audit trail,
  runtime kill-switch, or Attention integration. The watcher MAY additionally arm native
  auto-merge as a free belt, but it is not the mechanism of record.
- **A GitHub Actions workflow** (event-driven merge on `check_suite` success): no custom
  daemon, but it would hold admin-bypass merge authority in a repo-resident token visible
  to every contributor, outside the agent's guard manifest / kill-switch / audit
  infrastructure (Observable Intelligence), and it cannot read agent-side state (identity
  bindings, stop-gate snapshot). Instar's standing pattern keeps autonomous authority
  inside the agent's audited monitoring layer.
- **Merge queue**: solves ordering, not the unattended-merge gap; same arming problem as
  native auto-merge and unavailable on this plan/repo configuration today.

## Requirements

- R1 — **Machinery, not memory**: an agent-authored PR on the canonical repo that is green,
  mergeable, and not deliberately held MUST get merged by a background component that
  survives session death. No session needs to remember anything.
- R2 — **safe-merge is the only merge path, HARDENED in this PR** (§3.1): candidate
  selection and invocation are the new code; verification + merge live in
  `scripts/safe-merge.mjs`, upgraded to close the round-1 foundation findings (repo
  parameter, head pinning, JSON parsing + required-contexts cross-check, honest exit codes,
  `--delete-branch`). The watcher MUST NOT carry an independent merge path, and MUST NOT
  trust safe-merge's exit code as proof — `merged` is classified only after an independent
  `gh pr view --json state,mergedAt` confirms it (B10).
- R3 — **Deliberate holds always win**: case-insensitive `[hold` title prefix, `hold` /
  `do-not-merge` label, or draft status excludes a PR. Hold state is re-checked immediately
  before the merge invocation, not just at selection. **Hold removal is debounced**: a PR
  observed held resumes auto-merge eligibility only after the marker is absent for two
  consecutive ticks, and the resume is audited (`hold-released`). A conversational hold
  ("let's hold #N") is NOT visible to machinery — the agent's contract (CLAUDE.md awareness
  section) is to apply the marker immediately when the operator expresses a hold; the
  marker IS the hold.
- R4 — **Authored-by-this-agent only, verified**: gh login is the operator's shared
  credential, so `--author "@me"` is necessary but NOT sufficient. A candidate must ALSO
  have a head branch under this agent's namespace (`<agentName>/…`, the live fleet
  convention). At watcher boot, `gh api user` is resolved and compared against
  `expectedGhLogin` config; mismatch or resolution failure → every tick is inert-audited
  (`skipped:identity-mismatch` / `identity-unresolved`), never breaker-fed.
- R5 — **Bounded + braked** (No Unbounded Loops): at most one merge attempt per tick;
  single-flight (a tick that finds the previous one still running skips with
  `tick-skipped-busy`); per-PR failure ladder with backoff; `gave-up` after `maxAttempts`,
  re-armed by a new head SHA at most `maxRearmEpisodes` (default 3) times before requiring
  manual action; a breaker after consecutive failures across PRs; every state TRANSITION
  audited (not every tick — the SessionReaper precedent); failures fold into ONE aggregated
  Attention item with a machine-stable id (Bounded Notification Surface).
- R6 — **Stop-gate belt, server-side**: the green-PR check lives in the existing
  `/internal/stop-gate/evaluate` route (where dev-gating, config, and timeouts already
  live), reading the watcher's LAST-TICK SNAPSHOT — **zero gh calls on the stop path**. The
  hook string is unchanged. Scope: the gate blocks ONCE only when the ending session's
  worktree branch matches a green candidate's head ref (resolvable relationship); otherwise
  silent. Fail-open on any error; an already-merged snapshot entry never blocks.
- R7 — **Fleet posture**: classified `DARK_GATE_EXCLUSIONS: deliberate-fleet-default` (the
  releaseReadiness precedent — the dev-gate registry bars action-bearing features), with
  `monitoring.greenPrAutoMerge.enabled: false` in ConfigDefaults and the config flipped ON
  for the dev agent at ship time. Repo-gated: inert without an analyzable instar repo AND
  `scripts/safe-merge.mjs` present. `ships-staged: true` — the fleet flip rides the
  rollout/maturation track, not author memory (Close the Loop).
- R8 — **Observable Intelligence / audit**: every decision transition (candidate-found,
  skipped:<why>, waiting:<why>, hold-released, merge-attempted, merged, merged-by-other,
  merge-failed:<class>, gave-up, breaker-open/closed, tick-skipped-busy,
  identity-mismatch) is one JSONL line (0600, 5MB×2 rotation); a read-only status surface
  reports last tick, snapshot, and breaker state.
- R9 — **Runtime kill-switch + emergency-stop reach**: `POST /green-pr-automerge/rollback`
  disables the watcher at runtime (loud: HIGH Attention + audit row; persisted in state,
  checked at tick top), `POST /green-pr-automerge/enable` re-arms it; the MessageSentinel
  emergency-stop ("stop everything") pauses the watcher exactly as it pauses the resume
  queue. `dryRun` remains the config-level rollback lever.
- R10 — **One watcher across the pool**: ticks run only on the multi-machine lease holder
  (single-machine installs hold the lease trivially). Belt: a `gh pr merge` failure whose
  cause is "already merged/closed" is classified `merged-by-other` (success-noop), never a
  ladder failure — so even a lease split cannot manufacture breaker noise.
- R11 — **Event-loop safety**: all gh/safe-merge invocations are async spawns
  (`execFile`/`spawn`, never `*Sync`) — the instar#1069 lesson; a wiring-integrity test
  asserts the runner dep is async.

## Design

### 3.1 safe-merge hardening (same PR, prerequisite step)

`scripts/safe-merge.mjs` gains, preserving its CLI contract for existing callers:

- `--repo <owner/name>` (default: the current hardcoded constant) — and the watcher always
  passes its resolved repo explicitly. A resolved-repo/constant mismatch in the watcher is
  a boot refusal (`skipped:repo-mismatch`).
- **Head pinning**: records `headRefOid` when checks verify green, merges with
  `gh pr merge --match-head-commit <sha>`; a push in the window → refusal, audited.
  (Closes the TOCTOU; the watcher passes the SHA it selected on.)
- **JSON parsing**: `gh pr checks --json name,state,bucket` replaces human-output regex
  parsing (kills the `/\bpending\b/`-matches-check-names bug); the e2e guard matches on
  the structured name field.
- **Required-contexts cross-check**: fetches the branch-protection required status checks
  list and refuses if any required context has no successful run (closes the
  "required check never reported" + "e2e workflow deleted, stub added" holes that
  `--admin` would otherwise waive past).
- **Honest exit**: a null spawn status, signal kill, or merge-command failure exits
  non-zero with a classified reason on stdout (`already-merged` distinguished from
  `refused` from `error`).
- `--delete-branch` pass-through; `--deadline-ms` so the caller's timeout and the internal
  wait can never invert (B24).

### 3.2 Layer 1 — `GreenPrAutoMerger` (src/monitoring/GreenPrAutoMerger.ts)

- **Drive model**: a `setInterval` tick in the server (started at boot when enabled +
  repo-gated + lease-held), PLUS `POST /green-pr-automerge/tick` as the manual/test
  trigger. Single-flight guard per R5.
- **Tick**: ONE GraphQL list call —
  `gh pr list --author "@me" --state open --base <default-branch> --json
  number,title,labels,isDraft,headRefName,headRefOid,mergeable,statusCheckRollup` — no
  N+1 per-PR queries. Candidates: head branch under `<agentName>/`, not draft, not held
  (R3), `mergeable == MERGEABLE`, and **checks already settled green** (the watcher never
  invokes safe-merge into a pending wait — that keeps the per-attempt window seconds-long
  and makes timeout inversion structurally impossible). No quiet period beyond that:
  draft / `[hold` / labels are the wait signals (frontloaded decision 5).
- **Act**: oldest eligible candidate only. Re-fetch title/labels/draft/state immediately
  before invoking (R3), then async-spawn
  `safe-merge.mjs <PR#> --repo <resolved> --squash --delete-branch --admin
  --match-head-commit <selected headRefOid> --deadline-ms <mergeTimeoutMs>`.
  Classify the outcome per R8's taxonomy; confirm `merged` independently via
  `gh pr view --json state,mergedAt` (R2/B10).
- **State**: `state/green-pr-automerge.json` — machine-local BY DESIGN (per-machine attempt
  ledger; the ACTION is serialized by the lease gate, R10). Registered in the
  state-coherence registry at birth; excluded from BackupManager snapshots (per-machine
  class). Episodes reaped when their PR is merged/closed, TTL-expired after 30 days.
- **Cross-machine posture table** (Cross-Machine Coherence declaration):
  | Surface | Posture | Why |
  |---|---|---|
  | `state/green-pr-automerge.json` | machine-local BY DESIGN | attempt ledger; merges serialized by lease (R10) |
  | `logs/green-pr-automerge.jsonl` | machine-local BY DESIGN | this machine's conduct audit |
  | `GET /green-pr-automerge` | machine-local read | GitHub is the global truth for "merged"; a standby reports enabled + no recent ticks honestly |
  | Aggregated Attention item | machine-stable id (`green-pr-automerge:aggregate`) | lease gate makes dual-raise impossible in practice; stable id makes it harmless if it happens |
  | Episode hand-off on lease move | re-derived from GitHub | bounds are per-machine; documented consequence: a `gave-up` PR gets a fresh ladder on the new holder, capped by `maxRearmEpisodes` there too |
- **Config** (`monitoring.greenPrAutoMerge`): `enabled` (false in ConfigDefaults — fleet
  default; flipped on for the dev agent), `dryRun` (false), `tickIntervalMs` (600 000),
  `maxAttempts` (3), `maxRearmEpisodes` (3), `breakerThreshold` (3), `breakerCooldownMin`
  (60), `mergeTimeoutMs` (1 500 000 — above safe-merge's internal cap; passed down via
  `--deadline-ms`), `expectedGhLogin` (string; identity contract R4), `holdReleaseTicks`
  (2).
- **Supervision**: Tier 0 — with the judgment point named: the ONLY discretionary
  classification the watcher makes is hold/candidate status, and its failure direction is
  fail-toward-skip (audited), never fail-toward-merge. Everything that decides "is this
  change good" already happened upstream (Tier-2 spec process + gates + CI); safe-merge
  re-verifies at act time. No LLM in the loop.
- **Untrusted strings**: PR titles/labels are DATA — argv-array spawning only, never shell
  interpolation; length-capped and marker-stripped before they enter audit rows, the
  status route, or stop-gate guidance text.

### 3.3 Layer 2 — stop-gate green-PR check (server-side)

Implemented in the `/internal/stop-gate/evaluate` route handler (NOT in the hook string —
the router stays a thin client): when the evaluate call arrives, the handler consults the
watcher's last-tick snapshot (in-process; no gh call, no added latency beyond the existing
1.5s budget) and, if the ending session's worktree branch resolves to a green candidate's
`headRefName`, blocks ONCE with: *"PR #N (your branch) is green and unmerged. Run `node
scripts/safe-merge.mjs N --squash --admin`, or mark it `[HOLD: <reason>]` — otherwise the
auto-merger lands it within ~10 minutes."* Unrelated sessions are never blocked
(round-1 N4); a snapshot entry the route can see is already merged → no block. Fail-open
everywhere. On non-dev agents the watcher is off → no snapshot → structurally silent.

Layer 2's honest role (round-1 external challenge): Layer 1 is the guarantee; Layer 2 is
immediacy + the teaching surface — it converts "the machinery will fix it in 10 minutes"
into "the agent does it now and learns the norm." It costs nothing on the stop path
(snapshot read), so the redundancy is cheap.

### 3.4 Hold-age visibility (anti-gravity-well backstop)

A PR sitting held or `gave-up` for more than `staleHoldDays` (default 7) is surfaced
through the SAME aggregated Attention item (`waiting:held age=Nd`) — a lazy `[HOLD:
stopping]` escape re-enters the operator's view instead of rotting (round-1 adversarial
finding: "the gravity well returns wearing the hold label").

### Migration parity

- **Config defaults**: `monitoring.greenPrAutoMerge` block (with `enabled: false`) via
  `migrateConfig()` existence-checked; the dark-gate lint's hand-authored golden map gains
  the new `enabled:` line (verified by hand, as always).
- **Registry**: `DARK_GATE_EXCLUSIONS` entry (`deliberate-fleet-default`, justification:
  automates the Phase-7-mandated merge of fully-gate-passed self-authored PRs;
  safe-merge re-verification + lease gating + runtime rollback + breaker; fleet default
  stays off). `guardManifest.ts` entry so `GET /guards` grades its posture.
- **CLAUDE.md template + `migrateClaudeMd()`**: awareness section — the status route, the
  hold contract ("a hold IS the marker; apply it the moment the operator says hold"), the
  rollback/enable levers, content-sniffed on `/green-pr-automerge`.
- **Skill content**: an idempotent `PostUpdateMigrator` migration updates the DEPLOYED
  instar-dev SKILL.md Phase 7 text (the `installBuiltinSkills` never-overwrite rule means a
  dedicated migration is the only path — Migration Parity §5 precedent at
  PostUpdateMigrator.ts:1940).
- **State registry**: `state/green-pr-automerge.json` registered machine-local at birth.

### Testing (three tiers, per TESTING-INTEGRITY-SPEC)

- **Unit**: candidate filter both sides (draft / `[hold` case-variants / labels /
  non-agent branch prefix / non-default base / red / unsettled / not-mergeable vs clean);
  identity contract (login mismatch + unresolved → inert-audited, never breaker);
  hold re-check-before-merge + hold-release debounce; failure taxonomy (already-merged →
  merged-by-other; deadline kill → waiting; refusal → attempt); ladder + gave-up +
  re-arm cap; breaker; single-flight; transition-only auditing; episode reap/TTL;
  dry-run inertness; lease-gating both sides; safe-merge hardening (repo param, head-pin
  refusal on mismatch, JSON checks parsing, required-contexts refusal, honest exit
  classification, delete-branch, deadline); stop-gate evaluate both sides (matching branch
  blocks once / unrelated silent / merged-snapshot silent / fail-open).
- **Integration**: `GET /green-pr-automerge` + rollback/enable routes through createRoutes
  (503 unwired); a fake-gh harness driving tick → safe-merge argv (asserted at the spawn
  boundary, incl. `--match-head-commit` and `--repo`) → post-merge verification →
  episode; burst invariant: K permanently-failing candidates → bounded attempts, breaker,
  ONE aggregated attention id, zero per-PR items; emergency-stop pauses ticks.
- **E2E**: feature-alive — real AgentServer boots with the watcher wired as server.ts
  wires it; status route 200 (not 503); wiring integrity (async runner, audit sink,
  attention sink, lease-checker real and delegating).

## Frontloaded Decisions (round-1: all forks resolved; reversibility noted per decision)

1. **No dry-run soak on the dev agent; `dryRun` is a rollback lever only.** Auto-merge to
   `main` is a durable external side-effect — but this is not new authority: the operator
   directed this exact behavior twice (2026-06-09 topic 23178, 2026-06-12 topic 24662),
   Phase 7 has mandated the identical merge manually since June 9, and safe-merge
   (hardened, §3.1) re-verifies every green at act time. **`approved: true` on this spec
   ratifies this posture — the eli16 surfaces it explicitly, so the question is closed at
   the approval gate, before any build runs.** Reversibility: runtime rollback route (R9) +
   `dryRun` + `enabled:false`; the fleet default is off regardless.
2. **One candidate per tick, oldest first.** Reversibility: config/behavior-level, trivial.
3. **Operator kills of the gravity-well class are in scope; deliberate waits are expressed
   ONLY as draft / `[hold` title / `hold`+`do-not-merge` labels** — the marker IS the hold;
   conversational holds obligate the agent to apply the marker immediately (CLAUDE.md
   contract). Reversibility: trivial (markers are mutable).
4. **Squash merge + delete branch via safe-merge's new pass-through.** Reversibility:
   trivial flag change.
5. **No quiet/grace period for freshly-green PRs** beyond settled-checks: an author still
   iterating keeps the PR draft or holds it — the same signals reviewers already use.
   Reversibility: a `minGreenAgeMs` knob can be added without design change.
6. **Layer 2 scopes to sessions whose branch matches a candidate** — unrelated sessions
   are never blocked. Reversibility: scope widening is a config/code-level change.
7. **Fleet classification is `DARK_GATE_EXCLUSIONS: deliberate-fleet-default`** (not
   DEV_GATED_FEATURES — that registry bars action-bearing features), `enabled: false`
   fleet default, dev-agent flips on by config, fleet promotion rides the `ships-staged`
   rollout track. Reversibility: the flip is config.

## Open questions

*(none — every fork is frontloaded above; Decision 1 is ratified by `approved: true`)*

## Out of scope

- Non-canonical repos (other projects an agent contributes to).
- Auto-resolving a CONFLICTING PR (audited as `waiting:conflicting`; resolution stays with
  the authoring agent — surfaced via the hold-age backstop if it rots).
- Any change to branch protection or CI itself.
- Arming GitHub native auto-merge as a complementary belt (documented alternative; may be
  adopted later without design change).
