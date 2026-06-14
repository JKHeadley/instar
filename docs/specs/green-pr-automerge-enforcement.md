---
title: Green-PR Auto-Merge Enforcement — Phase 7 becomes machinery, not memory
approved: true
approved-by: "Justin (uid:7812716706), Telegram topic 24662, 2026-06-12 18:50 PDT"
eli16-overview: green-pr-automerge-enforcement.eli16.md
topic: 24662
parent-principle: "No Manual Work (user *or* agent)"
ships-staged: true
lessons-engaged: [P1-structure-beats-willpower, P2-signal-vs-authority, P3-migration-parity, P4-testing-integrity, P5-agent-awareness, P7-llm-supervised-execution, P10-honest-coverage, P14-distrust-temporary-success, P17-bounded-notification-surface, P18-observation-needs-structure, P19-no-unbounded-loops, L5-state-detection-robustness, B10-verify-landed-before-claiming, B24-gate-latency-vs-client-timeout, graduated-feature-rollout, close-the-loop, cross-machine-coherence, mobile-complete-operator-actions]
review-convergence: "2026-06-13T01:24:25.800Z"
review-iterations: 7
review-completed-at: "2026-06-13T01:24:25.800Z"
review-report: "docs/specs/reports/green-pr-automerge-enforcement-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 8
contested-then-cleared: 4
---

# Green-PR Auto-Merge Enforcement — Phase 7 becomes machinery, not memory

**Status:** v7 (post round-6 review). Author: echo · Created: 2026-06-12 · Topic: 24662
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

## Key concepts (for readers outside this codebase)

- **Attention item**: instar's durable to-do surface — one Telegram forum topic per item,
  aggregated items collapse many events into ONE rolling entry.
- **Lease / lease holder**: the multi-machine pool elects exactly one "awake" machine via
  a fenced lease; background authority runs only on the holder.
- **Dark gate / `DARK_GATE_EXCLUSIONS`**: instar's registry of which features ship
  off-by-default fleet-wide and why; `deliberate-fleet-default` = off everywhere until a
  deliberate config flip.
- **Guard manifest / `GET /guards`**: the census of safety/monitoring components and
  their live posture (on-confirmed / off / diverged…).
- **Stop-gate hook**: a Claude Code Stop-event hook that can block a session from ending
  with guidance; decisions are served by the agent's local server.
