---
title: "MergeRunner Auto-Arm Handoff — arm GitHub native auto-merge instead of poll-until-merged"
slug: "mergerunner-auto-arm-handoff"
author: "echo"
parent-principle: "Structure beats Willpower"
ships-staged: true
lessons-engaged: [P1-structure-beats-willpower, P2-signal-vs-authority, P4-testing-integrity, P14-distrust-temporary-success, B10-verify-landed-before-claiming, B24-gate-latency-vs-client-timeout, challenge-the-mechanism, close-the-loop, no-unbounded-loops]
status: draft
review-convergence: "2026-06-16T05:40:24.402Z"
review-iterations: 3
review-completed-at: "2026-06-16T05:40:24.402Z"
review-report: "docs/specs/reports/mergerunner-auto-arm-handoff-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "gemini-cli:gemini-2.5-pro timeout; codex not installed"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 1
contested-then-cleared: 1
approved: true
---

## Problem statement

The green-PR auto-merge watcher (`GreenPrAutoMerger` + `MergeRunner`) lands a green, mergeable, non-held PR this agent authored without anyone clicking merge — "Phase 7 becomes machinery, not memory." Today it does this by SPAWNING `scripts/safe-merge.mjs … --admin` and **synchronously watching the merge land** inside a bounded child process. This spec switches that act path to **arm GitHub native auto-merge and hand off** (`safe-merge.mjs … --auto`), then confirms the eventual merge on a later tick.

**Honest diagnosis — what the value actually is (and is NOT).** An earlier draft framed the win as "the watcher keeps a foreground child alive ~18–25 min waiting for slow CI and gets killed before Build/Integration/E2E finish." That framing is **wrong for the in-server `MergeRunner`** and must not survive into the design. The watcher's candidate gate, `classifyCandidate` (`greenPrLogic.ts:58-72`), only marks a PR eligible when `pr.statusRollup === 'SUCCESS'` (line 70: `if (pr.statusRollup !== 'SUCCESS') return { eligible:false, skip:'not-settled-green' }`). The watcher therefore NEVER invokes safe-merge into a pending wait — by the time it acts, CI is already settled-green, so safe-merge's `--admin` poll loop (`safe-merge.mjs:439-456`) exits on its **first** iteration. The "~18-minute watcher killed before CI finishes" symptom in the run notes came from the separate, **manual background `safe-merge` watchers** (background Bash with their own deadline), NOT the `MergeRunner`. (Per the `challenge-the-mechanism` lesson — audit that the core mechanism is real before converging. It was not.)

The REAL, more modest value of arm-and-handoff, stated honestly so reviewers trust the corrected diagnosis:

1. **Frees the single-flight / lease slot in SECONDS instead of holding a ~25-min-budgeted child.** Even on a settled-green PR the `--admin` path is a synchronous merge command + an independent `confirmMerged` re-read held inside `inFlight` single-flight (`GreenPrAutoMerger.ts:436-445`) under a whole-attempt budget of `mergeTimeoutMs` (default `1_500_000` ms = 25 min; `MergeRunner.ts:184`). Arming is a single `gh pr merge … --auto` call that returns in seconds (`safe-merge.mjs:397-434`, no poll loop), so the single-flight window — and any overlap risk it creates — shrinks from "up to 25 min" to "seconds."

2. **Survives a server-restart-mid-merge.** This is the load-bearing benefit. The watcher's OWN merge triggers a release → auto-update → **server restart** (documented in `MergeRunner.ts:22-25`: "the watcher's merges trigger releases → auto-update restarts, so a restart mid-attempt is a NORMAL condition"). With `--admin`, that restart can kill the in-flight child between "GitHub accepted the merge" and "we independently confirmed it" — leaving the merge in an unconfirmed limbo the orchestrator then re-classifies as `error:merge-unconfirmed` and re-attempts. With native auto-merge, GitHub OWNS the merge; a restart cannot kill it, and whichever machine next holds the lease reconciles the confirmed result.

Native auto-merge ("Allow auto-merge", enabled on `JKHeadley/instar`) is the mechanism GitHub already provides: armed, it merges the PR the instant every REQUIRED check passes, enforcing branch protection (no `--admin` bypass), and never times out. PR #1185 shipped the `--auto` primitive in `safe-merge.mjs` (`safe-merge.mjs:28-39, 388-434`) precisely so the watcher could hand the merge off to GitHub. This spec switches `MergeRunner` onto that primitive, with the accounting and reconciliation machinery to keep the B10 honesty invariant exactly intact.

## Proposed design

### The arm-and-handoff flow

Replace the synchronous poll-then-merge attempt with an **arm-and-return** attempt, gated by `mergeStrategy` (`auto` default | `admin` legacy):

- `MergeRunner.run()` spawns safe-merge with `--auto` instead of `--admin`. All the cheap pre-flight safe-merge does on the `--auto` path — open, not-draft, head-not-moved (`safe-merge.mjs:361-386`) — still runs. Arming is a single, fast `gh pr merge … --auto` call (`safe-merge.mjs:397-434`); there is no internal poll loop, so the child exits in seconds.
- safe-merge's `--auto` path returns four relevant classifications (`safe-merge.mjs:405-433`):
  - exit `0`, `result:'merged'` — checks were ALREADY green; GitHub merged immediately, confirmed by safe-merge's own re-read (`safe-merge.mjs:417-420`).
  - exit `5`, `result:'auto-merge-armed'` — auto-merge is armed AND confirmed armed via the independent `autoMergeRequest` re-read (`safe-merge.mjs:421-425`).
  - exit `1`, `result:'refused:auto-arm-*'` — arming failed (closed / already-merged / **auto-merge disabled on the repo**) (`safe-merge.mjs:405-412`).
  - exit `2`, `result:'error:auto-arm-unconfirmed'` / `'error:auto-confirm-unreadable'` — gh reported success but the re-read could not confirm armed (`safe-merge.mjs:426-432`). **This is NOT a merge failure** (see "Non-ladder retry classes" below).

### The `confirmedMerged` accounting change (the load-bearing semantic)

**This is the heart of the change.** Today (`MergeRunner.ts:197-204` + `GreenPrAutoMerger.ts:451-454`): `outcome = parseResultLine(...)`, then `confirmedMerged = (outcome === 'merged') ? await confirmMerged(...) : false`, and the orchestrator rewrites `merged && !confirmedMerged → error:merge-unconfirmed`. The B10 invariant is: **a `merged` outcome is only trusted when an independent `gh pr view` shows `state === MERGED`.** With `--admin` the merge has ALREADY landed at `run()` return, so the synchronous confirm is correct.

With `--auto`, **the merge has NOT landed at arm time** (except the immediate-green case). So `confirmedMerged` can no longer be set synchronously at arm time without lying — calling `confirmMerged` right after arming returns `false` (the PR is still OPEN), and today's logic would WRONGLY rewrite `auto-merge-armed` into `error:merge-unconfirmed`, advance the failure ladder, and eventually give up — the precise inverse of intent.

New semantics — split **armed** from **merged**, confirm the eventual merge on a LATER tick:

