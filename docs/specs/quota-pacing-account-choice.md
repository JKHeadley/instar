---
title: "Quota pacing, step 2: account choice reads each limit window correctly"
slug: "quota-pacing-account-choice"
author: "echo"
parent-principle: "Verify the State, Not Its Symbol"
eli16-overview: "quota-pacing-account-choice.eli16.md"
status: "draft"
approved: false
parent-spec: "quota-pacing-forecast.md (step 1 names these three faults as step 2, and adds the `fableUnknown` flag and the pool fan-out helper this step reads); POOL-AWARE-QUOTA-THROTTLE-SPEC.md; swap-continuity-antithrash"
depends-on: "PR #3330 (quota-pacing-forecast, step 1) merged first: `fableUnknown` and the shared bearer pool fan-out helper"
lessons-engaged:
  - "P20 Verify the State, Not Its Symbol: a reading from a window that has already reset is not the account's state; it becomes unmeasured, never 0"
  - "P2 Signal vs Authority: placement already has authority; this changes only the inputs and the ranking it reads, behind a dev-gated switch with a shadow log"
  - "P21 Multi-machine: placement stays per machine (credential locality); the shadow evidence is read pool-wide"
  - "P24 Never Silently Cut the Data: shadow-log repeats are counted, drops are counted"
origin: "Justin, topic 144201, 2026-11-17 23:03 PST: 'Now we need to do the actual work of ongoing token pacing as this topic was created for'. Step order from the token pacing plan, topic 141385, 2026-11-17 10:19 PST."
---

# Quota pacing, step 2: account choice reads each limit window correctly

## Problem

When Instar starts or moves a session it picks a subscription account. Two pickers exist on `main` (`db6455652`):

- **`selectAccount()`** (`src/core/QuotaAwareScheduler.ts`), used by the `pinSessionsToPool: true` spawn resolver (`server.ts` ~25138), the scheduler's reactive swap, `UsageWallRescue` 645 and `codexDeviceLimitWiring` 89. It ranks by a use-before-reset score.
- **`UsageWallRescue.spawnAccount()`** (line 660), the default spawn resolver whenever `pinSessionsToPool` is not `true` (the fleet default). It keeps accounts with a reading under 60 minutes old (`isFresh`) and takes the lowest `bindingUtilization`. It has no notion of reset time at all, so it never drains the account whose room expires first.

The use-before-reset score itself has three faults:

1. **Windows are mixed.** `scoreAccount()` takes room from `bindingUtilization()` (the higher of the 5-hour and weekly readings) and urgency from `soonestResetMs()` (the earliest reset of either window). The soonest reset is almost always the 5-hour one, so urgency says "resets within 5 hours" while the room is weekly room. Example: account A is 40% into its week (resets in 6 days) and 10% into its 5 hours (resets in 30 minutes): room 60, urgency 2, score 120. Account B is 20% into a week that resets in 2 hours: room 80, urgency 0.5, score 40. A wins and B's 80 points expire unused two hours later.
2. **The Fable limit is ignored.** Claude accounts carry a separate Fable weekly window (`AccountQuotaSnapshot.fable`). Nothing in placement reads it, so a Fable session can land on an account whose Fable window is at 98%.
3. **A reading from a window that already reset still counts.** Nothing compares `resetsAt` with now. A past `resetsAt` clamps urgency to the maximum (`hours = 0.25`), and the last cycle's percentage keeps deciding eligibility until a new poll succeeds. The quota reader failed three times in four hours on 2026-11-17, so a stale reading across a reset is a real case.

Which faults bite which caller today:

