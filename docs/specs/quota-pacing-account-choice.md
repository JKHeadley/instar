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
windowNow(w, nowMs, kind: 'fiveHour' | 'weekly', unknown?: boolean)
  → { pct: number | null; resetsAtMs: number | null; state: 'measured' | 'rolled' | 'unknown' | 'absent' }
```

- No window: `absent`.
- `unknown` true (the `fableUnknown` flag from step 1, set when the provider returned no Fable percentage): `{ pct: null, state: 'unknown' }`. A placeholder 0 is never read as room.
- Unparseable or missing `resetsAt` with a percentage: `measured`, `resetsAtMs: null`. It counts for eligibility; for urgency see §3.
- `resetsAt` in the future: `measured`, as read.
- `resetsAt` at or before now: `rolled`, `pct: null`. The window has refilled since the reading, and usage since then is unknown. For a weekly window, `resetsAtMs` is projected one week past the old reset (once, not repeatedly). For a 5-hour window `resetsAtMs` is `null`: Claude's 5-hour window starts on first use, so no reset time can be projected.
- A reading whose `measuredAt` is more than one window length before its `resetsAt` (it belongs to an earlier cycle than the one that just ended) is treated as `absent`, not `rolled`.

**Rolled triggers a re-read.** The first time a decision caller sees an account with a rolled window, it asks `QuotaPoller.pollAccount()` for that account, at most once per account per 15 minutes (the existing poll path; deduped by account id). The rolled state ends when that read lands.

### 2. Which windows bind a placement

`SelectionOptions` gains `model?: string`. Fable is decided with the existing `isFableModel()` (`src/core/IntelligenceRouter.ts:633`) applied to the **concrete model id the spawn will launch** (tier labels such as `capable` or `ultra` are resolved through the model registry first). When the spawn has no explicit model, the resolver uses the configured default (`sessions.model ?? defaultModel`); when that is also unset the model is **unknown**.

- **Known Fable model:** the Fable window is binding (eligibility and ranking).
- **Known non-Fable model:** 5-hour and weekly only, as today.
- **Unknown model:** 5-hour and weekly bind eligibility as today; the Fable window is used only in ranking (§3), so an account with Fable room is preferred but no account is excluded on a window that may not apply.

**Fable never empties the pick.** If no account passes eligibility with the Fable window binding, the picker drops the Fable window from eligibility, picks by the rest of the rules, and ranks by Fable room. The shadow row records `fable-no-room`. A Fable-only reason therefore never returns `null` (which would launch the session untagged on the default login).

**Never-loop invariant.** `poolHeadroom()` stays model-blind. Because the Fable window can only reorder accounts or fall back, never empty the result, `placeable ⟺ selectAccount(...) !== null` holds for every model. A unit test asserts it over randomized pools with rolled, unknown and Fable windows and all three model cases.

`bindingUtilization(snap, at?: { nowMs: number; model?: string })` returns the highest **measured** `pct` over the binding windows. With `at` omitted it behaves exactly as today, so display callers are unchanged. With `at`, a binding window that is rolled, unknown or absent contributes nothing; an account whose every binding window is unmeasured has binding `null` (see the tiers below).

### 3. The shared score and its tiers

```
weekly windows = sevenDay, plus fable when the model is Fable or unknown
for each MEASURED weekly window w with a resetsAt in the future:
    score_w = (100 - pct_w) / max(0.25, hoursToReset_w)