1. **Add a terminal-success-pending outcome `armed`** to `MergeRunResult`. `MergeRunner.run()` maps:
   - `result:'merged'` (immediate-green) → `outcome:'merged'`, `confirmedMerged` per a synchronous independent `confirmMerged()`. (B10 unchanged for the synchronous merge.)
   - `result:'auto-merge-armed'` (exit 5) → `outcome:'armed'`, `confirmedMerged:false`, AND carry the armed head sha through. **This is not a failure and not yet a success** — it is "GitHub now owns the merge."
   - `refused:auto-arm-*` / `closed` / `already-merged` → unchanged classification (with `auto-merge-unavailable` classified terminal-non-ladder, below).
   - `error:auto-arm-unconfirmed` / `error:auto-confirm-unreadable` → a **non-ladder retry** class (below), NOT a `maxAttempts`-consuming merge failure.
2. **`armed` does NOT feed the failure ladder and does NOT reap the episode.** `applyOutcome` (`greenPrLogic.ts:164-191`) gains an `armed` branch returning `{ terminal:false, feedsBreaker:false }` and stamping the episode's `armedAt`/`armedHead` (exact field-state pinned below). The episode stays alive so a LATER tick confirms the eventual merge.
3. **Confirmation moves to an "armed-episode reconciliation" step at the TOP of every acting tick** (before candidate gathering; see the dedicated section). It reads each `armedAt` episode's live GitHub state (widened `refetchPr`/`prState` projection, below) and resolves it: MERGED → reap + record `merged`; CLOSED → reap + record `closed-by-other`; still-armed → leave; disarmed/head-moved → clear and re-evaluate; overdue → `armed-overdue` (Close the Loop, below).

The crucial property: **`confirmedMerged` stays the B10 truth — an independent `gh pr view` showing MERGED — it just moves from "synchronously after the merge command" to "on the reconciliation tick after GitHub merges."** We never claim a merge we haven't independently observed. The merge is now asynchronous, so the confirmation is asynchronous too.

**The B10 rewrite line MUST NOT touch `armed` (Blocker B — the precise wiring pin).** The existing B10 invariant in `act()` is a single rewrite line at `GreenPrAutoMerger.ts:452`:

```ts
const outcome = result.outcome === 'merged' && !result.confirmedMerged ? 'error:merge-unconfirmed' : result.outcome;
```

That rewrite is correct ONLY for `merged` — a `merged` slug with `confirmedMerged:false` is the B10 violation it catches. The new `armed` outcome carries `confirmedMerged:false` **BY DESIGN** (the merge has not landed at arm time; an independent confirm at arm time is meaningless), so `confirmedMerged:false` is CORRECT and EXPECTED for `armed`, NOT a B10 violation. The rewrite line is gated on `result.outcome === 'merged'`, so by construction it already leaves `armed` untouched — and the implementation MUST keep it that way:

- **DO NOT generalize the rewrite to a `merged`-mirror form** such as `(result.outcome === 'merged' || result.outcome === 'armed') && !result.confirmedMerged → 'error:…'`. That misimplementation would rewrite every legitimate `armed` into an error, advance the failure ladder, and eventually give up on a PR GitHub has genuinely armed — the exact inverse of intent. The B10 confirmation for an armed PR happens ONE TICK LATER in the reconciliation step (which DOES do the independent `gh pr view`), never at arm time.
- A Tier-1 test (in `(j)`) asserts an `armed` `MergeRunResult` (outcome `'armed'`, `confirmedMerged:false`, `armedHead` carried) passes through `act()` UNCHANGED into `applyOutcome`'s `armed` branch — and a companion negative test forbids the `merged`-mirror misimplementation (an `armed` result is never rewritten to `error:merge-unconfirmed`).

**`act()`'s return boolean for `armed` — terminal-success-pending, `acted:true`.** `act()` returns a boolean today (`outcome === 'merged'`) that the tick maps to `{ acted, reason: acted ? 'acted' : 'skipped' }`. The boolean means "did the watcher perform a real, intended terminal action on this PR this tick?" — NOT "did the PR merge." `armed` is a real terminal action (GitHub now owns the merge; the slot is freed; the episode is stamped `armedAt`), so **`act()` returns `true` for `armed`** (treated as terminal-success-pending). The tick reports `reason:'acted'`. This is distinct from `merged` (also `true`, immediate) and from a refusal/error/skip (`false`). The single-flight slot is correctly considered "used" for the tick on an `armed` outcome.

### Armed-episode reconciliation (the new top-of-tick step)

At the top of each acting tick — after the lease/single-flight/latch/breaker gates, before `gather()` — the watcher reconciles every episode carrying `armedAt`. For each:

- Read the PR's live state via the **widened** `refetchPr` projection (now including `state`, `headRefOid`, `mergeCommitOid`, and `autoMergeRequest` — see Blocker 4's projection-widening pin). The head-pin comparison operand is the PR's FINAL HEAD (`autoMergeRequest.expectedHeadOid` or `headRefOid` at merge time), NOT `mergeCommitOid` (which is the squashed base commit; see the MERGED branch below).
- **`state === MERGED`** → this is the B10-confirmed `merged`. **Compare the PR's FINAL HEAD (not the merge-commit oid) to `ep.armedHead`** (head-pin verification, Blocker 1):
  - **Squash precision (Round-2 fix — the detector must compare the right oid).** The configured merge method is `--squash` (`MergeRunner.ts:179`). A squash merge produces a NEW commit on the base whose oid is NEVER equal to the PR's head sha — so comparing `mergeCommitOid` to `ep.armedHead` would fire `merged-at-unexpected-head` on EVERY clean squash merge (a guaranteed false positive). The detector therefore compares **the PR's final head at merge time to `ep.armedHead`** — specifically the `autoMergeRequest.expectedHeadOid` if the projection surfaces it, ELSE the PR's `headRefOid` read at merge time (the tip the squash was produced FROM). It does NOT compare `mergeCommitOid`. (Note `mergeCommitOid` is null until the merge actually happens — it is a post-hoc field, available only on the MERGED read, and even then it is the squashed base commit, not the PR head; it is informational for the audit line but is NOT the comparison operand.) The previously-mentioned "a known descendant we armed" allowance is dropped as undefined — the comparison is a direct equality of the PR's final head vs `ep.armedHead`.
  - match (PR final head === `ep.armedHead`) → audit `event:'merged'`, reap the episode (`delete state.episodes[pr]`), count it as a confirmed merge for status. Downstream accounting is unchanged (a merge is still recorded as `merged`, one tick later).
  - **mismatch (PR final head ≠ `ep.armedHead`)** → the PR merged at a head we did NOT arm. Audit `event:'merged-at-unexpected-head'` (carry `armedHead` + the observed final head + `mergeCommitOid` for forensics), raise ONE attention line ("PR #N auto-merged at a head I did not arm — review the merged commit"), AND still reap (the merge happened; this is post-hoc detection of the residual race, not a block). See Blocker 1 for the full risk treatment.
- **`state === CLOSED`** → record `closed-by-other` (auto-merge cancelled / PR closed); reap.
- **still `OPEN`, `autoMergeRequest` present, head unchanged** → steady state while CI runs. No ladder advance, no breaker feed. Leave the `armed` episode.
- **still `OPEN` but `autoMergeRequest` ABSENT** (a force-push disarmed it, or a maintainer turned it off) OR **head moved past `armedHead`** → clear `armedAt`/`armedHead` and let the normal candidate path re-evaluate and (if still eligible) re-arm. A new head is a genuine new attempt, bounded by the existing `maybeRearm` ladder.
- **read FAILS / `state === UNKNOWN`** → **fail-open** (see "UNKNOWN / read-failure" below): leave the episode armed, NO ladder advance, NO breaker feed, retry the read next tick. We never give up on a real in-flight GitHub merge because of a transient read error.
- **armed longer than `armedConfirmCeilingMs` (default 24h) and still OPEN** → transition to `armed-overdue` (Close the Loop, Blocker 5) — keeps reconciling, re-raises a deduped attention line on a cadence; never clears `armedAt`.

