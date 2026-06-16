---
title: "MergeRunner Auto-Arm Handoff — arm GitHub native auto-merge instead of poll-until-merged"
slug: "mergerunner-auto-arm-handoff"
author: "echo"
parent-principle: "Structure > Willpower"
eli16-overview: "docs/specs/mergerunner-auto-arm-handoff.eli16.md"
ships-staged: true
lessons-engaged: [P1-structure-beats-willpower, P2-signal-vs-authority, P4-testing-integrity, P14-distrust-temporary-success, B10-verify-landed-before-claiming, B24-gate-latency-vs-client-timeout, close-the-loop, no-unbounded-loops]
status: draft
---

## Problem statement

The green-PR auto-merge watcher (`GreenPrAutoMerger` + `MergeRunner`) is supposed to land a green, mergeable, non-held PR this agent authored without anyone clicking merge — "Phase 7 becomes machinery, not memory." Today it does this by SPAWNING `scripts/safe-merge.mjs ... --admin` and **synchronously watching the merge land** inside a bounded child process. That synchronous-watch path has a structural failure mode that defeats the whole feature on exactly the PRs it matters most for.

The mechanism of the failure:

1. `MergeRunner.run()` spawns safe-merge with a deadline (`MergeRunner.ts:175-191`): the child is hard-killed at `mergeTimeoutMs + mergeKillGraceMs` (`MergeRunner.ts:184`), and inside safe-merge's `--admin` path the script itself runs a **poll loop** waiting for every check to settle, bounded by `--deadline-ms` (`safe-merge.mjs:436-456`, the `for(;;) { ... sleep(15_000); }` wait that exits `refused:checks-timeout` at the deadline).
2. The watcher's whole-attempt budget is driven by `mergeTimeoutMs` (default `1_500_000` ms = 25 min; `GreenPrAutoMerger.ts:167`). The slow CI jobs on this repo — **Build / Integration Tests / E2E Tests** (`safe-merge.mjs:64-71` floor) — routinely take longer than the watcher is willing/able to keep a foreground child alive, and the watcher's merges themselves trigger releases → auto-update → **server restart** (documented in `MergeRunner.ts:22-25`), which kills the in-flight child mid-poll. A restart mid-attempt is a NORMAL condition here, not an edge case.
3. Net effect: the polling child gets killed (deadline OR server restart) before the slow jobs finish, safe-merge never reaches its merge call, and **the PR never merges**. The agent has to come back and merge by hand — the exact manual click the feature exists to remove. This is the "~18-minute watcher killed before Build/Integration/E2E finish" failure the operator hit.

The root cause is that the watcher is the thing waiting. As long as a LIVE process has to survive until CI is green, any kill of that process (deadline, restart, crash, lease move) loses the merge. No amount of retry tuning fixes a class where the waiter is structurally short-lived and the wait is structurally long.

GitHub already solved this: **native auto-merge** ("Allow auto-merge", enabled on `JKHeadley/instar`). When armed, GitHub itself merges the PR the instant every REQUIRED check passes, enforcing branch protection (no `--admin` bypass), and **never times out**. PR #1185 shipped the `--auto` primitive in `safe-merge.mjs` (`safe-merge.mjs:28-39, 388-434`) precisely so the watcher could hand the wait off to GitHub. This spec switches `MergeRunner` onto that primitive.

## Proposed design

### The arm-and-handoff flow

Replace the synchronous poll-then-merge attempt with an **arm-and-return** attempt:

- `MergeRunner.run()` spawns safe-merge with `--auto` instead of `--admin` (the new callsite; see below). All the cheap pre-flight that safe-merge does on the `--auto` path — open, not-draft, head-not-moved (`safe-merge.mjs:361-386`) — still runs. Arming is a single, fast `gh pr merge ... --auto` call (`safe-merge.mjs:397-434`); there is no internal poll loop, so the child exits in seconds regardless of how slow CI is.
- safe-merge's `--auto` path returns three relevant classifications:
  - exit `0`, `result: 'merged'` — checks were ALREADY green; GitHub merged immediately (`safe-merge.mjs:417-420`). Independently confirmed by safe-merge's own re-read.
  - exit `5`, `result: 'auto-merge-armed'` — auto-merge is armed and confirmed armed on re-read; GitHub will merge when checks pass (`safe-merge.mjs:421-425`).
  - exit `1`, `result: 'refused:auto-arm-*'` — arming failed (e.g. closed/already-merged/auto-merge-disabled) (`safe-merge.mjs:405-412`).