- **safe-merge**: `scripts/safe-merge.mjs`, the repo's blessed merge wrapper (§3.1).
- **Coherence journal**: instar's per-machine append-only replicated event log; peers pull
  each other's streams, so a durable entry written on one machine becomes readable
  pool-wide (the replication substrate R9's latches ride).

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
  runtime kill-switch, or Attention integration.
- **A GitHub Actions workflow** (event-driven merge on `check_suite` success): no custom
  daemon, and token scoping can be done responsibly (environment-protected secrets / a
  GitHub App) — the honest objections are policy and audit LOCALITY: the merge authority
  would live outside the agent's guard manifest, runtime kill-switch, emergency-stop
  reach, and Attention/audit surfaces (Observable Intelligence), and it cannot read
  agent-side state (identity bindings, hold memory, the stop-gate snapshot). Instar's
  standing pattern keeps autonomous authority inside the agent's audited monitoring
  layer.
- **Merge queue**: solves ordering, not the unattended-merge gap; same arming problem as
  native auto-merge and unavailable on this plan/repo configuration today.
- **Threat model for operator-token `--admin` (round-3, stated explicitly)**: the watcher
  mints NO new privilege — the operator credential already holds admin-merge authority on
  every dev machine, exercised manually via the same script since June 9; what changes is
  WHERE it is exercised (inside the agent's audited, kill-switched, lease-serialized
  monitoring layer instead of an agent's ad-hoc shell). The compensating controls are the
  producer-bound contexts floor, head pinning, protected-paths skip, identity contract,
  per-attempt contract probe, and the pool-visible latches. A least-privilege **GitHub
  App** (scoped merge permission, no admin bypass) is a **named PRECONDITION for any
  fleet promotion beyond the dev agent** — a gate on the `ships-staged` rollout track,
  not an aspiration (round-5: BOTH external reviewers, GPT-5.5 and Gemini 2.5 Pro,
  independently flagged the operator-token `--admin` daemon as acceptable only for the
  bounded single-agent scope). The operator-token phase is explicitly the
  single-dev-agent phase; the rollout checklist item reads "credential migrated to a
  scoped GitHub App" before any second agent is armed — and the same checklist carries
  "strict-base-freshness mode evaluated" (re-verify against a test-merge commit /
  `minGreenAgeMs`; Decision 9's residual is acceptable for the bounded dev-agent phase,
  not silently inherited by a fleet). **Round-6 external dissent, recorded for the
  approval read**: Gemini 2.5 Pro holds that the GitHub App should precede ANY ship and
  that the GitHub-Actions alternative deserves re-evaluation; the operator-ratified
  posture (Decision 1, this threat model, twice-given operator direction) accepts the
  bounded single-agent operator-token phase. The convergence report quotes the dissent
  verbatim so `approved: true` is an informed choice.

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
- R3 — **Deliberate holds always win**: case-insensitive `[hold` title prefix (the title
  is TRIMMED before the prefix match — a hand-edited ` [HOLD]` with leading whitespace
  must not silently fail; unit fixtures cover whitespace/case near-miss variants),
  case-insensitive `hold` / `do-not-merge` label, or draft status excludes a PR. Hold state
  is re-checked immediately before the merge invocation, not just at selection (a residual
  seconds-wide window between that re-check and the merge is documented and accepted —
  safe-merge's head pinning still bounds what can land in it). **Hold removal is
  debounced**: a PR observed held resumes eligibility only after the marker is absent for
  two consecutive ticks of the SAME lease holder AND ≥ `tickIntervalMs` of elapsed time,
  audited as `hold-released`. The warm-up tick (R10) seeds hold memory for all
  CURRENTLY-held PRs, so a lease move cannot zero the debounce of a STANDING hold; a hold
  released inside the lease-move gap gets one warm-up observation plus the pre-merge
  re-fetch instead of the full two-tick debounce (accepted — the marker's absence is the
  operator's expressed intent). **Conversational holds get a structural assist**:
  `POST /green-pr-automerge/hold {"pr": N, "reason": "…"}` applies the `[HOLD: …]` title
  prefix via gh in one call — the agent's contract (CLAUDE.md awareness section) is to fire
  it the moment the operator expresses a hold. The marker IS the hold; Decision 3 carries
  the defended rationale for why this contract is acceptable where other prose was not.
- R4 — **Authored-by-this-agent only, verified**: gh login is the operator's shared
  credential, so `--author "@me"` is necessary but NOT sufficient. A candidate must ALSO
  have a head branch under this agent's namespace (`<agentName>/…`) — honestly a FILTER,
  not provenance (anyone holding the credential can name a branch `echo/…`); the
  provenance guarantee comes from §3.1's `requiredContextsFloor` (the gate-produced CI
  contexts), and Decision 8 records the residual. `gh api user` is resolved ASYNC and
  non-blocking (server boot never waits on gh), compared against `expectedGhLogin`
  config, and RE-RESOLVED on a TTL (every `identityRecheckTicks`, default 6) so a mid-run
  gh re-auth cannot ride a stale verification. Mismatch, resolution failure, or an
  UNSET `expectedGhLogin` → every tick is inert-audited (`skipped:identity-mismatch` /
  `identity-unresolved` / `identity-unconfigured`, the last surfaced via the `/guards`
  posture so a flipped-on-but-unconfigured watcher is visible), never breaker-fed. The
  dev-agent ship-time flip sets `enabled` AND `expectedGhLogin` together.
- R5 — **Bounded + braked** (No Unbounded Loops): at most one merge attempt per tick;
  single-flight with a LIVENESS guarantee — the watcher hard-kills the spawned safe-merge
  child at `mergeTimeoutMs + grace` and releases the single-flight flag in finally-block
  semantics, so a wedged gh can never hold the flag forever. **The guarantee survives the
  server's own death** (round-5: an auto-update restart — routinely CAUSED by this
  watcher's own merges triggering releases — is a NORMAL mid-attempt condition, not an
  edge case): the in-flight attempt (PR, head SHA, child pid + process-group id,
  startedAt) is recorded DURABLY in `state/green-pr-automerge.json` BEFORE the spawn and
  cleared on classification; the child runs in its OWN process group and the server's
  shutdown path kills the group; and a boot/warm-up that finds a recorded in-flight
  attempt FIRST reaps any surviving orphan (kill the recorded pgid if alive, verify the
  pid's identity before signaling; round-6: a dead/recycled LEADER pid with a live
  group is handled too — scan the group for the expected command identity, or hold the
  in-flight record and audit `orphan-reap-incomplete` until the group is empty) and
  re-verifies the PR's live state via `gh pr view`
  before any new attempt — so the boot cannot double-attempt, and the orphan window is
  reduced to the same accepted seconds-wide residual class as R3's hold re-check window
  (a rollback latching while a child is ALREADY spawned can see that one head-pinned,
  pre-verified merge complete; acknowledged in R9's residual note). Round-6 wording
  precision: the durable write is necessarily TWO-PHASE — an intent record lands before
  the spawn, pid/pgid are patched in immediately after — and a pid-less in-flight
  record found at boot is treated as attempt-of-unknown-outcome (re-verify via gh,
  never assume not-spawned). A tick that finds an attempt
  in flight skips with `tick-skipped-busy`, and N consecutive busy-skips (default 3) feed
  the breaker; **deadline-kills are NOT free**: they bypass the per-PR ladder (the PR is
  healthy) but count toward the global breaker after `deadlineKillBreakerThreshold`
  (default 3) consecutive occurrences — a persistently hanging gh opens the breaker
  instead of burning a 25-minute child per tick forever; per-PR failure ladder with
  backoff; `gave-up` after `maxAttempts`, re-armed by a new head SHA at most
  `maxRearmEpisodes` (default 3) times before requiring manual action; every state
  TRANSITION audited (not every tick — the SessionReaper precedent); failures fold into
  ONE aggregated Attention item with a machine-stable id (Bounded Notification Surface).
- R6 — **Stop-gate belt, server-side decision, mode-independent delivery**: the green-PR
  check computes server-side from the watcher's LAST-TICK SNAPSHOT — **zero gh calls on
  the stop path** — and is delivered through the hot-path response as a `greenPrBlock`
  field the hook acts on MODE-INDEPENDENTLY (§3.3; the UnjustifiedStopGate's `mode` ships
  `off`, so an evaluate-side check would be structurally inert — round-2 finding). Scope:
  blocks ONCE only when the ending session's worktree branch matches a green candidate's
  head ref; otherwise silent. A snapshot older than 2× `tickIntervalMs` never blocks
  (staleness gate); an already-merged snapshot entry never blocks; fail-open on any error.
- R7 — **Fleet posture**: classified `DARK_GATE_EXCLUSIONS: deliberate-fleet-default` (the
  releaseReadiness precedent — the dev-gate registry bars action-bearing features), with
  `monitoring.greenPrAutoMerge.enabled: false` in ConfigDefaults and the config flipped ON
  for the dev agent at ship time — **on EVERY machine of the dev agent's pool** (round-5:
  config is per-machine and execution follows the lease, so arming one machine silently
  de-arms the feature on the next lease move; the ship-time flip is a per-machine config
  edit applied pool-wide, stated in the rollout step). **Armed-pool divergence is
  visible, not graded healthy**: arming writes a durable `pool-armed` marker through the
  SAME `guard-latch` journal kind as R9's latches; the guard-posture inventory grades a
  machine whose replicated view shows `pool-armed` while its local `enabled` is false as
  `diverged-from-default` (the alarm class) instead of `off (dark-default)` — without
  this, BOTH visibility nets miss the de-armed standby (the dark-default grade reads as
  "normal, never noise," and the §3.4 rot backstop runs inside the watcher, so it is off
  too). **The marker has a full lifecycle** (round-6: an arm-only marker means a
  deliberate fleet-wide off alarms FOREVER — the same perpetual-false-alarm disease, one
  surface over): a **pool-disarm** action (operator-PIN-gated, same authority class and
  dashboard panel as R9's `/enable` — re-shaping merge-authority posture is the
  operator's) writes a superseding `pool-disarmed` entry through the same `guard-latch`
  kind under the same epoch+sequence ordering rules; the cleared state grades back to
  healthy `off (dark-default)`. Disarm does NOT clear an active rollback latch, and a
  rollback does not disarm the pool marker (independent levers, like R9's two latches).
  With the coherence journal off, this divergence net honestly degrades to
  single-machine (R9's arrive-disabled rule remains the merge-safety backstop). Unit
  cases: armed→disarmed→no alarm; disarm leaves rollback latched; rollback leaves
  pool-armed standing. Repo-gated: inert without an analyzable instar repo AND
  `scripts/safe-merge.mjs` present. `ships-staged: true` — the fleet flip rides the
  rollout/maturation track, not author memory (Close the Loop).
- R8 — **Observable Intelligence / audit**: every decision transition (candidate-found,
  skipped:<why>, waiting:<why>, hold-released, merge-attempted, merged, merged-by-other,
  closed-by-other, merge-failed:<class>, gave-up, breaker-open/closed, tick-skipped-busy,
  tick-failed:<class>, identity-mismatch) is one JSONL line (0600, 5MB×2 rotation).
  **Tick-level liveness canary** (L5(b)/P18 — the silent zero-candidate failure): a failed
  or unparseable `gh pr list` call audits `tick-failed:<class>` and feeds the breaker
  after N consecutive; the status surface reports `lastTickAt`, `lastSuccessfulListAt`,
  in-flight attempt age, snapshot, and breaker state, so the guard-posture grade can
  distinguish "running" from "able to see PRs". **Floor-drift canary** (round-4, same
  L5(b) class): every `floorDriftCheckTicks` ticks (default 6) and at boot, the
  code-pinned floor contexts + producers — AND any config-EXTENDED floor entries (a junk
  config entry must surface as drift, not as eternal merge refusals) — are validated
  against a reference chosen PER CONTEXT FAMILY by trigger type (round-6 adversarial
  grounding: two of the three pinned floor families — the eli16 and decision-audit gates
  — are `pull_request`-only workflows whose check runs attach to PR HEAD SHAs, never to
  default-branch commits; squash merges mint new SHAs carrying only push-triggered runs,
  so a default-branch reference can NEVER observe them — under one reading the canary
  would report perpetual `floor-drift-unverifiable`, under the other perpetual FALSE
  `floor-drift`):
  **PR-triggered floor contexts** are validated against the head SHAs of recently
  MERGED agent-namespace PRs (bounded walk-back, `floorDriftLookbackPrs` default 10 —
  each carries the full gate-context set a real dev-process pass produces);
  **push-triggered contexts** are validated against the most recent default-branch
  commit qualified INDEPENDENTLY of the pinned set (any completed, non-skip-ci check
  runs present — qualifying ON the pinned workflows would make a rename select a stale
  pre-rename commit or exhaust the bound, structurally hiding the exact drift the
  canary exists to catch), found by a bounded walk-back (`floorDriftLookbackCommits`,
  default 30; round-5: `main`'s HEAD is usually a `[skip ci]` release commit with ZERO
  runs, so "the latest commit" is never a valid reference on this repo). A mismatch at
  the reference
  (renamed workflow, split job, changed app slug) audits a DISTINCT `floor-drift` class
  and surfaces ONE line in the aggregated Attention item naming the drifted
  context/producer — the operator learns "the floor pins are stale," never just "PR #N
  failed three times" (a drifted floor turns the watcher into a permanent refuser whose
  fix is itself a protected-paths PR — it must be named as drift, immediately). No
  qualifying reference within a family's walk-back bound audits its own
  `floor-drift-unverifiable` class (distinct from `floor-drift` — "couldn't check" must
  never wear the "drifted" label).
- R9 — **Runtime kill-switch + emergency-stop reach, POOL-VISIBLE**: two INDEPENDENT
  latches — `POST /green-pr-automerge/rollback` (re-armed only by `/enable`) and the
  MessageSentinel emergency-stop pause (cleared only by its own resume path) — and BOTH
  must be open for a merge. Re-arm never clears an active emergency stop, and vice versa.
  Because execution follows the lease, a machine-local latch would silently resurrect on
  lease move (round-2 finding). v4 mechanics (round-3 hardening — async replication alone
  re-opens the hole exactly when the holder dies before its latch entry replicates):
  latches are written to a NEW dedicated coherence-journal kind (`guard-latch` — the
  closed per-kind schema means they cannot ride the session-lifecycle stream) AND to a
  durable local file that exists regardless of the journal feature flag; the
  rollback/emergency-pause routes **push-through** — they synchronously best-effort-push
  the latch to every reachable peer before acking (rare, operator-initiated; the blocking
  push costs nothing); the dual-latch gate is read EVERY TICK from the merged replicated
  view (O(1) materialized key, async read — never a per-tick journal scan), not only at
  warm-up; latch/clear ordering resolves by lease epoch + sequence, NEVER wall-clock; and
  a warm-up that finds the prior holder's stream stale beyond a declared bound or its
  latch state UNREADABLE arrives DISABLED + Attention — absence of evidence is not
  armed. A found peer latch likewise arrives DISABLED with one Attention item ("watcher
  was disabled on <machine> — confirm before re-arming"). Honest residual (posture
  table): a rollback acked by a machine that dies before BOTH the push-through and the
  journal flush can still be lost — the arrive-disabled-on-unreadable rule is what
  bounds that window. **Disable is ABSORBING**: a rollback latch always wins ordering conflicts
  regardless of epoch (a stale-epoch standby's STOP can never be out-ordered by an
  earlier `/enable` from a higher epoch); `/enable` clears only the specific latch id(s)
  it names. The push-through is deadline-bounded (per-peer ~2.5s, total budget ~10s —
  the local durable write + journal append precede it, so safety never waits on the
  network); on expiry it acks WITH the honest per-peer reached/missed report, relying on
  replication + arrive-disabled-on-unreadable for missed peers. Rollback is loud (HIGH
  Attention + audit) and Bearer-callable (anyone can STOP); the latch gates TICKS — a
  safe-merge child already spawned in the same seconds is the acknowledged R3-class
  residual (head-pinned, pre-verified, bounded by the settled-green-only invocation
  rule). **Why this bespoke latch and not a simpler primitive** (round-6 external): the
  latches ride the two distributed primitives the pool ALREADY operates (the coherence
  journal and the fenced lease) — no new store, no new replication protocol; a single
  authoritative store would be a new single point of failure needing its own
  replication anyway, and a GitHub-side gate (environment/secret/label) would place the
  stop authority outside the agent's emergency-stop reach and audit surfaces — the same
  locality reason the Alternatives section gives for not delegating merge authority to
  CI. **`/enable` requires the
  operator's dashboard PIN** — re-arming merge authority is the operator's, structurally
  (the Mandates-TAB precedent, not just the Mandates API): re-arm ships WITH its human
  surface — a button on the dashboard guards/watcher panel — and the rollback Attention
  item carries the dashboard link (resolved via the existing fleet dashboard-link helper
  — the tunnel URL when one is up, honest degradation otherwise; never a hand-built
  localhost URL, which would fail the phone-first requirement this exists for), so the
  operator can complete the re-arm from a phone
  (Mobile-Complete Operator Actions; an API-only PIN route would be the exact
  Scenario-8 defect that standard was earned from). `dryRun` remains the config-level
  lever. Single-machine installs degrade to the local check. A pool running with the
  coherence-journal feature OFF arrives DISABLED on every lease move (latch state
  unreadable) — fail-safe by design; the audit names it `latch-unreadable:journal-off`
  so a permanently arrive-disabled watcher is recognizable as "journal off," never
  investigated as a latch bug. Unit case named: rollback
  on A + A dark + lease moves → B does not merge.
- R10 — **One watcher across the pool**: ticks run only on the multi-machine lease holder
  (single-machine installs hold the lease trivially). **Lease-acquire warm-up**: the first
  tick after acquiring the lease is OBSERVE-ONLY — it seeds hold memory (R3's debounce),
  builds the snapshot, and checks peer latches (R9); merges begin on the second tick.
  Warm-up may be SKIPPED only when this machine's hold-memory is fresher than
  `holdReleaseTicks × tickIntervalMs` AND the latch view is within its staleness bound
  (so a flapping lease does not starve merges); a `tick-warm-up` transition is audited,
  the status route reports `consecutiveWarmupOnlyTenures`, and 3+ consecutive tenures
  that never reach an acting tick fold a `waiting:lease-flap` line into the aggregated
  Attention item — "running and seeing PRs but never permitted to act" must be
  distinguishable from healthy (round-3). `POST /green-pr-automerge/tick` (the
  manual/test trigger) enforces the same lease + single-flight + warm-up rules and is
  rate-limited to one per `tickIntervalMs` — manual double-ticks cannot collapse the
  debounce or warm-up windows (debounce is tick-AND-elapsed-time based). Belt: a merge failure caused by
  "already merged" is `merged-by-other` (success-noop, episode reaped); **"closed without
  merge" is `closed-by-other`** — also never a ladder failure, but surfaced in the
  aggregated Attention item (discarded work must not wear a success row).
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
- **Required-contexts cross-check, with a code-pinned floor and PRODUCER binding**:
  fetches the repo's required status checks (authoritative source: the union of classic
  branch protection `required_status_checks` and branch rulesets for the default branch,
  via the gh API) and refuses if any required context has no genuinely-successful run
  (skipped/neutral on a REQUIRED context = refusal). Additionally refuses if the list is
  missing any entry of the floor — a CODE-hardcoded minimum set (the CI suite + the
  decision-audit-gate + eli16-pr-gate contexts; `requiredContextsFloor` config may
  EXTEND it, never shrink it — a confused config write cannot delete the guarantee).
  **Name-matching alone is explicitly insufficient** (round-3): each floor context's
  check run must also match its pinned PRODUCER (the check run's `app.slug` and workflow
  file path), so a lookalike job reporting the right name from a tampered workflow does
  not satisfy the floor. This is what licenses "pre-approved by construction" (branch
  prefix is a filter, not provenance). **Fail direction**: any failure to fetch/parse
  protection data or producer identity is a refusal (`refused:contexts-unverifiable`),
  never a silent degrade. Test fixtures must cover: missing, skipped, renamed,
  app-scoped, matrix-expanded, and WRONG-PRODUCER required contexts.
  **Required reviews**: this repo runs no required-review protection; if one is ever
  added, `--admin` would bypass it un-re-imposed — the cross-check therefore ALSO refuses
  when unsatisfied required-review protection exists (`refused:reviews-required`),
  making the acceptance explicit instead of silent.
- **Honest exit**: a null spawn status, signal kill, or merge-command failure exits
  non-zero with a classified reason on stdout (`already-merged` / `closed` distinguished
  from `refused` from `error`).
- `--delete-branch` pass-through; `--deadline-ms` so the caller's timeout and the internal
  wait can never invert (B24).
- **Strict argv + contract probe** (round-2: stale-script drift reopens every hole
  silently): the hardened script REJECTS unknown flags (the current script ignores them),
  and gains `--capabilities` printing a contract version; the watcher probes it BEFORE
  EVERY merge attempt (one cheap spawn; round-3 — a mid-run checkout swap between a boot
  probe and a later merge would re-open the drift), pins the probed script's content hash
  and absolute path for the attempt, **re-verifies the pinned hash immediately before the
  exec** (round-5 — the spawn runs the verified bytes, closing the residual
  probe-to-spawn swap window), and refuses (`skipped:safe-merge-contract`) on
  missing/mismatched contract — a checkout predating the hardening can never be driven
  unpinned.
- **Activation ordering**: enabling the watcher against a legacy safe-merge would be a
  critical vulnerability — the contract probe makes that structurally impossible, and the
  feature flag MUST stay off until the hardened script's unit fixtures pass in CI (they
  ship in the same PR, so the ordering is automatic; stated here so a cherry-pick can't
  violate it).

### 3.2 Layer 1 — `GreenPrAutoMerger` (src/monitoring/GreenPrAutoMerger.ts)

- **Drive model**: a `setInterval` tick in the server (started at boot when enabled +
  repo-gated + lease-held), PLUS `POST /green-pr-automerge/tick` as the manual/test
  trigger (same lease + single-flight + warm-up rules as interval ticks). Single-flight
  guard per R5. Route surface: `GET /green-pr-automerge` (status), `POST …/tick`,
  `POST …/rollback` (Bearer), `POST …/enable` (dashboard-PIN-gated, R9), `POST …/hold
  {pr, reason}` — the conversational-hold assist (R3): integer-validated `pr`,
  restricted to OPEN PRs passing the agent-namespace filter (404/403 otherwise), `reason`
  sanitized on the WRITE path (strip `]`/newlines, cap 200 chars vs GitHub's 256 title
  limit), idempotent when already held, audited, lease-INDEPENDENT (holds originate
  wherever the session lives), deadline-bounded (~10s) with an honest non-2xx on failure
  — a hold that silently failed to apply would be merged ~10 minutes later.
- **Tick**: ONE GraphQL list call —
  `gh pr list --author "@me" --state open --base <default-branch> --limit 100 --json
  number,title,labels,isDraft,headRefName,headRefOid,mergeable,statusCheckRollup` — no
  N+1 per-PR queries. Oldest-first selection runs over the FULL fetched set; a full page
  audits `waiting:list-overflow` (honest-coverage signal — the shared login's open-PR
  set spans the operator and sibling agents, so default pagination would hide exactly
  the oldest-rotting PR this spec targets). Candidates: head branch under `<agentName>/`, not draft, not held
  (R3), `mergeable == MERGEABLE`, **checks already settled green** (the watcher never
  invokes safe-merge into a pending wait — that keeps the per-attempt window seconds-long
  and makes timeout inversion structurally impossible), and **touching no protected
  paths** — a PR whose diff modifies `.github/**` (workflows AND composite actions),
  `scripts/safe-merge.mjs`, the watcher/floor source paths, or **the scripts the floor
  contexts execute** (the gate `.mjs` scripts — the list is derived alongside the
  code-pinned floor in the same source file; config extends, never shrinks) is NEVER
  auto-merged (`waiting:protected-paths`, manual merge only; rounds 3-4: a same-repo PR
  branch runs its own workflow copy AND its own gate-script bodies, so either door could
  mint hollow floor contexts — they get human eyes instead). Changed files are
  enumerated TO EXHAUSTION (paginated); an incomplete enumeration is
  `waiting:protected-paths-unverifiable`, never a partial pass (fixture: a workflow edit
  at file #150 of a 200-file PR). **A transition INTO `waiting:protected-paths` folds
  one line into the aggregated Attention item immediately** ("PR #N is green but touches
  protected paths — needs your manual merge"), transition-keyed per PR-head — a
  deliberate human-eyes requirement nobody is promptly told about would be the gravity
  well with a label on it (round-4). The list query is pinned **oldest-first server-side** (`sort:created-asc`) so
  pagination can never hide the oldest-rotting PR; sustained overflow feeds the
  aggregated Attention item with the count. No quiet period beyond that:
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
  | `state/green-pr-automerge.json` (0600 — carries capped titles) | machine-local BY DESIGN | attempt ledger; merges serialized by lease (R10); an open breaker resets on lease move (bound is per-machine, documented) |
  | `logs/green-pr-automerge.jsonl` | machine-local BY DESIGN | this machine's conduct audit |
  | `GET /green-pr-automerge` | machine-local read | GitHub is the global truth for "merged"; a standby reports enabled + no recent ticks honestly |
  | Aggregated Attention item | machine-stable id (`green-pr-automerge:aggregate`) | lease gate makes dual-raise impossible in practice; stable id makes it harmless if it happens |
  | Episode hand-off on lease move | re-derived from GitHub | bounds are per-machine; documented consequence: a `gave-up` PR gets a fresh ladder on the new holder, capped by `maxRearmEpisodes` there too |
  | Layer-2 snapshot on non-holder machines | absent BY DESIGN | sessions ending on a non-holder machine get no stop-gate belt; Layer 1 (on the holder) remains the guarantee |
  | Rollback/emergency-pause latches | pool-replicated (R9) | a machine-local latch would silently resurrect the watcher on lease move |
  | `pool-armed` marker | pool-replicated (`guard-latch` kind, R7) | arms the divergence alarm: local `enabled:false` + replicated pool-armed grades `diverged-from-default`, never healthy-dark |
- **Config** (`monitoring.greenPrAutoMerge`): `enabled` (false in ConfigDefaults — fleet
  default; flipped on for the dev agent), `dryRun` (false), `tickIntervalMs` (600 000),
  `maxAttempts` (3), `maxRearmEpisodes` (3), `breakerThreshold` (3),
  `deadlineKillBreakerThreshold` (3), `busySkipBreakerThreshold` (3),
  `breakerCooldownMin` (60), `mergeTimeoutMs` (1 500 000 — above safe-merge's internal
  cap; passed down via `--deadline-ms`, with the watcher hard-killing at
  +`mergeKillGraceMs`, default 60 000; boot validates the invariant
  `busySkipBreakerThreshold × tickIntervalMs > mergeTimeoutMs + mergeKillGraceMs` and
  refuses a violating combination loudly),
  `expectedGhLogin` (string; identity contract R4), `identityRecheckTicks` (6),
  `holdReleaseTicks` (2), `staleHoldDays` (7), `requiredContextsFloor` (string[];
  §3.1), `floorDriftCheckTicks` (6), `floorDriftLookbackCommits` (30).
- **Supervision**: Tier 0 — with the judgment point named: the ONLY discretionary
  classification the watcher makes is hold/candidate status, and its failure direction is
  fail-toward-skip (audited), never fail-toward-merge. Everything that decides "is this
  change good" already happened upstream (Tier-2 spec process + gates + CI); safe-merge
  re-verifies at act time. No LLM in the loop.
- **Untrusted strings**: PR titles/labels are DATA — argv-array spawning only, never shell
  interpolation; length-capped and marker-stripped before they enter audit rows, the
  status route, or stop-gate guidance text.

### 3.3 Layer 2 — stop-gate green-PR check (server decision, mode-independent delivery)

Round-2 grounding correction: the deployed stop-gate hook exits open BEFORE calling
`/internal/stop-gate/evaluate` when the UnjustifiedStopGate's `mode` is `off` (its
shipped default), and acts on evaluate verdicts only in `enforce` mode — an
evaluate-side check would be structurally inert. The green-PR check therefore rides the
HOT-PATH response (the call the hook ALWAYS makes, 1.5s budget; the evaluate call's
budget is 2.5s for reference): the server computes an optional `greenPrBlock {pr,
message}` field from the watcher's last-tick snapshot, and the hook template gains a
minimal MODE-INDEPENDENT one-shot block on that field — the exact pattern of the
existing stated-continuation guard, which is mode-independent in the same template. The
hook change ships via `migrateHooks()` (always-overwrite — free fleet-wide; on fleet
agents the watcher is off, so the field is never present and the hook path is inert).

Server-side matching: the hot-path handler resolves the ending session's cwd from the
HookEventReceiver's per-session records and matches its branch against snapshot
candidates' `headRefName`. Round-3 grounding: the DEPLOYED `hook-event-reporter.js`
forwards only `{event, session_id, tool_name}` — **the reporter payload is extended to
carry `cwd`** (it is always-overwritten by `migrateHooks()`, so parity is free), with a
test asserting a stored event carries it; without this, Layer 2 ships inert again,
invisibly. Branch resolution is LAZY — computed only when the snapshot has candidates
(the common zero-candidate stop costs nothing) — by reading the worktree's `.git/HEAD`
(one tiny file read, no git spawn), cached per session, sub-budget, fail-open.
Documented fail-open wideners: sessions without `INSTAR_SESSION_ID` and sessions evicted
from the receiver's 50-session cap simply never block. `greenPrBlock` is emitted only
when `!killSwitch && !compactionInFlight` AND **the watcher is armed** — the snapshot
carries the latch + breaker posture, and when rollback/emergency-pause/breaker has the
watcher disarmed the gate emits either nothing or the disarmed variant ("the watcher is
disabled by operator rollback — do NOT merge manually; confirm with the operator"),
NEVER the merge coaching (round-4: a disarmed watcher's Layer 2 must not become a
manual `--admin` merge-prompt machine around the operator's STOP; unit tests both
sides). **Protected-paths entries ARE included in the snapshot, and their variant
carries NO runnable merge command** (round-5 — flagged independently by three
reviewers, internal security, internal adversarial, AND the external GPT-tier pass):
a protected-paths PR is excluded from auto-merge precisely because its own
workflow/gate-script copies could mint hollow floor contexts that pass BOTH the name
check AND the producer binding — and the ending session is typically that PR's AUTHOR,
the exact (possibly prompt-injected or compromised) actor the human-eyes door exists to
keep off the merge button. Coaching it through a pinned `--admin` invocation would
re-create auto-merge with one extra hop and zero human review. The protected-paths
variant therefore routes to the OPERATOR, mirroring the §3.2 Attention line: *"PR #N is
green but touches protected paths — it needs the operator's review and merge; it is
already on the Attention queue."* And round-6 (external GPT-tier) closed the remaining
door: **NO Layer-2 variant carries a runnable merge command at all.** Layer 2 only
blocks when the snapshot is FRESH and the watcher ARMED — i.e. exactly when the
machinery is about to act anyway — so a pinned command in the healthy case is an
invitation to reflexive manual merging, "No Manual Work" recreated as a scripted click
(and every can't-act state already has a command-free variant: disarmed → the
do-not-merge coaching; protected → operator-routed; stale/merged snapshot → silent).
This also retires the round-3 hand-typed-reduced-command concern outright — no command
shown means no command to mistype. Unit tests assert NO variant contains a runnable
command. No hook events for the session → silent. A snapshot older than
2× `tickIntervalMs` never blocks (staleness gate); an already-merged snapshot entry
never blocks. Linked-worktree reality (round-4): `.git` in a worktree is a FILE
(`gitdir: <path>`), not a directory — branch resolution parses it and reads
`<gitdir>/HEAD` (two tiny reads, no spawn, fail-open; unit case for the linked-worktree
path — instar-dev builds live in worktrees, so a naive `.git/HEAD` read would ship
Layer 2 inert for its primary audience).

Block message (PR TITLES never appear in guidance — untrusted data stays out of prompt
context): *"PR #N (your branch) is green and unmerged. Either hold it
(`POST /green-pr-automerge/hold {\"pr\": N, \"reason\": \"…\"}`) or end the session —
the watcher lands it within ~10 minutes. Do NOT merge it manually."* (Round-6: the
earlier draft appended a server-generated pinned merge command "to merge it yourself
NOW" — removed; the watcher being armed and the snapshot fresh is precisely the state
where manual merging is pure recreated manual work.)

Layer 2's honest role (round-1 external challenge): Layer 1 is the guarantee; Layer 2 is
immediacy + the teaching surface. It costs nothing on the stop path (snapshot read), so
the redundancy is cheap. Sessions on non-holder pool machines have no snapshot and no
belt — Layer 1 on the holder remains the guarantee (posture table).

### 3.4 Hold-age visibility (anti-gravity-well backstop)

A PR sitting held, `gave-up`, or in ANY `waiting:*` state (conflicting, list-overflow,
red-checks…) for more than `staleHoldDays` (default 7) is surfaced through the SAME
aggregated Attention item (`waiting:<class> age=Nd`) — a lazy `[HOLD: stopping]` escape
OR a silently-rotting CONFLICTING PR (the June-12 incident shape) re-enters the
operator's view instead of rotting (round-2: §3.4's earlier held/gave-up-only trigger
would have missed PR #1084's own failure mode).

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

- **Unit**: candidate filter both sides (draft / `[hold` case-variants / label
  case-variants / non-agent branch prefix / non-default base / red / unsettled /
  not-mergeable vs clean); identity contract (login mismatch + unresolved + UNCONFIGURED
  → inert-audited, never breaker; TTL re-resolution); hold re-check-before-merge +
  hold-release debounce + warm-up seeding across a lease move; failure taxonomy
  (already-merged → merged-by-other; closed → closed-by-other surfaced; deadline kill →
  bounded by `deadlineKillBreakerThreshold`; refusal → attempt); P19 sustained-failure
  drives BOTH the permanently-refusing AND the permanently-HANGING case (stuck
  single-flight recovers via the hard-kill + finally-release — AND across a server
  restart: a recorded in-flight attempt + surviving orphan is reaped at warm-up, the PR
  re-verified, no double-attempt; busy-skips feed the
  breaker); floor-drift reference walk-back (skip-ci HEAD skipped to the qualifying
  commit / none-within-bound → `floor-drift-unverifiable`, never `floor-drift`;
  config-extended floor entries validated too); pool-armed divergence grading both
  sides (replicated pool-armed + local enabled:false → `diverged-from-default`;
  no marker → healthy dark-default); tick-failed canary (list error / unparseable shape → breaker after N,
  `lastSuccessfulListAt` honest); pagination overflow audited; ladder + gave-up +
  re-arm cap; transition-only auditing; episode reap/TTL; dry-run inertness;
  lease-gating both sides + warm-up observe-only tick; pool-replicated latches (rollback
  survives lease move; enable does not clear emergency-stop and vice versa); safe-merge
  hardening (repo param, head-pin refusal on mismatch, JSON checks parsing,
  required-contexts refusal with fixtures for missing/skipped/renamed/app-scoped/
  matrix-expanded contexts + floor-missing refusal + reviews-required refusal +
  api-failure refusal, honest exit classification incl. null-status, strict argv
  rejection of unknown flags, `--capabilities` contract probe, delete-branch, deadline);
  hot-path greenPrBlock both sides (matching branch blocks once / unrelated silent /
  merged-snapshot silent / stale-snapshot silent / no-hook-events silent / fail-open /
  suppressed under killSwitch+compaction); reporter payload carries cwd; `/hold` route
  contract both sides (applies the marker / rejects non-namespace + closed PRs /
  sanitizes reason / idempotent / honest non-2xx); protected-paths skip both sides;
  producer-binding fixtures (wrong app.slug / wrong workflow path); latch partition case
  (rollback on A + A dark + lease move → B does not merge; unreadable latch view →
  arrive-disabled); warm-up skip conditions + lease-flap starvation counter; manual-tick
  rate limit; boot timeout-invariant refusal.
- **Integration**: `GET /green-pr-automerge` + rollback/enable routes through createRoutes
  (503 unwired); a fake-gh harness driving tick → safe-merge argv (asserted at the spawn
  boundary, incl. `--match-head-commit` and `--repo`) → post-merge verification →
  episode; burst invariant: K permanently-failing candidates → bounded attempts, breaker,
  ONE aggregated attention id, zero per-PR items; emergency-stop pauses ticks; **chaos
  interleaving scenario** (round-6 external): server restart + rollback latch + lease
  transfer landing DURING an in-flight merge attempt — asserts the orphan is reaped or
  honestly audited, the latch wins all subsequent ticks on both machines, no
  double-attempt, and the outcome classification is truthful.
- **E2E**: feature-alive — real AgentServer boots with the watcher wired as server.ts
  wires it; status route 200 (not 503); wiring integrity (async runner, audit sink,
  attention sink, lease-checker real and delegating).
- **L5(c) note (round-5)**: the gh-output parsers are fixture/fake-gh tested; fail
  direction everywhere is refuse-not-merge, and the tick-failed + floor-drift canaries
  detect live drift. A cheap real-gh smoke in CI (a `--capabilities` probe + one
  read-only checks fetch, where gh exists) closes L5(c) fully and ships with the build.

## Frontloaded Decisions (round-1: all forks resolved; reversibility noted per decision; Decisions 1, 3, and 9 are ratified by `approved: true`)

1. **No dry-run soak on the dev agent; `dryRun` is a rollback lever only.** Auto-merge to
   `main` is a durable external side-effect — but this is not new authority: the operator
   directed this exact behavior twice (2026-06-09 topic 23178, 2026-06-12 topic 24662),
   Phase 7 has mandated the identical merge manually since June 9, and safe-merge
   (hardened, §3.1) re-verifies every green at act time. **`approved: true` on this spec
   ratifies this posture — the eli16 surfaces it explicitly, so the question is closed at
   the approval gate, before any build runs.** Reversibility: runtime rollback route (R9) +
   `dryRun` + `enabled:false`; the fleet default is off regardless.
2. **One candidate per tick, oldest first.** Reversibility: config/behavior-level, trivial.
3. **The marker IS the hold** — deliberate waits are expressed ONLY as draft / `[hold`
   title / `hold`+`do-not-merge` labels; conversational holds obligate the agent to fire
   `POST /green-pr-automerge/hold` immediately (one call applies the marker). **Why this
   one prose contract is acceptable where Phase 7's prose was not** (round-2 contest): a
   conversational hold by construction has a LIVE session receiving it (no session-death
   window — the failure mode that killed Phase 7); the obligation is ONE immediate action
   with a structural assist, not a multi-step ceremony; the tick cadence provides a
   ~10-minute natural grace window; and the operator retains two independent
   instant levers (emergency stop; editing the title/label directly on GitHub).
   `approved: true` ratifies this residual the same way it ratifies Decision 1.
   Stated honestly (round-3): the assist still depends on the live agent RECOGNIZING
   hold intent — a model-behavior dependency, not a structural guarantee; the
   deterministic levers that need no agent at all are the GitHub title/label edit
   (always available to the operator directly) and the emergency stop, and the
   aggregated Attention item carries the `/hold` hint so the lever is operator-visible.
   Reversibility: trivial (markers are mutable; the assist route is additive).
4. **Squash merge + delete branch via safe-merge's new pass-through.** Reversibility:
   trivial flag change.
5. **No quiet/grace period for freshly-green PRs** beyond settled-checks: an author still
   iterating keeps the PR draft or holds it — the same signals reviewers already use.
   Reversibility: a `minGreenAgeMs` knob can be added without design change.
6. **Layer 2 scopes to sessions whose branch matches a candidate** — unrelated sessions
   are never blocked. Reversibility: scope widening is a config/code-level change.
7. **Fleet classification is `DARK_GATE_EXCLUSIONS: deliberate-fleet-default`** (not
   DEV_GATED_FEATURES — that registry bars action-bearing features), `enabled: false`
   fleet default, dev-agent flips on by config (setting `expectedGhLogin` in the same
   edit), fleet promotion rides the `ships-staged` rollout track. Reversibility: the
   flip is config.
8. **Accepted residual — branch namespace is a filter, not provenance.** Anyone holding
   the shared gh credential can name a branch `echo/…`; what makes a candidate
   "pre-approved by construction" is §3.1's `requiredContextsFloor` (the
   gate-produced CI contexts must exist and pass — a junk PR cannot satisfy them without
   actually clearing the dev process). Residual: an admin deliberately rewriting branch
   protection AND the floor config is out of threat scope (that actor owns the repo).
   Reversibility: the floor list is config; tightening it is one edit.
9. **Accepted residual — stale-base merges (round-5, external GPT-tier finding stated
   honestly).** `--admin` deliberately bypasses the up-to-date-branch requirement — that
   is the design's answer to the conflict-rot treadmill (Alternatives, reason 2; PR #1084
   went CONFLICTING within an hour of green). The consequence, stated plainly: the
   PR's checks ran against the merge-base as of its last push, so "head checks green"
   does NOT prove "current base + head is green" — a semantically conflicting change
   landed on `main` after the PR's last CI run can merge untested. Bounds on the
   residual: (a) textual conflicts never merge (`mergeable == MERGEABLE` is a candidate
   requirement); (b) `main` runs the full CI suite on every push, and the Zero-Failure
   standard makes any post-merge breakage a current, owned failure — the watcher's audit
   names exactly which merge landed it; (c) the repo's branch protection does not require
   up-to-date branches even for manual merges today, so the watcher introduces no NEW
   exposure — it relocates the existing manual-merge residual unchanged. Scope honestly
   narrowed: "pre-approved by construction" claims the PR's own content passed every
   gate — not that its integration with every future `main` is proven. `approved: true`
   ratifies this residual like Decisions 1 and 3. Reversibility: a `minGreenAgeMs` /
   re-verify-against-test-merge-commit tightening, or adopting the native up-to-date
   path, are config/behavior-level changes requiring no design change.

## Open questions

*(none)*

## Out of scope

- Non-canonical repos (other projects an agent contributes to).
- Auto-resolving a CONFLICTING PR (audited as `waiting:conflicting`; resolution stays with
  the authoring agent — surfaced via the hold-age backstop if it rots).
- Any change to branch protection or CI itself.
- Arming GitHub native auto-merge as a complementary belt (documented alternative; may be
  adopted later without design change).