This step is a READ-ONLY reconciliation. It does not call `gh pr merge` (the disarm `--disable-auto` is a SEPARATE, in-route action — see Blocker 3a; un-arming an already-armed PR never happens inside the tick), and it survives a server restart for free because it reads from durable episode state (`green-pr-automerge.json`) — no new background timer (P19, no new unbounded loop; it rides the existing ~10-min tick). Note the reconciliation step itself runs only on an ACTING tick (it sits below the dual-latch `disabled:` early-return at `GreenPrAutoMerger.ts:274-280`), so it does NOT run while a disarm latch is live — which is exactly why the disarm reach cannot live here and must be the in-route call.

### Exclude already-armed PRs from gather() (Blocker 2 — re-arm thrash)

An already-armed-but-green PR still satisfies `classifyCandidate` (`statusRollup === 'SUCCESS'`), so without a guard it would re-enter the act path and be re-armed every tick — resetting the 24h clock and burning spawns. Fix:

- `gather()` (`GreenPrAutoMerger.ts:346-390`) gains an explicit **"skip: already-armed" candidate verdict** keyed on `state.episodes[pr.number]?.armedAt` being set. An armed PR is GitHub's and never re-enters the act path; it is excluded from `eligible` (audited `event:'skipped:already-armed'`, included in the Layer-2 snapshot as a `mergeable`-but-armed entry so status still sees it). It re-enters ONLY after reconciliation clears `armedAt` (disarm/head-moved/CLOSED/MERGED).
- **This also fixes the immediate-green/candidate-path non-determinism**: the only way an armed PR leaves the armed state is via reconciliation, so the act path and reconciliation path never race over the same PR within a tick.
- Belt-and-suspenders against a lease move (machine-local episode state may be stale): `gather()` ALSO skips any PR whose live GitHub state shows auto-merge already armed (the GitHub-side-armed-as-source-of-truth check, Blocker 4). **For this `gather()`-time belt to run FREE in the cheap pass, the `listOpenPrs`/`PrSummary` projection itself must carry the derived `autoMergeArmed` flag (from the `gh pr list` `autoMergeRequest` field) — see the projection-widening pin in Blocker 4 (the cheap-pass widening, NOT a per-candidate refetch).**

### Disarm reach — rollback / pause / pool-disarm / per-PR HOLD must un-arm (Blocker 3)

`POST /green-pr-automerge/rollback`, emergency-pause, and pool-disarm stop NEW arming (read at the top of the tick via the dual-latch gate, `GreenPrAutoMerger.ts:274-280`) but do NOT un-arm an already-armed PR. **The HOLD-label/title path does NOT stop GitHub native auto-merge** — GitHub gates auto-merge on required checks and mergeability, NOT on the PR title or labels, so a `[HOLD:]` title or a `hold` label on an already-armed PR is silently ineffective. The operator's kill switch must reach the in-flight armed merges. Fix:

- A **disarm action** (rollback / emergency-pause / pool-disarm) enumerates every `armedAt` episode and calls **`gh pr merge <pr> --disable-auto`** on each (operator-authorized — the operator pressed the kill switch — and audited; this is NOT a "surprising mutation," it is the explicit reach of the documented kill switch). After a confirmed disable, clear `armedAt`/`armedHead` (reconciliation will confirm via the absent `autoMergeRequest`). The aggregate attention line MUST distinguish disarmed-confirmed from disarm-FAILED (see the honest-failure contract below).