- The new whole-attempt deadline is short (seconds, not 25 min): arming is a single API call. The `mergeTimeoutMs` invariant tuning (`validateTimeoutInvariant`, `GreenPrAutoMerger.ts:207-214`) is preserved but its meaning shrinks to "how long arming may take," which is trivially satisfied.

### The `confirmedMerged` accounting change (the load-bearing semantic)

**This is the heart of the change.** Today (`MergeRunner.ts:197-204`):

```
outcome = parseResultLine(...)          // 'merged' | 'refused:*' | 'error:*' | ...
confirmedMerged = false
if (outcome === 'merged')
  confirmedMerged = await confirmMerged(pr, repo)   // independent gh pr view
return { outcome, confirmedMerged, deadlineKilled }
```

and the orchestrator (`GreenPrAutoMerger.ts:451-454`):

```
// B10: classify "merged" ONLY on independent confirmation.
outcome = (result.outcome === 'merged' && !result.confirmedMerged)
  ? 'error:merge-unconfirmed' : result.outcome
recordOutcome(state, target, outcome)
return outcome === 'merged'   // a confirmed merge reaps the episode (line 466-468)
```

The B10 invariant is: **a `merged` outcome is only trusted when an independent `gh pr view` confirms `state === MERGED`.** With the synchronous `--admin` path, the merge has ALREADY landed when `run()` returns, so the synchronous confirm is correct.

With `--auto`, **the merge has NOT landed at arm time** (except the immediate-green case). So `confirmedMerged` can no longer be set synchronously at arm time without lying — calling `confirmMerged` right after arming would return `false` (the PR is still OPEN), and today's logic would WRONGLY rewrite `auto-merge-armed` work into `error:merge-unconfirmed`, advance the failure ladder, and eventually give up — the precise inverse of the intent.

New semantics — split "armed" from "merged," and confirm the eventual merge on a LATER tick:

1. **Add a terminal-success-pending outcome `armed`** to `MergeRunResult`. `MergeRunner.run()`:
   - `result: 'merged'` (immediate-green) → keep current behavior: `confirmMerged()` independently, `outcome: 'merged'`, `confirmedMerged` per the confirm. (B10 unchanged for the synchronous merge.)
   - `result: 'auto-merge-armed'` (exit 5) → `outcome: 'armed'`, `confirmedMerged: false`. **This is not a failure and not yet a success** — it is "GitHub now owns the merge."
   - any `refused:auto-arm-*` / `error:*` / `closed` / `already-merged` → unchanged classification.
2. **`armed` does NOT feed the failure ladder and does NOT reap the episode.** It records, in the PR's episode, an `armedAt` timestamp + the `headRefOid` that was armed. `applyOutcome` (`greenPrLogic.ts:164-191`) gains an `armed` branch that is `terminal:false, feedsBreaker:false` and stamps `ep.armedAt`/`ep.armedHead`. The episode stays alive so a LATER tick can confirm the eventual merge.
3. **Confirmation moves to a later tick (the "armed-episode reconciliation" step).** At the TOP of each acting tick — before candidate gathering — the watcher reconciles any episode carrying `armedAt`:
   - `gh pr view` the PR (reuse the existing `refetchPr`/`prState` seam, `greenPrAutomergeWiring.ts:138-142`).
   - `state === MERGED` → **this is the B10-confirmed `merged`**: now reap the episode (delete it, `GreenPrAutoMerger.ts:466-468`), audit `event: 'merged'` (so the existing accounting that downstream consumers read is unchanged — a merge is still recorded as `merged`, just one tick later), and count it as a confirmed merge for status.
   - `state === CLOSED` → record `closed-by-other` (auto-merge was cancelled / PR closed); reap.
   - still `OPEN` with auto-merge armed AND head unchanged → leave the episode `armed`; this is the steady state while CI runs. No ladder advance.
   - still `OPEN` but **auto-merge NO LONGER armed** (e.g. a force-push disarmed it, or a maintainer turned it off) OR **head moved** past `armedHead` → clear `armedAt` and let the normal candidate path re-evaluate and (if still eligible) re-arm. A new head is a genuine new attempt; bounded by the existing `maybeRearm` ladder (`greenPrLogic.ts`, `maxRearmEpisodes`).
   - An `armed` episode that has been armed longer than an absolute ceiling (`armedConfirmCeilingMs`, default 24 h) with the PR still OPEN raises ONE aggregated attention line ("PR #N has had auto-merge armed for >24h and still hasn't merged — CI may be stuck or red; needs a look") via the existing `refreshAggregate` (`GreenPrAutoMerger.ts:506-512`) and clears `armedAt` so it stops being silently watched forever (Close the Loop; P19 no-unbounded-loops). The episode is NOT given up — the PR is still GitHub's to merge — it is surfaced.