score = min over those windows of score_w
```

- The 5-hour window is eligibility only (through the soft line); its room refills within hours and is never lost.
- A measured weekly window with no usable `resetsAt` gets the existing low urgency (`0.0001`), so it ranks on room alone below accounts with a known reset.
- An account with no measured weekly window keeps today's no-reading rule: room 100 at urgency `0.0001`.

**Tiers.** Accounts are ranked in two tiers, and the second is used only when the first is empty:

1. **Measured:** every binding window is `measured` and under the soft line.
2. **Unmeasured:** at least one binding window is `rolled`, `unknown` or `absent`, and every measured binding window is under the soft line. Ranked by score over whatever is measured.

So an account that just reset is never preferred over a real reading, and is still usable when nothing measured qualifies (the reactive rescue then catches a mistake, as it does for a freshly enrolled account today). Ties break by account id.

**Both pickers.** `spawnAccount()` keeps its own filters (`usableAccounts`, `isFresh`, `pinSessionsToPool: false` default-login exclusion) and replaces "lowest `bindingUtilization`" with this tiered score. `selectAccount()` uses the same function. One implementation, so the two cannot drift.

**`poolHeadroom()`.** A rolled or unknown window is reported as `null` (never the raw old percentage), and a best account from the unmeasured tier sets `degraded: true`, so the throttle applies its existing bounded degraded cap.

**Swap paths.** `readingValidity` (SwapAntiThrash 168) treats any rolled binding window as an invalid reading with `invalidReason: 'rolled'`. A just-reset account is neither a proactive swap source nor target until a post-reset reading lands. This matches anti-thrash bound 0 (an unmeasured reading never drives a proactive move) and prevents a swap onto an account whose next reading says 92% again.

### 4. Model reaches the spawn resolver

The resolver types in `SessionManager` widen to `(ctx?: { model?: string }) => …`. The three call sites (about 4960, 5442 and 8345 on `db6455652`) pass the spawn's resolved model when they have one. `UsageWallRescue.spawnAccount(ctx?)` and the `pinSessionsToPool` resolver in `server.ts` forward it. `configureClaudeReviewerLogin` passes no model (unknown). The shadow row records `modelSource: 'explicit' | 'config-default' | 'unknown'`.

### 5. Switch and shadow log

- **Switch:** `subscriptionPool.pacing.windowAwareChoice`, resolved through `resolveDevAgentGate()` (`src/core/devAgentGate.ts`; on for development agents without the key, off for the fleet, an explicit value always wins). Registered in `src/core/devGatedFeatures.ts` with the justification "placement inputs change; shadow evidence before fleet", and a ladder in `src/data/feature-ladders.json` (rungs `test-agent-live`, `dev-agent-live`, `fleet`) whose metrics read the shadow log. A wiring test fails if either entry is missing.
- **Off:** the new code is not run at all; every picker returns exactly today's result over a fixture pool (test). No shadow rows on the fleet.
- **On:** the new rule decides. The old rule is computed alongside, inside a `try` whose failure is counted and can never change the result.
- **Shadow rows**, `logs/account-choice-shadow.jsonl`, written off the decision path (buffered, flushed by timer). A row is written when the tuple `(caller, framework, modelClass, oldPick, newPick, reasons)` changes; while it repeats, the open row's `repeats` count and `lastTs` are updated. Fields: `{ ts, lastTs, repeats, machineId, caller, framework, model (matching [\w.-]{1,64}, else 'other'), modelSource, policy: 'new', executed, oldPick, newPick, reasons: ('window-pairing' | 'fable' | 'fable-no-room' | 'rolled-window' | 'unknown-window' | 'tier')[], sessionName?, accounts: [{ id, fiveHour, sevenDay, fable, states }] }`. Account ids are pool ids, never emails or tokens. Cap 500 rows a day per machine with a `dropped` count in the next row; rotated by the existing `logs/` rotation (`LogRotator`) like the other jsonl logs.
- **Pool read:** `GET /quota-pacing/account-choice?scope=pool|local&since=` returns the rows of every machine through step 1's shared bearer pool fan-out helper, naming any machine that did not answer. Bearer-only. `503 window-aware-choice-off` when the switch is off on this machine.

## Maturation plan

- **test-agent-live:** before merge, a throwaway agent (one-machine route) boots the real server with a seeded pool: A and B from the example, a Fable-heavy account, one read at 92% one minute before its reset, and one whose poll has failed across several resets. Spawns through `POST /sessions/spawn` in both `pinSessionsToPool` modes: a non-Fable session lands on B; a Fable session skips the Fable-heavy account; with every Fable window full it still gets an account (`fable-no-room`); the just-reset account is chosen only after B and A are removed, triggers one re-poll, and is never a proactive swap target; the long-failing account reads `absent`. The shadow route returns one row per changed decision with the right reasons and repeat counts.
- **dev-agent-live:** on from merge on Echo's machines through the dev gate.
- **fleet:** default-on for every agent is the last rung, after the review.
- **graduation criterion:** a review on the maturation board, filed at merge, reads (a) the shadow rows pool-wide: how often each reason changed a choice; (b) for the executed picks, walls and swaps afterwards, from the existing wall and swap logs by `sessionName`; (c) the outcome this project cares about: weekly room left unused at each reset across the pool, from step 1's cycle-end rows, compared with the weeks before the switch. The old rule's picks are not executed, so the review never claims what they would have hit; it may note the old pick's next fresh reading as a labelled proxy. It promotes on judgment from that evidence.
- **dark-window:** at least 3 weeks on Echo (two weekly resets for every Claude account plus slack). A minimum amount of evidence, not a timer: past it the board raises the feature as dark too long.

## Safety and side effects

- **Authority:** unchanged in kind. Placement already decides where a session runs; this changes what it reads and how it ranks. With the switch off nothing changes.
- **Unmeasured is never room:** rolled, unknown and absent windows rank below every measured account and are reported `null`/`degraded`, so the agent never certifies capacity nobody has read.
- **New swap behaviour:** only a refusal (`rolled` invalid reading). No new swap trigger is added: Fable stays out of the swap paths.
- **Fable classification wrong:** a non-Fable model read as Fable can only reorder or fall back (`fable-no-room`), never deny an account; a Fable model read as unknown gets ranking-only Fable awareness.
- **Re-poll load:** at most one extra read per account per 15 minutes, only after a reset.
- **Cost:** a few comparisons per decision; the shadow log is buffered, deduped and capped.

## Tests (three tiers)

- **Unit, `windowNow`:** future reset; reset exactly now; reset hours ago (weekly projected once, 5-hour `null`); reading from an earlier cycle → absent; `fableUnknown` → unknown; missing and unparseable `resetsAt`.
- **Unit, score and tiers:** the A/B example picks B; 5-hour window never sets urgency; Fable known/non-Fable/unknown cases; min across weekly windows; measured tier always beats unmeasured; unmeasured used only when measured is empty; `fable-no-room` fallback never returns null; no-weekly-reading account keeps today's score; both pickers call the same function; switch off gives today's results for both pickers over a fixture pool; never-loop invariant over randomized pools.
- **Unit, swap validity:** a rolled window makes the reading invalid with `invalidReason: 'rolled'`; a post-reset reading clears it.
- **Unit, re-poll:** one `pollAccount` call per account per 15 minutes after a roll.
- **Unit, shadow log:** row on tuple change, `repeats` on repeat, reasons array, model sanitizing, daily cap with dropped count, a throwing old-rule computation leaves the result unchanged.
- **Wiring:** every caller in the Problem table passes `nowMs` (and the model where it has one); the SessionManager resolver receives the model at all three call sites; the dev-gate resolution; the `devGatedFeatures` and ladder entries exist.
- **Integration:** `tests/integration/subscription-pin-sessions.test.ts` extended for both pinning modes, on and off; `GET /quota-pacing/account-choice` local and pool, one peer down, 503 when off.
- **E2E (feature is alive):** the production init path in `server.ts` wires the resolver with model context and the route answers 200 on a development agent with no config key.

## Measure of success

- Correctness is the unit tests.
- Usefulness, on Echo after two weekly resets per account: the shadow rows show how often each fault changed a choice, executed picks hit no more walls than before the switch, and less weekly room is left unused at resets (step 1's cycle-end rows).

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A window whose `resetsAt` has passed is unmeasured (`rolled`, pct null) until a fresh read | invariant; basis: external-constraint; evidence: the provider's `resetsAt` is its own statement that the window refilled, so last cycle's percentage no longer describes it, and usage since is unread | Unknown, not zero: the conservative reading of the provider's data. |
| Projecting a rolled weekly window's next reset one week on | judgment-candidate; floor: it only orders accounts inside the unmeasured tier, which ranks below every measured account; arbiter: the graduation review, with step 1's fixed-window check per provider | 5-hour windows are never projected. |
| Measured tier before unmeasured tier | invariant; basis: enumerable-domain; evidence: two states, read and unread; an unread account preferred over a read one is the certifying-unverified-capacity failure | Unmeasured is still usable when nothing measured qualifies. |
| Weekly windows set urgency; the 5-hour window is eligibility only | invariant; basis: enumerable-domain; evidence: the 5-hour window refills within hours, so its unused room is never lost; only weekly room expires unused | Fixes a pairing error. |
| Fable window binds a known Fable model; ranking-only for unknown; never empties the pick | judgment-candidate; floor: it can only reorder accounts or fall back to today's eligibility, never return null; arbiter: the graduation review from `fable` and `fable-no-room` rows | The provider scopes that window to the Fable model; the model is not always known. |
| Rolled reading invalid for proactive swaps | invariant; basis: irreversible-consequence; evidence: a swap moves a running session, and moving onto an account on an unread 0% risks an immediate move back (anti-thrash bound 0) | Refusal only. |
| 0.25-hour urgency clamp and 0.0001 no-reset urgency (both existing) | judgment-candidate; floor: they only cap or lower urgency, never change eligibility; arbiter: the graduation review | Kept from today. |
| Re-poll at most once per account per 15 minutes after a roll | judgment-candidate; floor: the regular poll still runs; this only adds one early read; arbiter: the graduation review from poll counts | Bounds extra provider calls. |
| 500 shadow rows a day per machine | judgment-candidate; floor: repeats are counted in the open row and drops are counted in the next one; arbiter: the graduation review | Storage bound with disclosure. |

## Multi-machine posture

- **Placement decisions:** per machine. machine-local-justification: physical-credential-locality — a pick selects a login whose credential home lives on this machine's disk, and each machine places only its own spawns.
- **Switch:** per machine, like every dev-gated switch. machine-local-justification: operator-ratified-exception — the dev-gate pattern registered in `src/core/devGatedFeatures.ts` (the registry key `subscriptionPool.pacing.windowAwareChoice` added there) is the ratified per-machine rollout mechanism for all dev-gated features.
- **Shadow log:** unified, proxied on read. Each machine writes the decisions it made; `GET /quota-pacing/account-choice?scope=pool` merges every machine through step 1's bearer fan-out and names machines that did not answer. Excluded from git-sync like the other `logs/` files because it is merged live.
- **Pool records:** unchanged; each machine reads the pool records it already has.
- No notices are sent and no URLs are generated.

## Frontloaded Decisions

- `spawnAccount()` moves to the shared tiered score behind the same switch (it keeps its freshness and usability filters). Otherwise the fix would miss the fleet's default spawn path.
- A rolled or unknown window is unmeasured, never 0 and never last cycle's number, and triggers one early re-read.
- Fable is decided with `isFableModel()` on the concrete launch model, falling back to the configured default, then unknown; a Fable-only reason never empties the pick.
- Fable awareness in the swap paths is out of scope for this step.
- The shadow evidence is read pool-wide through step 1's fan-out; step 2 merges after PR #3330.
- The old signature of `bindingUtilization` stays valid for display callers.
- Dev-gated through `resolveDevAgentGate`; no config migration (the key has never existed).

## Left behind

- Fable awareness for swaps of running sessions (no per-session model input in the swap paths today).
- Mid-session `/model` changes are not seen by placement (placement happens at spawn).

## Open questions

*(none)*