| Caller | Fault 1 (pairing) | Fault 2 (Fable) | Fault 3 (stale reset) | Change in this step |
|---|---|---|---|---|
| `spawnAccount()` default resolver (UsageWallRescue 660) | n/a: no reset ranking at all | yes | mostly no: `isFresh` (60 min) drops old readings; the gap is a fresh reading whose reset has since passed | ranks by the shared score; Fable and rolled inputs |
| `pinSessionsToPool` resolver (server.ts ~25138) → `selectAccount` | yes | yes | yes: no freshness check | shared score; Fable and rolled inputs |
| `poolHeadroom()` (throttle, server.ts ~17215) | n/a | n/a: model-blind by design (§2) | yes: reports raw `weeklyPercent` | rolled windows reported `null` with `degraded: true` |
| Scheduler reactive swap (QuotaAwareScheduler ~336–370) → `selectAccount` | yes | no model known: out of scope | yes | shared score; rolled input |
| `UsageWallRescue` 645 (wall rescue target) → `selectAccount` | yes | out of scope | yes | shared score; rolled input |
| `codexDeviceLimitWiring` 89 → `selectAccount` | yes | n/a (Codex) | yes | shared score; rolled input |
| `ProactiveSwapMonitor` 434, 442, 574, 662, 1004 | tie-break only | out of scope | `readingValidity` checks `measuredAt` only | rolled window = invalid reading (`invalidReason: 'rolled'`) |
| `SwapAntiThrash` 168 (`readingValidity`), 636 (target) | tie-break only | out of scope | as above | rolled window = invalid reading |
| `UsageWallRescue` 325, 595 (`isKnownWalled`), 673, 721 | n/a | out of scope | `isKnownWalled` already handles a reset | none |