4. **Status reporting.** `GET /green-pr-automerge` (`routes.ts:8050-8068`) already serializes `episodes`. An `armed` episode now carries `armedAt`/`armedHead`, so the operator can see "armed, waiting on GitHub" without any route change. (Optional: add an `armedCount` convenience field — cheap, non-load-bearing.)

The crucial property: **`confirmedMerged` stays the B10 truth — an independent `gh pr view` showing MERGED — it just moves from "synchronously after the merge command" to "on the reconciliation tick after GitHub merges."** We never claim a merge we haven't independently observed. The only thing that changed is the merge happens asynchronously, so the confirmation is asynchronous too.

### How each existing guard is preserved

Every guard is upstream of, or orthogonal to, the act-path swap. The swap touches only HOW the merge is performed (arm vs poll+admin) and WHEN it's confirmed (later tick vs synchronously) — not WHETHER the PR is allowed to merge.

- **Dual-latch gate (R9, rollback / emergency-pause / pool-disarm)** — read each tick before any act (`GreenPrAutoMerger.ts:274-280`). Unchanged; arming is gated identically to merging. A disarm mid-flight: an already-ARMED PR is GitHub's to merge, but the watcher will not arm any NEW PR while disarmed, and the reconciliation step is a read-only `gh pr view` (no mutation) so it is safe to run under disarm. (See Frontloaded Decision (e).)
- **Hold markers (`[HOLD:]` title / `hold`/`do-not-merge` label / draft)** — `classifyCandidate` + `holdReasonOf` + the immediate-pre-act `refetchPr` re-check (`GreenPrAutoMerger.ts:422-429`) run before arming exactly as before. A held PR is never armed.
- **Protected-paths exclusion** — `gather()` routes a protected-path PR to the operator and never adds it to `eligible` (`GreenPrAutoMerger.ts:368-385`). Unchanged; only eligible PRs reach the arm step.
- **Breaker** (`busy-skip` / `deadline-kill` / `tick-failed` thresholds) — unchanged. Note `deadline-kill` becomes rare-to-never on the arm path (arming doesn't poll), which is correct: the breaker existed partly to catch wedged long-poll children, and that class is now eliminated structurally rather than tripped.
- **Identity check (R4, `expectedGhLogin`)** — `identityOk()` runs before any act (`GreenPrAutoMerger.ts:394-400`). Unchanged; we never arm a PR if the gh login doesn't match `expectedGhLogin`.
- **Lease / single-flight (R10/R5)** — ticks run only on the lease holder; `inFlight` single-flight wraps the act (`GreenPrAutoMerger.ts:261-272, 436-445`). Unchanged. (The single-flight window is now SHORTER — arming returns in seconds — which strictly reduces overlap risk.)
- **Warm-up + orphan reap** — first tick of a tenure is observe-only; `reapOrphan` reaps a crashed child (`GreenPrAutoMerger.ts:289-321, 495-502`). Preserved. The durable in-flight record still wraps the (now much shorter) arming spawn, so a crash mid-arm is still reaped; and the new armed-episode reconciliation is the analogous "did the async merge land?" recovery, surviving restart because it reads from durable episode state.
- **Head pinning** — safe-merge's `--auto` path honors `--match-head-commit` (`safe-merge.mjs:399`), refusing if the head moved. We continue to pass `--match-head-commit attempt.headRefOid`. A push in the arming window still refuses, exactly as today.
- **Contract probe + pre-exec hash pin (round-3/round-5)** — `probeContract()` + the pre-exec re-hash (`MergeRunner.ts:125-163`) run before the arming spawn unchanged. safe-merge's `--capabilities` already advertises `native-auto-merge` and exit code `autoMergeArmed: 5` (`safe-merge.mjs:133-144`), so the existing contract-version-2 probe covers the `--auto` path with no contract bump.

### Fallback to the old poll+admin path

Native auto-merge is enabled on `JKHeadley/instar` today, but be defensive: a repo could have "Allow auto-merge" disabled (safe-merge surfaces this as `refused:auto-arm-*` with a hint, `safe-merge.mjs:410`). Behavior:

- **Default: arm path.** `MergeRunner` uses `--auto`.
- **Config lever `monitoring.greenPrAutoMerge.mergeStrategy`** with values `auto` (default) | `admin`. `admin` restores the exact current behavior (spawn `--admin`, synchronous poll+confirm, synchronous `confirmedMerged`). This is the rollback lever (Frontloaded Decision (c)) AND the escape hatch for a repo without native auto-merge.
- **Automatic one-shot fallback (defensive, NOT silent):** if the arm attempt returns `refused:auto-arm-*` whose classified cause indicates auto-merge is unavailable on the repo (vs. a transient/closed/already-merged cause), record the refusal, audit `event: 'auto-merge-unavailable'`, raise ONE aggregated attention line telling the operator to either enable "Allow auto-merge" or set `mergeStrategy: admin`, and do NOT auto-retry on `--admin` within the same tick. We do not silently flip to a bypass path — the operator chooses (signal, not authority). The attempt ladder treats the refusal as a normal refusal (backoff), so a genuinely transient arming failure self-recovers on a later tick.

## Decision points touched

- **Merge-decision authority — UNCHANGED.** The authority for "is this PR allowed to merge" is, and remains, the union of: the upstream candidate/hold/protected-path/identity gates in the watcher, and safe-merge's act-time re-verification of required contexts. Arming native auto-merge is **not a new authority** — it is a HANDOFF of the *wait* to GitHub, with GitHub enforcing the SAME required checks (branch protection) that `--admin` would have bypassed. If anything, `--auto` is STRICTER than `--admin`: `--admin` bypasses required-check enforcement and re-imposes it in script; `--auto` lets GitHub enforce it natively and cannot bypass it. No decision boundary is loosened.
- **Signal vs. authority (P2).** Arming is a non-brittle handoff, not a new block. The reconciliation step is a READ (`gh pr view`) that only updates accounting; it never gates a message, blocks a send, or rewrites anything. The `armed`-too-long ceiling is a SIGNAL (one attention line), never a forced give-up. Nothing in this change introduces a new failure-closed gate on the user's path; the only failure direction remains fail-toward-skip (don't merge), preserved from the existing design.