**WHERE the disarm executes — in-route, NOT via the latch-gated tick (Blocker 3a — the load-bearing wiring pin).** This is the single most important wiring decision in this spec and it must be implemented EXACTLY as stated, or the disarm silently never runs. The disarm routes only SET a `GuardLatchStore` latch today (`routes.ts`: `POST /green-pr-automerge/rollback` ~`:8080` calls `ctx.guardLatchStore.set('rollback', reason)`; `POST /green-pr-automerge/pool-disarm` ~`:8121` calls `ctx.guardLatchStore.markPoolDisarmed()`). The tick READS that latch at the top and early-returns `{ acted:false, reason: 'disabled:<reason>' }` at `GreenPrAutoMerger.ts:274-280` **BEFORE any candidate gather OR reconciliation runs**. Therefore an enumeration placed inside the tick (the "reconciliation step") would NEVER execute once a disarm latch is live — the latch the operator just set is the very thing that prevents the tick from reaching the disarm code. The fix is to make the disarm a SYNCHRONOUS, in-line call IN THE ROUTE HANDLER, independent of the tick:

  - Add a new public method `GreenPrAutoMerger.disarmAllArmed(reason: string): Promise<{ disarmed: number[]; failed: number[] }>` that loads state, enumerates every `armedAt` episode, calls the `disarmArmedEpisodes()` deps seam per PR, clears `armedAt`/`armedHead` only on a CONFIRMED disable, leaves it set + records a failure on a failed disable, raises the disarm-result attention line, and saves state. It is LEASE-INDEPENDENT (like `applyHold`) — the operator's kill switch must reach the armed merges from wherever the route is served, and `--disable-auto` is idempotent/safe to issue from any holder.
  - In `routes.ts`, the `rollback` handler (after `ctx.guardLatchStore.set('rollback', reason)`) and the `pool-disarm` handler (after `ctx.guardLatchStore.markPoolDisarmed()`) each ALSO `await ctx.greenPrAutoMerger?.disarmAllArmed(reason)` IN-LINE — **null-safe no-op when the merger is absent** (the `GuardLatchStore` can exist when the watcher is null; the `?.` guard preserves that). The latch set (stop NEW arming) and the in-line disarm (un-arm what is already armed) are the two halves of one kill switch.
  - Any future emergency-pause WRITER (the MessageSentinel emergency-stop path that sets the `EMERGENCY_PAUSE_FAMILY` latch — `GuardLatchStore.ts:8,63`) MUST likewise call `disarmAllArmed('emergency-pause')` in-line at the point it sets that latch, for the identical reason. The latch alone only stops new arming.
  - (Rejected alternative — disarm-in-tick: it COULD work only if the disarm enumeration ran BEFORE the `disabled:` early-return AND were explicitly allowed to run under an active latch. That is strictly more fragile — it couples the kill-switch reach to the tick cadence (up to ~10 min late) and to the lease holder, and inverts the early-return's meaning. The in-route path is cleaner, immediate, and lease-independent; it is the pinned design.)

- An **explicit per-PR operator HOLD on an `armedAt` episode** (the `/hold` route, `GreenPrAutoMerger.applyHold`, `GreenPrAutoMerger.ts:241-252`) ALSO calls `gh pr merge <pr> --disable-auto` BEFORE/alongside applying the title marker, and clears `armedAt` only on a confirmed disable. The route still applies the marker (so a later re-arm is blocked by the hold gate), but the `--disable-auto` call is what actually stops the in-flight GitHub merge. The route's honest non-2xx contract is preserved: if `--disable-auto` fails, the route returns a non-2xx detail ("hold marker applied but could not disable the in-flight auto-merge — PR may still merge; disable it on GitHub directly") rather than silently claiming the hold stopped the merge.
- Add a `disarmArmedEpisodes()` seam on the deps (`gh pr merge <pr> --disable-auto` adapter, returns a per-PR confirmed-disabled boolean, audited) so this is unit-testable without gh.

**Honest-failure on the bulk path (Blocker 3b — never a silent strand).** A per-PR `--disable-auto` failure during bulk disarm (rollback / pause / pool-disarm enumeration) must NOT clear `armedAt` and must NOT be folded into the "disarmed OK" line — doing either strands a still-armed PR while telling the operator it was stopped (the inverse of a kill switch). Mirror the per-PR HOLD route's honest-failure contract for the bulk path:
  - On a CONFIRMED disable: clear `armedAt`/`armedHead`; the PR goes into the "disarmed-confirmed" set.
  - On a FAILED disable: leave `armedAt`/`armedHead` set (reconciliation keeps watching it); the PR goes into a DISTINCT "disarm-FAILED" set.
  - `disarmAllArmed` raises ONE aggregate attention surface carrying BOTH sets as distinct lines — a "Disarmed auto-merge on PR #A, #B per rollback/pause — they will NOT merge until re-armed" line for the confirmed set, AND a separate, distinctly-worded "could NOT disable auto-merge on PR #C — disable it on GitHub directly; it may still merge" line for the failed set. The two outcomes are never collapsed into one line.

This corrects Frontloaded Decision (e): disarm DOES reach in-flight armed merges (via an in-route `--disable-auto` enumeration, not the latch-gated tick), and the previously-documented HOLD-label workaround is explicitly retired as non-functional against GitHub native auto-merge.

### Multi-machine — GitHub-side autoMergeRequest is the source of truth (Blocker 4)

`green-pr-automerge.json` is machine-local BY DESIGN (`greenPrAutomergeWiring.ts:14`) and does NOT replicate. On a lease move between arming and merge, the new lease holder never sees the armed episode in its local state — so without a guard it would re-arm (re-arm thrash) or never reconcile (strand). Fix: **make GitHub-side `autoMergeRequest` the source of truth for "already armed," not the local episode.**

- **Two projection-readers surface the GitHub-side armed state, each via a distinct field — pin both (the projection-widening Round-2 fix):**
  - **`listOpenPrs` / `PrSummary` (the CHEAP-PASS widening — the load-bearing one for `gather()`).** `gather()` operates on the `listOpenPrs()` → `PrSummary` projection (`greenPrLogic.ts:11-22`, mapped in `greenPrAutomergeWiring.ts:176-185,246-259`), NOT on `refetchPr`. So the `gather()`-time "skip already-armed regardless of local state" belt (Blocker 2) can only run free if `PrSummary` itself carries the field. **Pin: add `autoMergeRequest` to the `gh pr list --json …` field list (it is a supported `pr list` JSON field) at `greenPrAutomergeWiring.ts:179`, map it into `PrSummary` in `mapPr` (`:246-259`) as an optional `autoMergeArmed: boolean` (derived `!!row.autoMergeRequest`), and add `autoMergeArmed?: boolean` to the `PrSummary` interface (`greenPrLogic.ts:11-22`).** This is the cheapest option — ONE extra field on the single oldest-first list call already made every tick, NO per-candidate N-fold cost — and is the chosen path. `gather()` reads `pr.autoMergeArmed` directly in the cheap pass.
  - **`refetchPr` / `prState` (reconciliation + act-time authoritative pre-arm gate).** Widen the `refetchPr` projection (`greenPrAutomergeWiring.ts:193-206`) to also return `state`, `mergeCommitOid`, and `autoMergeRequest` (the projection is already a `gh pr view --json …` call; widen the field list). Reconciliation reads this per `armedAt` episode. AND the act-time `refetchPr` re-check at `GreenPrAutoMerger.ts:423` (already the immediate-pre-act authority for hold/head/state) gains an `autoMergeRequest`-present check as the AUTHORITATIVE pre-arm gate — if the cheap-pass `PrSummary.autoMergeArmed` was stale-false but the live `refetchPr` shows it armed, the act path refuses to re-arm right before spawning (defense in depth against a race between the list call and the act).
- `gather()` skips any PR with `autoMergeArmed` true on GitHub **regardless of local episode state** (Blocker 2 belt, now reading the widened `PrSummary`). So a machine that just acquired the lease and has NO local `armedAt` episode for PR #N still does NOT re-arm #N — it reads the live armed flag and skips. (Optional, cheap: when it skips a GitHub-armed PR with no local episode, it can synthesize a local `armed` episode from the live state so reconciliation tracks it; if it doesn't, the PR simply merges on GitHub's side and the next-lease-holder's gather sees it gone.)
- The reconciliation step works on whatever `armedAt` episodes the current holder has; the cheap-pass `autoMergeArmed` read is what keeps a holder WITHOUT the episode from double-arming. Episodes are machine-local and do NOT replicate — a lease move is handled via the GitHub-side read, NOT via local episode reconciliation. No new cross-machine state is introduced; the lease/pool model is unchanged.

### The 24h ceiling — armed-overdue, never go blind (Blocker 5)

The earlier draft cleared `armedAt` at the 24h ceiling and stopped watching — that FORGETS a real in-flight auto-merge (under-counts merges; a Close-the-Loop violation: the watcher's view closes but the loop does not). Fix:

- At `armedConfirmCeilingMs` (default `86_400_000` = 24h) with the PR still OPEN + armed, transition the episode to **`armed-overdue`** (a flag on the episode, NOT a state change away from "GitHub owns it"). `armed-overdue`:
  - **KEEPS reconciling** every tick (the reconciliation step still reads it; it can still resolve to MERGED/CLOSED/disarmed).
  - **Re-raises a byte-stable, deduped attention line on a cadence** (e.g. once per `armedOverdueReraiseMs`, default 24h) via `refreshAggregate` — "PR #N has had auto-merge armed >24h and still hasn't merged — CI may be stuck or red; needs a look." Byte-stable text so the existing P17 attention-coalescing dedupes it instead of flooding.
  - **Closes ONLY on MERGED / CLOSED / disarm / operator action.** It is never silently dropped; `armedAt` is never cleared by the ceiling alone.

This keeps the loop open (Close the Loop) AND keeps the no-unbounded-loop discipline (it rides the existing tick; the re-raise is cadence-bounded and deduped, not per-tick spam).

### UNKNOWN / read-failure — fail-open, enumerated

Every reconciliation read failure or `state === UNKNOWN` resolves the SAME way, and it is the SAFE direction:

- **Leave the episode `armed` (or `armed-overdue`) unchanged** — do not clear `armedAt`, do not reap.
- **NO ladder advance** — `armed`/`armed-overdue` never touch `attempts`.
- **NO breaker feed** — a read failure during reconciliation is not a `tick-failed`/`deadline-kill`/`busy-skip` signal.
- **Retry the read next tick.** A transient `gh` failure self-heals; a persistent one keeps the episode visible (and eventually `armed-overdue` surfaces it).

The fail direction is "keep believing GitHub owns the merge until we can read otherwise" — we never give up on a real in-flight merge because of a transient read error, and we never fabricate a merge we can't confirm.

### Non-ladder retry classes (don't exhaust maxAttempts while GitHub is silently armed)

`error:auto-arm-unconfirmed` / `error:auto-confirm-unreadable` (safe-merge armed but couldn't confirm on re-read, `safe-merge.mjs:426-432`) must NOT be folded as `maxAttempts`-consuming merge failures — doing so could exhaust the ladder and give up on a PR that GitHub has SILENTLY armed. Instead:

- Map both to a **non-ladder retry**: do NOT advance `attempts`, do NOT feed the breaker. On the NEXT tick, the reconciliation step + the `autoMergeArmed`-as-source-of-truth read in `gather()` resolve the true state — if GitHub did arm it, `gather()` skips it (armed); if it didn't, the candidate path re-arms cleanly. (`applyOutcome` gains a non-ladder branch for these two outcomes, returning `{ terminal:false, feedsBreaker:false }` and stamping only `lastOutcome`.)
- **Bound it so it can't spin untracked forever (Blocker D — the Round-2 fix).** A non-ladder retry that stamps NOTHING but `lastOutcome` has no bound: if `gather()`'s `autoMergeArmed` belt keeps reading false (a genuinely persistent confirm gap, NOT a real arm) the candidate path re-arms the SAME head every tick with no counter and no surface — an invisible spin. Fix: stamp a lightweight `unconfirmedArmAttempts` counter on the episode KEYED ON HEAD (`{ head: <armed head sha>, count: N }` — reset to 1 whenever the head changes, so a genuine new push starts fresh). The `gather()` `autoMergeArmed` belt remains the PRIMARY authority (a confirmed-armed read on the next tick clears this and parks the PR as `armed`), so this counter only advances when the confirm gap genuinely persists on the SAME head. After `K` consecutive unconfirmed arms on the same head (`unconfirmedArmCeiling`, default 3), surface ONE deduped attention line via `refreshAggregate` — "armed PR #N but cannot confirm it stuck (N attempts) — check GitHub auto-merge state for #N" — instead of re-spawning silently. The counter does NOT feed the failure ladder or the breaker and does NOT block the next attempt (signal, not authority); it exists purely so a persistent confirm gap becomes VISIBLE rather than an invisible tick-loop. `unconfirmedArmAttempts` is a NEW optional `Episode` field (absent → never had a confirm gap), forward-compatible by construction.

### auto-merge-unavailable — terminal-non-ladder (repo setting off)

If arming fails because **auto-merge is disabled on the repo** (a PERMANENT condition), it must NOT exhaust `maxAttempts` over three pointless ticks. **The discriminator the orchestrator keys on must be REAL, not inferred (Round-3 adversarial fix).** Today `classifyMergeFailure` (`safe-merge.mjs:230-236`) collapses BOTH the repo-disabled cause AND a generic transient gh failure into the SAME slug `error:merge-command-failed` → `refused:auto-arm-error:merge-command-failed`; the only "auto-merge disabled?" hint is the human-only `console.error` at `:410`, which is NOT in the `safe-merge-result:` line and `parseResultLine` (`MergeRunner.ts:305-313`) reads only `.result`. So the orchestrator has NO signal to classify this case as written. **This spec therefore pins a small `safe-merge.mjs` change on the `--auto` refusal path (`:405-411`):** when arming fails, match gh stderr against the auto-merge-disabled pattern (case-insensitive `/auto.?merge.*(not\s*(allowed|enabled))|allow\s*auto-?merge/`) and, on a match, emit the DISTINCT structured slug **`refused:auto-arm-unavailable`** (generic failures keep `refused:auto-arm-error:merge-command-failed`). Add `refused:auto-arm-unavailable` to safe-merge's `--capabilities` contract surface (it is a new result classification). Then:

- The orchestrator keys **terminal-non-ladder** ONLY on the explicit `refused:auto-arm-unavailable` slug. Record the refusal, audit `event:'auto-merge-unavailable'`, raise ONE aggregated attention line telling the operator to either enable "Allow auto-merge" OR set `mergeStrategy:'admin'`.
- Do NOT advance the ladder, do NOT auto-retry on `--admin` within the same tick, and do NOT silently flip to the bypass path (signal, not authority — the operator chooses).
- Every OTHER `refused:auto-arm-*` (generic `error:merge-command-failed`, transient, closed, already-merged) stays **normal-refusal (backoff)** so a genuinely transient arming failure self-recovers. Test (j): a stderr "auto-merge not allowed" → `refused:auto-arm-unavailable` → terminal-non-ladder (one attention line, no ladder advance); a generic gh error → `refused:auto-arm-error:*` → normal backoff.

### Exact `armed` episode field-state (pinned)

When `run()` returns `outcome:'armed'`, `applyOutcome`'s `armed` branch produces the episode EXACTLY as:

- `state: 'active'` (NOT `gave-up` — the episode is alive, GitHub owns the merge)
- `attempts`: **UNCHANGED** (arming is not a ladder attempt)
- `nextEligibleAt`: **CLEARED** (no backoff — the PR is armed, not retrying)
- `armedAt`: set to `now`
- `armedHead`: set to the armed head sha (the `headRefOid` we passed to `--match-head-commit`)
- `lastOutcome: 'armed'`
- `lastAttemptAt`: set to `now` (for observability)
- `overdue`: absent until the ceiling flips it (then `overdue: true`, with `overdueSurfacedAt` driving the deduped re-raise cadence)

`armedAt`/`armedHead`/`overdue`/`overdueSurfacedAt`/`unconfirmedArmAttempts` are NEW optional fields on `Episode`. `loadState` already spreads over `freshState()` (`greenPrAutomergeWiring.ts:156-161`), so an old state file without these fields loads cleanly (absent → "not armed"). No migration script; forward-compatible by construction. (`unconfirmedArmAttempts` is the head-keyed confirm-gap counter from "Non-ladder retry classes" / Blocker D; it is stamped only on an `error:auto-arm-unconfirmed`/`error:auto-confirm-unreadable` outcome, never on a clean `armed`.)

### armTimeoutMs — bound the auto-path spawn

`mergeTimeoutMs` (25 min) is vestigial on the auto path: arming is a single API call, so a hung arm spawn would otherwise be allowed to wedge for ~26 min before the deadline-kill, with a ~26-min breaker blast radius. Fix:

- Add `armTimeoutMs` (default ~60_000 = 60s) for the `--auto` spawn deadline; `MergeRunner.run()` uses `armTimeoutMs + mergeKillGraceMs` as the auto-path deadline (vs `mergeTimeoutMs + mergeKillGraceMs` for the admin path).
- **Scope the 25-min `mergeTimeoutMs` invariant (`validateTimeoutInvariant`, B24) to `mergeStrategy:'admin'`.** On the auto path the busy-skip budget vs merge-timeout invariant is computed against `armTimeoutMs`, not `mergeTimeoutMs` — a hung arm trips the breaker in ~minutes, not ~26 min. The admin path keeps the existing invariant verbatim.

### DEFAULTS additions

Add to the `DEFAULTS` block (`GreenPrAutoMerger.ts:157-174`), and mirror in config-defaults migration (Migration Parity):

- `mergeStrategy: 'auto'` (values `auto` | `admin`)
- `armedConfirmCeilingMs: 86_400_000` (24h)
- `armedOverdueReraiseMs: 86_400_000` (24h deduped re-raise cadence)
- `armTimeoutMs: 60_000`
- `unconfirmedArmCeiling: 3` (the K-consecutive-unconfirmed-arms-on-same-head threshold before the Blocker-D attention line)

### Config threading — mergeStrategy + armTimeoutMs reach MergeRunner (M2, pinned)

The new act-path behavior lives in `MergeRunner.run()`, which today HARDCODES `--admin` (`MergeRunner.ts:179`) and is constructed from `MergeRunnerConfig` (which today has NO `mergeStrategy`/`armTimeoutMs`). The four new config fields must thread end-to-end or `run()` can never see them. Pin the full chain:

- **`types.ts`** — the `greenPrAutoMerge?` config interface (`src/core/types.ts:4756-4776`) gains the four new optional fields: `mergeStrategy?: 'auto' | 'admin'`, `armedConfirmCeilingMs?: number`, `armedOverdueReraiseMs?: number`, `armTimeoutMs?: number` (plus `unconfirmedArmCeiling?: number` from Blocker D — five total). These are the on-disk `.instar/config.json` surface.
- **`GreenPrAutoMergerConfig`** (`GreenPrAutoMerger.ts:133-153`) gains the same fields; `DEFAULTS` (`:157-174`) supplies their defaults; the resolved config carries them.
- **`MergeRunnerConfig`** (`MergeRunner.ts:71-81`) gains `mergeStrategy` and `armTimeoutMs` (the two the runner's spawn path actually needs — the ceiling/re-raise/unconfirmed-ceiling fields are consumed by the orchestrator, not the runner).
- **`buildGreenPrDeps`** (`greenPrAutomergeWiring.ts:119-145`) passes `mergeStrategy` + `armTimeoutMs` from `GreenPrWiringOpts` into the `DefaultMergeRunner` config object (and `GreenPrWiringOpts` + the `server.ts` wiring-opts construction at `src/commands/server.ts:~14432` carry them through from the loaded config). `MergeRunner.run()` then selects `--auto` vs `--admin` and the auto-path deadline (`armTimeoutMs + mergeKillGraceMs`) from its config instead of the hardcoded `--admin`.
- **Wiring-integrity test** (Testing Integrity: deps are real, not no-ops) asserts that with `mergeStrategy:'auto'` the CONSTRUCTED `MergeRunner` carries `mergeStrategy:'auto'` + the configured `armTimeoutMs` (i.e. the value survived `config → GreenPrAutoMergerConfig → buildGreenPrDeps → MergeRunnerConfig`), and that the spawned argv carries `--auto` not the previously-hardcoded `--admin` — closing the "config field exists but the runner never reads it" gap.

### Status / observability — armedCount + armed:[] non-optional

`GET /green-pr-automerge` (`routes.ts`, serializes `episodes` + breaker + latch) gains **non-optional** `armedCount` (number) and `armed:[]` (array of `{ pr, armedAt, armedHead, overdue }`) so "armed, waiting on GitHub" is first-class observable (Observable Intelligence — an autonomous in-flight merge must never be invisible). Non-optional means a NUMBER (0) / EMPTY ARRAY when nothing is armed, never `undefined` — a consumer can always read it. Derived from the live episode set on each read.

### How each existing guard is preserved

Every guard is upstream of, or orthogonal to, the act-path swap. The swap touches only HOW the merge is performed (arm vs poll+admin), WHEN it's confirmed (later tick vs synchronously), and adds the disarm reach — not WHETHER the PR is allowed to merge.

- **Dual-latch gate (R9, rollback / emergency-pause / pool-disarm)** — read each tick before any act (`GreenPrAutoMerger.ts:274-280`). Unchanged for NEW arming; AND now drives `gh pr merge --disable-auto` on already-armed episodes (Blocker 3). The reconciliation read is read-only, safe under disarm.
- **Hold markers** — `classifyCandidate` + `holdReasonOf` + the immediate-pre-act `refetchPr` re-check run before arming exactly as before; a held PR is never armed. An explicit operator HOLD on an already-armed PR now also `--disable-auto`s it (Blocker 3).
- **Protected-paths exclusion** — `gather()` routes a protected-path PR to the operator and never adds it to `eligible` (`GreenPrAutoMerger.ts:368-385`). Unchanged; only eligible PRs reach the arm step (VERIFIED CLEAN in round 1).
- **Breaker** — unchanged. `deadline-kill` becomes rare-to-never on the arm path (arming doesn't poll) — correct, that class is now eliminated structurally rather than tripped. Reconciliation read-failures explicitly do NOT feed the breaker (fail-open).
- **Identity check (R4)** — `identityOk()` runs before any act (`GreenPrAutoMerger.ts:394-400`). Unchanged; never arm if the gh login ≠ `expectedGhLogin`.
- **Lease / single-flight (R10/R5)** — ticks (incl. reconciliation) run only on the lease holder; `inFlight` single-flight wraps the act. Unchanged; the single-flight window is now SHORTER (arming returns in seconds), strictly reducing overlap risk.
- **Warm-up + orphan reap** — first tick of a tenure is observe-only; `reapOrphan` reaps a crashed child. Preserved. The durable in-flight record still wraps the (now much shorter) arming spawn; armed-episode reconciliation is the analogous "did the async merge land?" recovery, surviving restart via durable episode state.
- **Head pinning** — safe-merge's `--auto` path passes `--match-head-commit attempt.headRefOid` (`safe-merge.mjs:399`), refusing if the head moved BEFORE arming. The post-arm head-pin RESIDUAL race is the subject of Blocker 1 (see below) — pinned-at-arm-time only, with post-hoc `mergeCommitOid` detection.
- **Contract probe + pre-exec hash pin** — `probeContract()` + the pre-exec re-hash (`MergeRunner.ts:125-163`) run before the arming spawn unchanged. safe-merge's `--capabilities` already advertises `native-auto-merge` + exit code `autoMergeArmed:5` (`safe-merge.mjs:133-144`), so the existing contract-version-2 probe covers the `--auto` path with no contract bump.
- **The local `gh pr merge` dangerous-command guard (#539) does NOT — and is NOT meant to — intercept the watcher's merges, including the new `--disable-auto` disarm.** That guard sits in the Bash-tool PreToolUse hook (it allows `gh pr merge … --auto`, blocks a check-gated `gh pr merge`); it gates ONLY interactive Bash-tool invocations. The watcher (arming, the immediate-green merge, AND the new `disarmArmedEpisodes()` `gh pr merge <pr> --disable-auto`) runs IN-SERVER via `child_process.spawn`/`execFile`, which the Bash-tool hook never sees — so the disarm is never blocked by that guard. This is correct and intended: (1) the watcher's act-time authority is safe-merge's own required-context re-verification + GitHub server-side branch protection, which is STRICTLY STRONGER than the heuristic Bash guard; and (2) `disarmArmedEpisodes()` is an operator-AUTHORIZED kill-switch reach that must not be gated by an interactive-session guard it structurally bypasses anyway. `--disable-auto` removes an armed merge (it can only make a PR LESS likely to merge), so it carries no over-merge risk for the guard to protect against.

### Fallback to the old poll+admin path

Native auto-merge is enabled on `JKHeadley/instar` today, but be defensive:

- **Default: arm path.** `MergeRunner` uses `--auto` when `mergeStrategy:'auto'`.
- **Config lever `monitoring.greenPrAutoMerge.mergeStrategy`** (`auto` default | `admin`). `admin` restores the EXACT current behavior (spawn `--admin`, synchronous poll+confirm, synchronous `confirmedMerged`, `mergeTimeoutMs` invariant). This is the rollback lever AND the escape hatch for a repo without native auto-merge.
- **Automatic detection of an unavailable repo setting (NOT silent flip):** `auto-merge-unavailable` is classified terminal-non-ladder (above) — the watcher tells the operator to enable the setting or set `mergeStrategy:'admin'`; it does NOT silently bypass via `--admin` (signal, not authority).

## Decision points touched

- **Merge-decision authority — UNCHANGED.** The authority for "is this PR allowed to merge" remains the union of: the upstream candidate/hold/protected-path/identity gates, and safe-merge's act-time re-verification of required contexts. Arming native auto-merge is a HANDOFF of the *wait* to GitHub, with GitHub enforcing the SAME required checks (branch protection) that `--admin` would have BYPASSED. **The "stricter than `--admin`" claim, split into its two honest dimensions:**
  - **Required-check enforcement — `--auto` IS stricter (TRUE).** `--admin` bypasses branch-protection required-check enforcement and re-imposes it in script; `--auto` lets GitHub enforce it natively and cannot bypass it. This dimension is a genuine improvement.
  - **Head-pin binding — `--auto` is NOT stricter (the false claim, dropped).** `--match-head-commit` pins only at ARM time; GitHub native auto-merge merges head-at-green and (per GitHub's documented behavior) only auto-cancels auto-merge on pushes by users WITHOUT write permission. So for a WRITE-CAPABLE push (the agent's own automation, a maintainer) AFTER arming, the head-pin does NOT bind through. The earlier "stricter than `--admin` on head-pin" claim is FALSE and is removed; see Blocker 1 for the residual-race treatment.
- **Signal vs. authority (P2).** Arming is a non-brittle handoff, not a new block. Reconciliation is a READ that only updates accounting. The `armed-overdue` ceiling, `merged-at-unexpected-head` detection, and `auto-merge-unavailable` classification are SIGNALS (attention lines), never forced give-ups or new fail-closed gates on the user's path. The disarm reach (`--disable-auto`) is operator-AUTHORIZED (the operator pressed the kill switch / set the HOLD) — it is the explicit reach of an existing authority, not a new autonomous mutation. The only failure direction remains fail-toward-skip / fail-open-on-armed.

## Frontloaded Decisions

(a) **How is `confirmedMerged` now confirmed — later tick vs. a dedicated poller?** A LATER TICK, via the armed-episode reconciliation step that does an independent `gh pr view` (reusing the widened `prState`/`refetchPr` seam). Rationale: survives server restart for free (episode state is durable, `green-pr-automerge.json`), needs no new background timer (P19 — no new unbounded loop; rides the existing ~10-min tick), keeps the B10 invariant exactly. A dedicated separate poller was rejected as a second waiter that would reintroduce the "live process must survive the wait" fragility being removed.

(b) **Arming SUCCEEDS but the PR later fails CI and never merges — what happens?** SAFE, needs no watcher action: GitHub will NOT merge a PR whose required checks are red — armed auto-merge waits; if a check fails it stays unmerged (auto-merge remains armed; GitHub re-attempts if the check is re-run green). Reconciliation sees the PR still OPEN + armed and leaves it. The only backstop is the `armed-overdue` transition (24h) which KEEPS reconciling and re-surfaces a deduped attention line (Blocker 5) — never a forced give-up, never a silent drop. An armed-but-red PR is the correct, safe resting state — GitHub is the gate.

(c) **Rollback.** Three layers: (1) `mergeStrategy:'admin'` restores the exact current poll+admin+synchronous-confirm behavior in one config field. (2) The dual-latch rollback (`POST /green-pr-automerge/rollback`) now ALSO `--disable-auto`s every armed episode (Blocker 3) — the kill switch reaches in-flight merges. (3) The dark/enabled/dryRun flags still gate the whole feature. **Code-level rollback runbook:** the OLD code (`mergeStrategy:'admin'`) does not know about `armedAt` and would redundantly try to `--admin`-merge an already-armed PR. This is a BENIGN race — safe-merge re-reads state and returns `already-merged` (exit 3) if GitHub already merged it, or the `--admin` merge wins the race harmlessly (same squash result). The runbook: when rolling back to `admin`, EITHER (i) disarm all armed episodes first (`POST /green-pr-automerge/rollback` then re-enable on `admin`), OR (ii) accept the benign race (documented above). Either is safe; the spec documents both so the operator isn't surprised.

(d) **Dev-gated/dark or live for armed agents?** This changes the act path of an ALREADY-armed, already-live feature (`monitoring.greenPrAutoMerge` with `expectedGhLogin` set — Echo's dev agent). It is **live behavior for agents that already have auto-merge enabled**, gated by the same `enabled` + dual-latch + `dryRun` switches. Ships behind `mergeStrategy` defaulting to `auto`. On a plain install with no analyzable repo, the watcher is null and this is a no-op. Soak with `dryRun:true` first (logs `would-merge`, never arms) exactly as the original feature soaked.

(e) **Disarm/rollback hits between arm and merge — CORRECTED.** A disarm DOES reach an already-armed PR: rollback / emergency-pause / pool-disarm enumerate every `armedAt` episode and call `gh pr merge <pr> --disable-auto` (operator-authorized, audited), then clear `armedAt` and raise one attention line listing the disarmed PRs (Blocker 3). An explicit per-PR operator HOLD on an armed episode ALSO `--disable-auto`s it. **The HOLD-label/title path does NOT stop GitHub native auto-merge** (GitHub gates on checks/mergeability, not title/labels) — that previously-documented workaround is retired as non-functional. The operator's kill switch is now real for the most dangerous case.

(f) **`--auto` and `--admin` mutual exclusion.** safe-merge refuses the incoherent combo (`safe-merge.mjs:124-128`). `MergeRunner` passes exactly one strategy flag per attempt (driven by `mergeStrategy`), so this is never tripped; the guard is a correct backstop.

(g) **Immediate-green case (checks already passed at arm time).** safe-merge returns `result:'merged'` exit 0 (`safe-merge.mjs:417-420`). `MergeRunner` keeps the synchronous-confirm behavior (it IS a synchronous merge), so a fast PR records `merged`/`confirmedMerged:true` in the SAME tick — no regression for the common already-green case.

(h) **Episode/state schema migration.** `armedAt`/`armedHead`/`overdue`/`overdueSurfacedAt` are NEW optional fields on `Episode`. `loadState` spreads over `freshState()` so an old file loads cleanly (absent → "not armed"). No migration script. Config defaults (`mergeStrategy`, `armedConfirmCeilingMs`, `armedOverdueReraiseMs`, `armTimeoutMs`) get a `migrateConfig()` existence-checked addition (Migration Parity) so deployed agents receive them on update.

(i) **Head-pin residual race — accepted, surfaced (Blocker 1).** See "Head-pin binding" — the design takes the honest-documentation path: `--match-head-commit` pins at arm time only; for a write-capable push after arming the head-pin does NOT bind through; reconciliation compares the PR's FINAL HEAD at merge time (`autoMergeRequest.expectedHeadOid`, else `headRefOid` read at merge time — NOT the squash `mergeCommitOid`, which is a fresh base commit that never equals the head; see the MERGED branch squash-precision note) to `ep.armedHead` and audits `merged-at-unexpected-head` + one attention line on mismatch (still reaps — the merge happened). The residual race's blast radius is bounded (the write-capable-pusher set on this repo is small) and is an ACCEPTED, SURFACED risk, not a silent one.

(j) **Tests.** Tier-1: `merge-runner.test.ts` — the `--auto` argv (asserts spawned args carry `--auto`, not `--admin`, on `mergeStrategy:'auto'`, AND that `mergeStrategy:'admin'` still spawns `--admin`); the `armed` outcome mapping (exit-5 → `outcome:'armed'`, `confirmedMerged:false`, carries `armedHead`, NOT downgraded to error); the immediate-green case (`merged` exit 0 → synchronous confirm); the `armTimeoutMs` deadline on the auto path vs `mergeTimeoutMs` on admin; the non-ladder mapping of `error:auto-arm-unconfirmed`/`error:auto-confirm-unreadable`. `green-pr-automerger.test.ts`:
  - **The B10-rewrite-must-not-corrupt-`armed` test (Blocker B):** an `armed` `MergeRunResult` (`confirmedMerged:false`, `armedHead` set) passes through `act()` UNCHANGED into `applyOutcome`'s `armed` branch (NOT rewritten to `error:merge-unconfirmed`), `act()` returns `true` (`reason:'acted'`), and a companion NEGATIVE assertion forbids the `merged`-mirror misimplementation (no `armed && !confirmedMerged → error`).
  - reconciliation cases: armed→MERGED-with-final-head===`armedHead` reaps + records `merged`; **armed→MERGED-via-clean-squash (the squash `mergeCommitOid` ≠ head) does NOT false-fire `merged-at-unexpected-head` — it compares the PR final head, matches, and records `merged`** (the squash-precision regression guard); armed→MERGED-at-genuinely-unexpected-final-head reaps + audits `merged-at-unexpected-head` + attention; armed→CLOSED reaps; armed→still-OPEN holds; armed→disarmed/head-moved re-evaluates; armed→read-fail/UNKNOWN fail-open no-ladder; armed→ceiling→`armed-overdue` keeps reconciling + deduped re-raise.
  - `gather()` skip-already-armed (local episode AND GitHub `autoMergeArmed` from the widened `PrSummary`).
  - **disarm reach in-route (Blocker 3a):** `disarmAllArmed(reason)` enumerates every `armedAt` episode → `--disable-auto`; on all-confirmed it clears `armedAt` + raises the disarmed-confirmed line; **on a per-PR `--disable-auto` FAILURE it does NOT clear that PR's `armedAt` AND raises the DISTINCT disarm-FAILED line (Blocker 3b honest-failure), never collapsing the two outcomes**; HOLD-on-armed → `--disable-auto` + honest non-2xx on disable failure.
  - **unconfirmed-arm ceiling (Blocker D):** repeated `error:auto-arm-unconfirmed` on the SAME head advances `unconfirmedArmAttempts` (no ladder/breaker), surfaces ONE deduped attention line at `unconfirmedArmCeiling`, and a head change resets the counter to 1.
  - `auto-merge-unavailable` terminal-non-ladder.
  - `greenPrLogic` — the `armed` branch (`terminal:false, feedsBreaker:false`, field-state pinned) and the non-ladder retry branch.
  Tier-2/3: `green-pr-automerge-routes.test.ts` asserts `armedCount`/`armed:[]` serialize (non-optional) and an armed episode is visible in `GET /green-pr-automerge`; the `rollback` + `pool-disarm` routes invoke `disarmAllArmed` IN-LINE (an armed episode is disarmed by the route call, not by a subsequent tick) and are a null-safe no-op when the merger is absent. Wiring-integrity asserts: the widened `listOpenPrs`/`PrSummary` (carries `autoMergeArmed`) and `refetchPr`/`prState` projections and the `disarmArmedEpisodes` seam are real (not no-ops); **and the config-threading chain — with `mergeStrategy:'auto'` + a configured `armTimeoutMs`, the CONSTRUCTED `MergeRunner` carries both (the value survived `config → GreenPrAutoMergerConfig → buildGreenPrDeps → MergeRunnerConfig`), so `run()` is no longer hardcoded to `--admin` (M2).**

(k) **Agent Awareness + Migration Parity.** The CLAUDE.md template's Green-PR Auto-Merge section gains: `mergeStrategy` (auto/admin) and the disarm-reach behavior ("rollback/pause/HOLD now disable in-flight auto-merge; a HOLD label alone does NOT stop GitHub auto-merge"), plus the `armed`/`armed-overdue` states surfaced in `GET /green-pr-automerge`. `migrateConfig()` adds the FIVE new defaults existence-checked (the four DEFAULTS additions + `unconfirmedArmCeiling`).

**The CLAUDE.md migration must REPLACE the old section for already-armed agents — not skip it (M1, the Round-2 Migration-Parity fix).** The existing migration (`PostUpdateMigrator.ts:5341`) content-sniffs `if (!content.includes('/green-pr-automerge'))` and APPENDS the section only when the route string is ABSENT. An agent that ALREADY has the section (Echo — the only agent where this feature is armed, and the exact agent that most needs the new facts) has `/green-pr-automerge` present, so it takes the SKIP branch (`:5357-5359`) and NEVER receives the new disarm-reach fact — most critically "a HOLD label alone does NOT stop GitHub native auto-merge," which is a behavior-changing safety correction. Fix: a dedicated, idempotent content-sniff migration that detects the OLD section by the ABSENCE of a new-content marker WITHIN the existing section (sniff on a substring that exists only in the updated copy — e.g. `mergeStrategy` or `--disable-auto`, neither present in the current section text at `:5343-5352`). When the route string is present BUT the new marker is absent, REPLACE the section body (or append an updated addendum block) with the new disarm-reach + `mergeStrategy` + `armed`-states content; when the new marker is already present, no-op. This follows the Migration Parity Standard's CLAUDE.md path (content-sniffing guards) and the established `migrateClaudeMd` content-sniff-then-replace precedent — an already-armed agent receives the corrected awareness on update, not just brand-new installs.

## Multi-machine posture

`MergeRunner` and `GreenPrAutoMerger` are **per-machine** and multi-machine-correct via the existing lease gate: ticks (incl. the new reconciliation step) run ONLY on the lease holder, and the durable in-flight record + warm-up reap handle a lease move mid-attempt. The async-merge change IMPROVES the multi-machine story: if the lease moves between arming and GitHub completing the merge, the merge still lands (GitHub owns it), and whichever machine next holds the lease runs the reconciliation read and records the confirmed `merged`.

**The machine-local-episode strand (Blocker 4) is resolved by making the GitHub-side armed state the source of truth for "already armed," not the local episode.** Episodes are machine-local and do NOT replicate; a lease move is handled via the GitHub-side read (`gather()` skips any PR whose cheap-pass `PrSummary.autoMergeArmed` — derived from the `gh pr list` `autoMergeRequest` field — is true, regardless of local episode state), NOT via local episode reconciliation. The reconciliation step works on whatever `armedAt` episodes the current holder has; the cheap-pass armed read prevents a holder WITHOUT the episode from double-arming. No new cross-machine state is introduced; no change to the lease/pool model is required.

## Open questions

*(none)*
