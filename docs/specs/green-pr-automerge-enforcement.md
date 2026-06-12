---
title: Green-PR Auto-Merge Enforcement — Phase 7 becomes machinery, not memory
approved: false
eli16-overview: green-pr-automerge-enforcement.eli16.md
topic: 24662
parent-principle: "No Manual Work (user *or* agent)"
---

# Green-PR Auto-Merge Enforcement — Phase 7 becomes machinery, not memory

**Status:** DRAFT (pre-convergence). Author: echo · Created: 2026-06-12 · Topic: 24662
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
- **Gap 2 — nothing intercepts the hand-back at the chokepoint.** An agent saying "merge is
  yours" / ending its session with a green unmerged PR gets no structural pushback.

## What exists today (v1.3.500-era main, file:line grounded)

- **Phase 7 prose**: `skills/instar-dev/SKILL.md` §"Phase 7 — Auto-merge on green (EVERY
  tier — never pause to ask)" — mandates `node scripts/safe-merge.mjs <PR#> --squash
  --admin` once green, then ship-narration via `/telegram/post-update`. Instructions only;
  no gate enforces it.
- **`scripts/safe-merge.mjs`**: the blessed merge wrapper. Waits for ALL checks to finish,
  refuses if any is red, specifically confirms an e2e check ran and passed, then merges
  (`--admin` bypasses only the up-to-date-branch requirement, never the green requirement).
  This is the verification authority this spec builds on — the new machinery SELECTS
  candidates and INVOKES safe-merge; it never re-implements the green check.
- **`ReleaseReadinessSentinel`** (`src/monitoring/ReleaseReadinessSentinel.ts`): the
  precedent shape — a repo-gated watcher over "finished work sitting idle", near-silent,
  episode-keyed, fail-loud, attention-aggregated. This spec's watcher is its sibling one
  step earlier in the pipeline (unmerged green PR → unreleased merged commit).
- **Stop-gate router** (agent-home hook `.instar/hooks/instar/stop-gate-router.js`,
  installed/migrated by instar): already blocks a session stop once when the final message
  states a continuation that isn't happening ("stated-continuation" gate). It fired twice
  during the 2026-06-12 session — the chokepoint exists and works; it just has no green-PR
  check.
- **Dev-agent dark gate** (`resolveDevAgentGate`, `src/core/devGatedFeatures.ts`, enforced
  by `scripts/lint-dev-agent-dark-gate.js`): the standard way a feature ships live on the
  instar-developing agent and dark on the fleet.
- **Topic history note**: PR #1066 deliberately sits open with title prefix
  `[HOLD: merge = cutover flip]` — deliberate holds are a real, current pattern the
  machinery must respect.

## Requirements

- R1 — **Machinery, not memory**: an agent-authored PR on the canonical repo that is green,
  mergeable, and not deliberately held MUST get merged by a background component that
  survives session death. No session needs to remember anything.
- R2 — **safe-merge is the only merge authority**: candidate selection and invocation are
  the new code; the green verification and the merge itself are `scripts/safe-merge.mjs`,
  unchanged. The watcher MUST NOT carry an independent merge path.
- R3 — **Deliberate holds always win**: a PR with a `[HOLD` title prefix, a `hold` /
  `do-not-merge` label, or draft status is never auto-merged, and each skip is audited with
  its reason.
- R4 — **Authored-by-me only**: only PRs the agent itself authored (the `gh` authenticated
  login) are candidates. Another author's PR is never touched, regardless of state.
- R5 — **Bounded + braked** (No Unbounded Loops): at most one merge attempt per tick;
  failure ladder with backoff; a breaker after consecutive failures; every attempt and
  every skip audited to a JSONL trail; failures fold into ONE aggregated Attention item
  (Bounded Notification Surface).
- R6 — **Stop-gate belt**: the session stop-gate gains a deterministic check — if the
  ending session's agent has an open, green, non-held PR it authored on the canonical
  repo, the stop is blocked ONCE with "merge it (safe-merge) or mark it [HOLD]" guidance.
  Fail-open on any error or timeout (a broken gh call must never trap a session).
- R7 — **Dev-agent scope**: ships live on the instar-developing agent via the standard
  dev-agent gate; inert (repo-gated) on installs with no analyzable instar repo and dark on
  non-dev agents. Fleet behavior changes only by the later deliberate flip.
- R8 — **Observable Intelligence / audit**: every decision (candidate-found, skipped:why,
  merge-attempted, merged, merge-failed, breaker-open) is one JSONL line; a read-only
  status surface reports the last tick, candidates, and breaker state.

## Design

### Layer 1 — `GreenPrAutoMerger` (src/monitoring/GreenPrAutoMerger.ts)

A small watcher in the ReleaseReadinessSentinel mold:

- **Tick** (default every 10 min, config `tickIntervalMs`): `gh pr list --author "@me"
  --state open --json number,title,labels,isDraft,headRefName` on the canonical repo
  (resolved the same way release-readiness resolves it; repo-gated — no repo, no ticks).
- **Filter** (each exclusion audited): draft → skip; `[HOLD` title prefix or `hold`/
  `do-not-merge` label → skip; per-PR checks not all green or not MERGEABLE → skip
  (recorded as `waiting`, not an error).
- **Act**: for the OLDEST eligible candidate only (one per tick): run
  `node scripts/safe-merge.mjs <PR#> --squash --admin` with a bounded timeout. safe-merge
  re-verifies greens itself (R2) — a race with a freshly-red check resolves to refusal.
- **Failure ladder**: a failed attempt backs off per-PR (attempt count in the episode
  state); after `maxAttempts` (default 3) the PR is marked `gave-up` (re-armed by any new
  push to the branch) and folded into the aggregated Attention item. `breakerThreshold`
  consecutive failures across PRs opens a cooldown breaker.
- **State**: episode file `state/green-pr-automerge.json` (machine-local, single-writer —
  registered in the state-coherence registry at birth); audit trail
  `logs/green-pr-automerge.jsonl` (5MB×2 rotation, same pattern as resume-queue's audit).
- **Status surface**: `GET /green-pr-automerge` → `{ enabled, lastTickAt, candidates,
  merged, gaveUp, breaker }` (Bearer-auth; 503 when off — Testing Integrity's feature-alive
  E2E hits this).
- **Config** (`monitoring.greenPrAutoMerge`): `enabled` resolved via the standard
  dev-agent gate (key deliberately ABSENT from ConfigDefaults per the dark-gate lint
  convention), `tickIntervalMs` (600 000), `maxAttempts` (3), `breakerThreshold` (3),
  `breakerCooldownMin` (60), `mergeTimeoutMs` (900 000), `dryRun` (false — see Decisions).
- **Supervision**: Tier 0. The pipeline it acts on is already Tier-2-supervised end to end
  (converged spec → gates → CI); the watcher adds no judgment, only scheduling. Its own
  conduct is fully audited (R8).

### Layer 2 — stop-gate green-PR check (template + migration)

The stop-gate router (agent-home hook, shipped from `src/templates`/hook templates and
always-overwritten by `migrateHooks()`) gains one deterministic check before allowing a
session stop: with a short-timeout `gh pr list --author "@me" --state open` + per-PR check
status (cached for the gate's life; fail-open on ANY error, timeout, or missing `gh`), if a
green non-held authored PR exists → block ONCE (same one-shot semantics as the existing
stated-continuation gate) with: *"PR #N is green and unmerged. Run `node
scripts/safe-merge.mjs N --squash --admin`, or mark it `[HOLD: <reason>]` if the wait is
deliberate."* A session that stops anyway on the second attempt is allowed — the gate
nudges once, Layer 1 remains the guarantee.

### Migration parity

- Hook script change rides `migrateHooks()` (built-in hooks always overwritten — existing
  agents get the new stop-gate check on update).
- Config defaults: nothing added to ConfigDefaults for `enabled` (dev-gate convention);
  numeric tunables added via `migrateConfig()` existence-checked.
- CLAUDE.md template + `migrateClaudeMd()`: a short "Green-PR auto-merge" awareness section
  (the status route + the HOLD convention), content-sniffed.
- The skill's Phase 7 text is updated to state the machinery ("the GreenPrAutoMerger will
  merge it if you don't — merging it yourself is still correct and faster").

### Testing (three tiers, per TESTING-INTEGRITY-SPEC)

- **Unit**: candidate filter both sides (draft / HOLD title / hold + do-not-merge labels /
  other-author / red / not-mergeable vs clean green); oldest-first single-attempt-per-tick;
  ladder + gave-up re-arm on new head SHA; breaker open/close; dry-run inertness;
  episode-state persistence round-trip; audit rows for every decision class; stop-gate
  check both sides incl. fail-open on gh error/timeout and the one-shot block semantics.
- **Integration**: `GET /green-pr-automerge` through createRoutes (503 unwired, 200 wired);
  a fake-gh harness driving candidate → safe-merge invocation argv (the wrapper itself is
  invoked, asserted at the spawn boundary) → merged episode; burst invariant: K
  permanently-failing candidates → bounded attempts, breaker, ONE aggregated attention id,
  zero per-PR items.
- **E2E**: feature-alive — real AgentServer boots with the watcher wired the way server.ts
  wires it; status route returns 200 with real state; wiring integrity (gh runner, audit
  sink, attention sink real and delegating).

## Decisions (resolved per the operator's standing directive — design forks mine, report after)

1. **No dry-run soak for the dev agent; `dryRun` exists only as a rollback lever.** This is
   not new authority: Phase 7 already MANDATES this exact merge, manually, since 2026-06-09,
   and safe-merge re-verifies every green. Automating a mandated, pre-verified action is
   enforcement, not escalation. (The graduated-rollout standard governs new autonomous
   authority; the operator has twice directed that this behavior is already required.)
2. **One candidate per tick, oldest first** — keeps the loop bounded and the audit legible;
   a backlog of N green PRs drains in N ticks (~N×10 min), which is faster than any human
   click loop it replaces.
3. **Layer 3 (outbound "merge is yours" message detector) is OUT of scope** — it overlaps
   Layer 2's chokepoint, triples the surface for the same failure mode, and the two
   in-scope layers each independently close the incident that motivated this spec.
4. **Squash merge, delete branch** — matches the repo's existing merge convention (every
   recent PR on main is a squash; safe-merge already supports it).

## Out of scope

- Non-canonical repos (other projects an agent contributes to) — the gate and watcher are
  scoped to the instar repo this install develops.
- Auto-resolving a CONFLICTING PR (the watcher audits it as `waiting:conflicting`; conflict
  resolution stays with the authoring session/agent).
- Any change to branch protection or CI itself.