This step does not cover sessions launching under an account other than the one they are tagged with (PR #3390), and does not use the step 1 forecast.

## Goal

- Both pickers rank by one shared use-before-reset score that pairs each weekly window's room with that same window's reset.
- A session known to run a Fable model is judged against the Fable window too, and never loses its account because of the Fable window alone.
- A window whose reset has passed is **unmeasured** until a fresh reading arrives: never counted as 0% used, never as last cycle's number, and it triggers that fresh reading.

## Non-goals

- No change to the 90% soft line, the anti-thrash bounds or the 60-minute `isFresh` window.
- Fable awareness in the swap paths (`ProactiveSwapMonitor`, `SwapAntiThrash`, scheduler swap, wall rescue target): they have no per-session model input today. Known gap, listed in Left behind for a later step.
- No use of the forecast, history or calibration from step 1.
- No dashboard change.

## Design

### 1. One helper reads a window as it stands now

New pure function in `QuotaAwareScheduler.ts`:

```ts
windowNow(w, snap, nowMs, kind: 'fiveHour' | 'weekly', unknown?: boolean)
  → { pct: number | null; resetsAtMs: number | null;
      state: 'measured' | 'idle' | 'rolled' | 'unknown' | 'not-offered' | 'unread-none' | 'unread-old-cycle' }
```

**The poller says how it got each window.** Today an empty `resetsAt` means three different things: the Claude usage endpoint reporting no window running (`resets_at` null, `QuotaPoller.ts:354`), a live Codex read of a window whose reset has passed (`QuotaPoller.ts:789-791` rewrites it to `{ utilizationPct: 0, resetsAt: '' }`), and the same rewrite applied to a reading from the local rollout files, which is history, not a current read. The poller now records `windowBasis: { fiveHour?, sevenDay?, fable?: 'idle-live' | 'rolled-history' }` on the snapshot: `idle-live` when a fresh authenticated read (Claude usage endpoint, or `codex-app-server`) produced the empty reset; `rolled-history` when the rewrite came from rollout files. It also records `windowsListed: string[]` when it parsed the Claude `limits[]` list (`QuotaPoller.ts:377-391`), naming every listed window, not only Fable. An older snapshot without these fields is read by the conservative rule in each state below.

States, checked in this order:

1. **`unread-none`:** there is no snapshot, or the snapshot has no measured or idle window at all.
2. **`not-offered`:** the provider has stated that this window does not apply, never inferred from absence alone. Two sources only: a per-framework table (Codex accounts have no Fable window), and the snapshot's `windowsListed` omitting it. A window missing for any other reason, including on an older snapshot without `windowsListed`, is `unread-none`. `not-offered` does not count against the account's tier and adds nothing to eligibility or ranking.
3. **`unknown`:** the reader marked the value as a placeholder: the `fableUnknown` flag from step 1, or a `resetsAt` that is present but unparseable. A placeholder 0 is never read as room.
4. **`idle`:** `windowBasis` is `idle-live`. The provider's own fresh read says no window is running, so the window is `measured` at its reported percentage (normally 0) with `resetsAtMs: null`. This is a current reading, not an inference from an old timestamp, so an idle account stays in the measured tier, triggers no re-read and cannot open the breaker.
5. **`rolled`:** the window has refilled since the reading and usage since then is unknown: either `resetsAt` is at or before now and less than one window length ago, or `resetsAt` is empty with `windowBasis` `rolled-history` or missing (an older snapshot). `pct: null`, `resetsAtMs: null`; no reset time is projected.
6. **`unread-old-cycle`:** `nowMs - resetsAt` is at least one window length (5 hours or 7 days). The reading belongs to a cycle before the one that just ended.
7. **`measured`:** `resetsAt` is in the future.

**A rolled or old-cycle 5-hour window does not demote the account by itself.** Usage since its reset is unknown, so it is not counted as room; it only does not push an otherwise measured account into the unmeasured tier. This is a judgment about consequence, not a claim of capacity: a 5-hour wall is recoverable within hours and the existing reactive wall rescue moves a session that hits one, while demoting every account whose 5-hour reset fell between polls would make the measured tier empty during exactly the poll outages fault 3 describes. Every rolled, old-cycle or unknown weekly window does demote the account.

**Rolled, unknown and unread windows trigger a re-read** (an `idle` window does not). Decision callers get a `requestRead(accountId)` callback through their existing deps (injected in `server.ts` from `QuotaPoller`). It is fire-and-forget: the decision never waits on it. One shared gate in `QuotaPoller` dedupes across all callers: at most one out-of-cycle read per account per regular poll interval (15 minutes by default, `pollIntervalMs`), backing off to two and then four intervals while reads keep failing, and skipping accounts that are `needs-reauth` or under the Codex device-limit hold. **Breaker** (held in memory, so a restart closes it and the count starts over): after 6 consecutive failed out-of-cycle reads for one account, out-of-cycle reads for it stop and the account carries `rereadBreaker: 'open'` (shown in the shadow rows and `poolHeadroom`'s output); the regular poll continues, and its first success closes the breaker. The account stays in the unmeasured tier while the breaker is open, so the failure is visible, not silent. For Codex accounts the out-of-cycle read uses the live read path, never the rollout files, because an idle account's rollout file only ever repeats the old reading. The state ends when a read lands.

### 2. Which windows bind a placement

`SelectionOptions` gains `model?: string`. Fable is decided with the existing `isFableModel()` (`src/core/IntelligenceRouter.ts:633`) applied to the **concrete model id the spawn will launch** (tier labels such as `capable` or `ultra` are resolved through the model registry first). When the spawn has no explicit model, the resolver uses the configured default (`sessions.model ?? defaultModel`); when that is also unset the model is **unknown**.

- **Known Fable model:** the Fable window is binding (eligibility and ranking).
- **Known non-Fable model:** 5-hour and weekly only, as today.
- **Unknown model:** 5-hour and weekly bind eligibility and score as today; Fable room is a tie-break only (§3), so no account is excluded or outranked on a window that may not apply.

**Fable never empties the pick.** If no account passes eligibility with the Fable window binding, the picker drops the Fable window from eligibility, picks by the rest of the rules, and ranks by Fable room. The shadow row records `fable-no-room`. A Fable-only reason therefore never returns `null` (which would launch the session untagged on the default login).

**Never-loop invariant.** `poolHeadroom()` stays model-blind and counts unmeasured-tier accounts as placeable (with `degraded: true`), exactly as `selectAccount` falls back to that tier. Because the Fable window can only reorder accounts or fall back, never empty the result, `placeable ⟺ selectAccount(...) !== null` holds for every model. (`spawnAccount()` keeps its own `isFresh` filter and is outside this invariant, as it is today.) A unit test asserts it over randomized pools with rolled, unknown and Fable windows and all three model cases.

`bindingUtilization(snap, at?: { nowMs: number; model?: string })` returns the highest **measured** `pct` over the binding windows. With `at` omitted it behaves exactly as today, so display callers are unchanged. With `at`, a binding window in any state other than `measured` contributes nothing; an account whose every binding window is unmeasured has binding `null` (see the tiers below).

### 3. The shared score and its tiers

```
binding weekly windows = sevenDay, plus fable when the model is known Fable
measured = those in state 'measured'
room     = min over measured of (100 - pct_w)          // a Fable session burns both
deadline = soonest resetsAt among measured
score    = room / max(0.25, hoursUntil(deadline))
```

Room is the least room across the binding weekly windows, because a session uses all of them; urgency comes from the soonest of their resets, because that is when room is first lost. Taking the minimum of per-window ratios instead would let the window that resets latest set the urgency, which is fault 1 again.

- The 5-hour window is eligibility only (through the soft line); its room refills within hours and is never lost.
- No measured weekly window: today's no-reading rule, room 100 at urgency `0.0001`. An `idle` weekly window counts as measured room with no deadline, so it also ranks at urgency `0.0001` on its room.
- Why least room over the soonest reset is right for a Fable session: it cannot burn more than its smallest weekly room before that window's reset, and the soonest reset is when unused room is first lost.
- Unknown model: ties on score break by Fable room (more first), then by account id.
- The ratio is kept rather than a plain sort by deadline, because the existing score already weighs room against time and the A/B example shows the ratio picks correctly once the windows are paired.

**Tiers.** Accounts are ranked in two tiers, and the second is used only when the first is empty:

1. **Measured:** every binding window is `measured` and under the soft line.
2. **Unmeasured:** at least one binding window is `rolled`, `unknown`, `unread-none` or `unread-old-cycle` (subject to the 5-hour exception in §1), and every measured binding window is under the soft line. Ranked by score over whatever is measured. `not-offered` windows never demote an account.

So an account that just reset is never preferred over a real reading, and is still usable when nothing measured qualifies (the reactive rescue then catches a mistake, as it does for a freshly enrolled account today). Ties break by account id.

**Both pickers.** `spawnAccount()` keeps its own filters (`usableAccounts`, `isFresh`, `pinSessionsToPool: false` default-login exclusion) and replaces "lowest `bindingUtilization`" with this tiered score. `selectAccount()` uses the same function. One implementation, so the two cannot drift.

**`poolHeadroom()`.** A rolled, unknown or unread window is reported as `null` (never the raw old percentage), an `idle` window as its reported percentage, and a best account from the unmeasured tier sets `degraded: true`, so the throttle applies its existing bounded degraded cap.

**Swap paths.** The swap paths stay model-blind: Fable binds only at placement. `readingValidity` (SwapAntiThrash 168) treats a rolled, unknown or unread binding window as an invalid reading with its own `invalidReason` (`rolled`, `unknown`, `unread`), alongside the existing stale reason. An `idle` window is a valid reading. A just-reset account is neither a proactive swap source nor target until a post-reset reading lands. This applies the existing anti-thrash bound 0 (an unmeasured reading never drives a proactive move). For the whole-pool blindness check (SwapAntiThrash ~499), a rolled reading counts as blind only once its out-of-cycle read has failed twice (about two poll intervals), so an ordinary pool-wide reset does not raise `swap-antithrash:measurement-blind`.

### 4. Model reaches the spawn resolver

The resolver types in `SessionManager` widen to `(ctx?: { model?: string }) => …`. The three call sites (about 4960, 5442 and 8345 on `db6455652`) pass the spawn's resolved model when they have one. `UsageWallRescue.spawnAccount(ctx?)` and the `pinSessionsToPool` resolver in `server.ts` forward it. `configureClaudeReviewerLogin` passes no model (unknown). The shadow row records `modelSource: 'explicit' | 'config-default' | 'unknown'`.

### 5. Switch and shadow log

- **Switch:** `subscriptionPool.pacing.windowAwareChoice`, resolved through `resolveDevAgentGate()` (`src/core/devAgentGate.ts`; on for development agents without the key, off for the fleet, an explicit value always wins). Registered in `src/core/devGatedFeatures.ts` with the justification "placement inputs change; shadow evidence before fleet", and a ladder in `src/data/feature-ladders.json` (rungs `test-agent-live`, `dev-agent-live`, `fleet`) whose metrics read the shadow log. A wiring test fails if either entry is missing.
- **Off:** the new code is not run at all; every picker returns exactly today's result over a fixture pool (test). No shadow rows on the fleet.
- **On:** the new rule decides. The old rule is computed alongside, inside a `try` whose failure is counted and can never change the result.
- **Shadow rows**, `logs/account-choice-shadow.jsonl`, written off the decision path (buffered, flushed by timer; rows still in the buffer at an unclean stop are lost and the next flush records `lostOnRestart: unknown`). Two kinds:
  - **Execution rows:** one per executed spawn placement, with `decisionId` and `sessionName`, whether or not the picks differ. These are what the graduation review joins to the wall and swap logs.
  - **Evaluation rows:** throttle and monitor evaluations, written only when the tuple `(caller, framework, modelClass, oldPick, newPick, reasons)` changes; while it repeats, the open row's `repeats` and `lastTs` are updated and its `accounts` snapshot is refreshed when the row closes.
  - Fields: `{ kind, ts, lastTs?, repeats?, decisionId?, sessionName?, machineId, caller, framework, model (matching [\w.-]{1,64}, else 'other'), modelSource, policy: 'new', executed, oldPick, newPick, reasons: ('window-pairing' | 'fable' | 'fable-no-room' | 'rolled-window' | 'unknown-window' | 'tier')[], accounts: [{ id, fiveHour, sevenDay, fable, states }] }`. Account ids are pool ids, never emails or tokens.
  - Caps per machine per day: 2,000 execution rows and 500 evaluation rows, each with a `dropped` count carried in the next row of its kind and reported by the pool read. Derivation: execution rows are bounded by spawns; the build measures the Studio's spawn count for 2026-11-17 (the busiest day on record, from the session log) and the cap must be at least 5 times that figure, raised in the same change if it is not; evaluation rows are deduped by tuple, so they grow with distinct situations, not ticks. The review reads `dropped` and treats any day with drops as partial evidence for that machine. The writer trims its own file: at each day roll it rewrites the file atomically keeping the last 30 days, which covers the review's window of two weekly resets per account (14 days plus accounts that reset late in the week); the review reads the rows before they age out, and the graduation entry records the date range it read. The existing `SessionMaintenanceRunner.rotateJsonlFiles()` list only covers state-directory files, so it is not used.
- **Reads:** `GET /quota-pacing/account-choice?scope=pool` returns one **per-machine, per-day summary** (counts by caller, reason and tier, executed picks by account, `dropped` counts, breaker openings), small enough to stay well under the fan-out's 256 KiB per-peer limit (`MAX_PEER_BYTES` in PR #3330) for 30 days of data. Raw rows are paged: `?scope=local&since=&until=&limit=` (limit at most 500, response carries a `next` cursor), and `?machine=<id>&since=&until=&limit=&cursor=` reads another machine's raw pages through the same bearer fan-out, one machine per call, within the existing 12-builds-a-minute limiter. A peer that does not answer is named, never dropped. Bearer-only, with the same `scope` handling as `GET /quota-pacing`. `503 window-aware-choice-off` when the switch is off on this machine. Registered in the CapabilityIndex, with an awareness entry `src/data/awareness/account-choice-shadow.md` (Agent Awareness Standard).

## Maturation plan

- **test-agent-live:** before merge, a throwaway agent (one-machine route) boots the real server with a seeded pool: A and B from the example, a Fable-heavy account, one read at 92% one minute before its reset, and one whose poll has failed across several resets. Spawns through `POST /sessions/spawn` in both `pinSessionsToPool` modes: a non-Fable session lands on B; a Fable session skips the Fable-heavy account; with every Fable window full it still gets an account (`fable-no-room`); the just-reset account is chosen only after B and A are removed, triggers one re-poll, and is never a proactive swap target; the long-failing account reads `unread-old-cycle`; an idle Codex account whose rollout reading is a week old becomes measured after one live read; an idle Claude account and an idle Codex account (live read) stay in the measured tier with no re-read and no breaker; a Codex rollout-file placeholder is `rolled` and triggers one live read; a pool where every account just reset raises no measurement-blind alert. The shadow route returns one execution row per spawn and one evaluation row per changed situation, with the right reasons and repeat counts.
- **dev-agent-live:** on from merge on Echo's machines through the dev gate.
- **fleet:** default-on for every agent is the last rung, after the review.
- **graduation criterion:** a review on the maturation board, filed at merge, reads (a) the shadow rows pool-wide: how often each reason changed a choice; (b) for the executed picks, walls and swaps afterwards, from the existing wall and swap logs by `sessionName`; (c) the outcome this project cares about: weekly room left unused at each reset across the pool, from step 1's cycle-end rows, compared with the weeks before the switch. The old rule's picks are not executed, so the review never claims what they would have hit; it may note the old pick's next fresh reading as a labelled proxy. It promotes on judgment from that evidence.
- **dark-window:** the evidence minimum is two weekly resets for every Claude account, however long that takes. Separately, if the review has not happened 4 weeks after merge, the board raises the feature as dark too long; that is a reminder, not a promotion trigger.

## Safety and side effects

- **Authority:** unchanged in kind. Placement already decides where a session runs; this changes what it reads and how it ranks. With the switch off nothing changes.
- **Unmeasured is never room:** rolled, unknown and unread windows rank below every measured account and are reported `null`/`degraded`, so the agent never certifies capacity nobody has read.
- **New swap behaviour:** only a refusal (`rolled` invalid reading). No new swap trigger is added: Fable stays out of the swap paths.
- **Fable classification wrong:** a non-Fable model read as Fable can only reorder or fall back (`fable-no-room`), never deny an account; a Fable model read as unknown gets ranking-only Fable awareness.
- **Re-poll load:** at most one extra read per account per 15 minutes, only after a reset.
- **Cost:** a few comparisons per decision; the shadow log is buffered, deduped and capped.

## Tests (three tiers)

- **Unit, `windowNow`:** every state in order; reset exactly now; reset hours ago → rolled; the same snapshot advanced across several cycles → unread; `fableUnknown` and an unparseable `resetsAt` → unknown; the Codex `{0, ''}` from a live read → idle, from rollout files → rolled; the Claude null `resets_at` → idle; an older snapshot without `windowBasis` → rolled; a window the provider's parsed list omits → not-offered, a window missing after a failed or partial read → unread, a Codex Fable window → not-offered; a rolled 5-hour window under the soft line does not demote, over it does.
- **Unit, score and tiers:** the A/B example picks B; B plus an untouched Fable window that resets in 6 days still beats A for a Fable session; 5-hour window never sets urgency; Fable known/non-Fable/unknown cases; min across weekly windows; measured tier always beats unmeasured; unmeasured used only when measured is empty; `fable-no-room` fallback never returns null; no-weekly-reading account keeps today's score; both pickers call the same function; switch off gives today's results for both pickers over a fixture pool; never-loop invariant over randomized pools.
- **Unit, swap validity:** a rolled window makes the reading invalid with `invalidReason: 'rolled'`; a post-reset reading clears it; blindness counts a rolled reading only after two failed out-of-cycle reads.
- **Unit, re-read gate:** one out-of-cycle read per account per poll interval across all callers; backoff to two and four intervals on failure; breaker opens after 6 failures and the next regular-poll success closes it; needs-reauth and device-limit-held accounts skipped; Codex uses the live read; the decision returns before the read resolves.
- **Unit, shadow log:** one execution row per spawn with its session name; evaluation row on tuple change, `repeats` on repeat, snapshot refreshed on close; reasons array; model sanitizing; both daily caps with dropped counts; 30-day self-trim; a throwing old-rule computation leaves the result unchanged.
- **Wiring:** every caller in the Problem table passes `nowMs` (and the model where it has one); the SessionManager resolver receives the model at all three call sites; the dev-gate resolution; the `devGatedFeatures` and ladder entries exist.
- **Unit, poller:** `windowBasis` written for each source (Claude endpoint null reset, Codex live, Codex rollout); `windowsListed` lists every parsed limit.
- **Integration:** `tests/integration/subscription-pin-sessions.test.ts` extended for both pinning modes, on and off; `GET /quota-pacing/account-choice` pool summary under the per-peer byte limit for 30 days of capped rows, local and per-machine paging with cursor, one peer down, 503 when off.
- **E2E (feature is alive):** the production init path in `server.ts` wires the resolver with model context and the route answers 200 on a development agent with no config key.

## Measure of success

- Correctness is the unit tests.
- Usefulness, on Echo after two weekly resets per account: the shadow rows show how often each fault changed a choice, executed picks hit no more walls than before the switch, and less weekly room is left unused at resets (step 1's cycle-end rows).

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A window whose `resetsAt` has passed is unmeasured (`rolled` within one window length, `unread` beyond it) until a fresh read | invariant; basis: external-constraint; evidence: the provider's `resetsAt` is its own statement that the window refilled, so last cycle's percentage no longer describes it, and usage since is unread | Unknown, not zero. No reset time is projected. |
| `windowBasis`: an empty reset from a fresh authenticated read is `idle` (measured); from rollout history or an older snapshot is `rolled`; an unparseable reset and `fableUnknown` are `unknown` | invariant; basis: external-constraint; evidence: the poller's own code paths (QuotaPoller.ts:354, 789-791, step 1 §1) are the record of which reads are current provider statements and which are placeholders or history | |
| A rolled 5-hour window does not demote the account by itself | judgment-candidate; floor: the window is never counted as room, the account still needs its weekly windows measured, and a 5-hour wall is caught by the existing reactive rescue; arbiter: the graduation review, from walls on accounts placed with a rolled 5-hour window (the shadow row records the state) | Avoids an empty measured tier during poll outages. |
| `not-offered` only from a per-framework table or the provider's parsed `limits[]` list | invariant; basis: external-constraint; evidence: the provider's own list of limits for the account is the only statement that a window does not apply; absence after a failed or partial read is not such a statement | |
| Measured tier before unmeasured tier | invariant; basis: enumerable-domain; evidence: two states, read and unread; an unread account preferred over a read one is the certifying-unverified-capacity failure | Unmeasured is still usable when nothing measured qualifies. The existing 90% soft line, 60-minute `isFresh` window and 0.25-hour clamp are unchanged by this step and keep their existing classifications. |
| Weekly windows set urgency; the 5-hour window is eligibility only | invariant; basis: enumerable-domain; evidence: the 5-hour window refills within hours, so its unused room is never lost; only weekly room expires unused | Fixes a pairing error. |
| Fable window binds a known Fable model; ranking-only for unknown; never empties the pick | judgment-candidate; floor: it can only reorder accounts or fall back to today's eligibility, never return null; arbiter: the graduation review from `fable` and `fable-no-room` rows | The provider scopes that window to the Fable model; the model is not always known. |
| Rolled, unknown or unread reading invalid for proactive swaps | invariant; basis: external-constraint; evidence: inherited from the existing anti-thrash bound 0 (swap-continuity-antithrash §3.3): an unmeasured reading never drives a proactive move | Refusal only. |
| A rolled reading counts toward whole-pool blindness only after two failed out-of-cycle reads | judgment-candidate; floor: it only delays the blindness alert by about two poll intervals, and a persistent failure still raises it; arbiter: the graduation review from alert and re-read logs | Keeps an ordinary reset from reading as blindness. |
| 0.25-hour urgency clamp and 0.0001 no-reset urgency (both existing) | judgment-candidate; floor: they only cap or lower urgency, never change eligibility; arbiter: the graduation review | Kept from today. |
| Out-of-cycle read at most once per account per poll interval, backing off to two and four intervals, breaker open after 6 consecutive failures | judgment-candidate; floor: the regular poll still runs and closes the breaker on success; this only adds early reads; an open breaker is reported, never silent; arbiter: the graduation review from read counts and breaker openings; evidence: one interval matches the poller's own cadence, so out-of-cycle reads at most double the provider calls for an account | Bounded per P19. |
| Shadow caps (2,000 execution and 500 evaluation rows a day per machine; 30-day keep) | judgment-candidate; floor: repeats and drops are counted and reported by the pool read, never silently cut; arbiter: the graduation review | Storage bound with disclosure. |

## Multi-machine posture

- **Placement decisions:** per machine. machine-local-justification: physical-credential-locality — a pick selects a login whose credential home lives on this machine's disk, and each machine places only its own spawns.
- **Switch:** per machine. machine-local-justification: physical-credential-locality — the switch governs only this machine's placement decisions, which are machine-local for the credential reason above; a switch that differs between machines is harmless because each machine places only its own spawns.
- **Shadow log:** unified, proxied on read. Each machine writes the decisions it made; `GET /quota-pacing/account-choice?scope=pool` merges every machine through step 1's bearer fan-out and names machines that did not answer. Excluded from git-sync like the other `logs/` files because it is merged live.
- **Pool records:** unchanged; each machine reads the pool records it already has.
- No notices are sent and no URLs are generated.

## Frontloaded Decisions

- `spawnAccount()` moves to the shared tiered score behind the same switch (it keeps its freshness and usability filters). Otherwise the fix would miss the fleet's default spawn path.
- A rolled, unknown or unread window is unmeasured, never 0 and never last cycle's number, and triggers a deduped, backed-off, fire-and-forget re-read (live read for Codex).
- The score is least room across the binding weekly windows over the soonest of their resets.
- The shadow log trims itself; the existing rotation list is not extended.
- The poller records `windowBasis` and `windowsListed`, so idle accounts are measured, not unknown.
- The pool read serves summaries; raw rows are paged per machine.
- Fable is decided with `isFableModel()` on the concrete launch model, falling back to the configured default, then unknown; a Fable-only reason never empties the pick.
- Fable awareness in the swap paths is out of scope for this step.
- The shadow evidence is read pool-wide through step 1's fan-out; step 2 merges after PR #3330.
- The old signature of `bindingUtilization` stays valid for display callers.
- Dev-gated through `resolveDevAgentGate`; no config migration (the key has never existed).

## Left behind

- Fable awareness for swaps of running sessions (no per-session model input in the swap paths today).
- Mid-session `/model` changes are not seen by placement (placement happens at spawn).
- Session records store a `model` (SessionManager ~4859), so Fable awareness in the swap paths is a cheap later step.

## Open questions

*(none)*