## Frontloaded Decisions

(a) **How is `confirmedMerged` now confirmed — later tick vs. follow-up read?** A LATER TICK, via an "armed-episode reconciliation" step at the top of each acting tick that does an independent `gh pr view` (reusing the existing `prState`/`confirmMerged` seam). Rationale: it survives server restart for free (episode state is durable on disk, `green-pr-automerge.json`), needs no new background timer (P19 — no new unbounded loop; it rides the existing ~10-min tick), and keeps the B10 invariant exactly ("merged" is only ever recorded after an independent MERGED read). A dedicated follow-up poller was rejected as a second waiter that would reintroduce the very "live process must survive the wait" fragility we're removing.

(b) **Arming SUCCEEDS but the PR later fails CI and never merges — what happens?** This is SAFE and requires no watcher action: GitHub will NOT merge a PR whose required checks are red — armed auto-merge simply waits, and if a check fails it stays unmerged (auto-merge remains armed; GitHub re-attempts if the check is re-run green). The watcher's reconciliation sees the PR still OPEN and leaves the `armed` episode alone. The only backstop is the `armedConfirmCeilingMs` (default 24h) attention line so a PR that's been armed-but-stuck for a day gets surfaced to the operator rather than watched forever. We document explicitly: an armed-but-red PR is the correct, safe resting state — GitHub is the gate, not us.

(c) **Rollback.** Two layers: (1) `monitoring.greenPrAutoMerge.mergeStrategy: 'admin'` restores the exact current poll+admin+synchronous-confirm behavior in one config field (read at tick time / on next restart). (2) The whole feature still rides the existing dual-latch rollback (`POST /green-pr-automerge/rollback`) and the dark/enabled flags. No new rollback surface is needed.

(d) **Dev-gated/dark or live for armed agents?** This changes the act path of an ALREADY-armed, already-live feature (`monitoring.greenPrAutoMerge` with `expectedGhLogin` set — Echo's dev agent). It is therefore **live behavior for agents that already have auto-merge enabled**, gated by the same `enabled` + dual-latch + `dryRun` switches that already guard the watcher. It ships behind `mergeStrategy` defaulting to `auto`; an operator who wants the old path sets `admin`. On a plain install with no analyzable repo, the watcher is null (`routes.ts:8051`) and this is a no-op. We soak with `dryRun: true` first (the watcher logs `would-merge` and never arms) exactly as the original feature soaked.

(e) **Disarm/rollback hits between arm and merge.** An already-armed PR is GitHub's to merge — a watcher disarm does NOT un-arm it (the watcher does not call `gh pr merge --disable-auto` on disarm; that would be a new, surprising mutation). Disarm prevents arming any NEW PR and is honored at the top of the tick. If the operator genuinely needs to stop an armed merge, they apply a `[HOLD:]`/`hold` label (GitHub auto-merge does not bypass a hold-driven mergeability change) or disable auto-merge on the PR directly. Documented so the operator knows disarm ≠ un-arm.

(f) **`--auto` and `--admin` mutual exclusion.** safe-merge already refuses the incoherent combo (`safe-merge.mjs:124-128`). `MergeRunner` passes exactly one strategy flag per attempt, so this is never tripped, but the guard is a correct backstop against a future miswiring.

(g) **Immediate-green case (checks already passed at arm time).** safe-merge returns `result: 'merged'` exit 0 (`safe-merge.mjs:417-420`). `MergeRunner` keeps the synchronous-confirm behavior for this case (it IS a synchronous merge), so a fast PR still records `merged`/`confirmedMerged:true` in the SAME tick — no regression for the common already-green case.

(h) **Episode/state schema migration.** `armedAt`/`armedHead` are NEW optional fields on `Episode`. `loadState` already spreads over `freshState()` (`greenPrAutomergeWiring.ts:156-161`), so an old state file without these fields loads cleanly (fields simply absent → treated as "not armed"). No migration script needed; forward-compatible by construction.

(i) **Tests.** Tier-1: `merge-runner.test.ts` gains cases for the `--auto` argv (asserts the spawned args carry `--auto`, not `--admin`), the `armed` outcome mapping (exit-5 result → `outcome:'armed'`, `confirmedMerged:false`, NOT downgraded to error), and the immediate-green case (`merged` exit 0 → synchronous confirm). `green-pr-automerger.test.ts` gains the reconciliation-tick cases (armed→MERGED reaps + records `merged`; armed→still-OPEN holds; armed→head-moved re-evaluates; armed→ceiling raises one attention line). `greenPrLogic` gets the `armed` branch of `applyOutcome` (terminal:false, feedsBreaker:false). Tier-2/3 unchanged route surface (`green-pr-automerge-routes.test.ts`) plus an assertion that an `armed` episode serializes in `GET /green-pr-automerge`.

## Multi-machine posture

`MergeRunner` and `GreenPrAutoMerger` are **per-machine** and ALREADY multi-machine-correct via the existing lease gate: ticks (including the new reconciliation step) run ONLY on the lease holder (`GreenPrAutoMerger.ts:261-264`), and the durable in-flight record + warm-up reap handle a lease move mid-attempt. The async-merge change actually IMPROVES the multi-machine story: if the lease moves between arming and GitHub completing the merge, the merge still lands (GitHub owns it, not the old leaseholder's process), and whichever machine next holds the lease runs the reconciliation read and records the confirmed `merged`. Episode state replicates with the existing `green-pr-automerge.json` state file on the lease holder; no new cross-machine state is introduced. No change to the lease/pool model is required.

## Open questions

**NOT CONVERGED — spec-converge Round 1 surfaced a premise correction + 5 blockers requiring a substantial rewrite before round 2.** See `docs/specs/reports/mergerunner-auto-arm-handoff-round1-findings.md`. Summary of what must be resolved:

1. **Premise correction (gating):** the `MergeRunner` only acts on already-settled-green PRs (`classifyCandidate` requires `statusRollup === 'SUCCESS'`), so it never waits on slow CI — the problem statement's "watcher-kill on slow CI" framing is wrong. Rewrite around the real value: faster lease-slot release + surviving a restart-mid-merge.
2. **Head-pin binding** — does GitHub native auto-merge re-enforce `expectedHeadOid` / cancel on a write-capable push after arming? Empirically verify, or document the residual race + add reconciliation `mergeCommitOid` vs `armedHead` mismatch detection.
3. **Re-arm thrash** — exclude armed-episode PRs from `gather()`.
4. **Disarm reach** — rollback/emergency-pause + explicit operator HOLD must `gh pr merge --disable-auto` armed episodes (the HOLD-label workaround does NOT stop GitHub).
5. **Multi-machine** — make GitHub `autoMergeRequest` the source of truth for "already armed" (machine-local episode state strands on a lease move).
6. **24h ceiling** — keep reconciling + re-surface (don't silently drop a still-armed PR — Close the Loop).

Plus the materials in the findings report (UNKNOWN fail-open, `armTimeoutMs`, episode field-state, config defaults, observability). The gemini cross-model pass + round-2 converge are the next chunk.
