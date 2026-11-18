---
title: "Quota pacing, step 2: account choice reads each limit window correctly"
slug: "quota-pacing-account-choice"
author: "echo"
parent-principle: "Verify the State, Not Its Symbol"
eli16-overview: "quota-pacing-account-choice.eli16.md"
status: "draft"
approved: false
parent-spec: "quota-pacing-forecast.md (step 1 names these three faults as step 2); POOL-AWARE-QUOTA-THROTTLE-SPEC.md; swap-continuity-antithrash"
lessons-engaged:
  - "P20 Verify the State, Not Its Symbol: a reading from a window that has already reset is not the account's state"
  - "P2 Signal vs Authority: placement already has authority; this changes only the inputs it reads, behind a dev-gated switch with a shadow log"
  - "P21 Multi-machine: placement is per machine; nothing new is shared"
origin: "Justin, topic 144201, 2026-11-17 23:03 PST: 'Now we need to do the actual work of ongoing token pacing as this topic was created for'. Step order from the token pacing plan, topic 141385, 2026-11-17 10:19 PST."
---

# Quota pacing, step 2: account choice reads each limit window correctly

## Problem

When Instar starts or moves a session, `selectAccount()` (`src/core/QuotaAwareScheduler.ts`) picks the account with the highest use-before-reset score. The idea is right: put work on the account whose unused room expires soonest. The arithmetic has three faults, all checked against `main` at `db6455652`.

1. **Windows are mixed.** `scoreAccount()` takes the unused room from `bindingUtilization()`, the higher of the 5-hour and weekly readings, and the urgency from `soonestResetMs()`, the earliest reset of either window. For any account with a 5-hour window the soonest reset is almost always the 5-hour one, so the urgency says "resets within 5 hours" while the room is mostly weekly room. Example: account A is 40% into its week (resets in 6 days) and 10% into its 5 hours (resets in 30 minutes): room 60, urgency 1/0.5, score 120. Account B is 20% into a week that resets in 2 hours, with no 5-hour reading: room 80, urgency 1/2, score 40. Placement picks A, and B's 80 points expire unused two hours later. That is the exact waste this project exists to prevent.
2. **The Fable limit is ignored.** Claude accounts carry a separate Fable weekly window (`AccountQuotaSnapshot.fable`, read by `QuotaPoller`). Neither `bindingUtilization()` nor `scoreAccount()` reads it. A Fable session can be placed on an account whose Fable window is at 98% and hit the wall at once, while another account has Fable room.
3. **Readings from a window that already reset still count.** Nothing compares a window's `resetsAt` with now. After a reset, until the next successful poll, the account is judged by last week's number: an account read at 92% just before its reset stays excluded at the 90% soft line although it is now near 0%. Its `resetsAt` is in the past, so urgency is clamped to the maximum (`hours = 0.25`), which inflates its score whenever it is eligible. Tonight's quota reader failed three times in four hours (8:04, 8:37 and 10:02 PM), so a stale reading spanning a reset is a real case, not a theoretical one.

This step does not cover sessions launching under an account other than the one they are tagged with; that is PR #3390. It does not use the step 1 forecast; that is a later step with its own spec.

## Goal

Placement and the swap paths judge each account by the windows that actually limit the work being placed, as they stand now:

- The use-before-reset score pairs each window's room with that same window's reset.
- A Fable session is judged against the Fable window as well.
- A window whose reset time has passed is treated as reset, and labelled as an estimate until a fresh reading arrives.

## Non-goals

- No change to the 90% soft line, the anti-thrash bounds, or which callers use placement.
- No use of the forecast, history or calibration from step 1.
- No change to Codex placement rules beyond the shared helpers (Codex accounts have no Fable window; the expiry rule applies to them too).
- No dashboard change. The shadow log is the surface.

## Design

### 1. One helper reads a window as it stands now

New pure function in `QuotaAwareScheduler.ts`:

```ts
windowNow(w, nowMs, lengthMs) → { pct: number | null; resetsAtMs: number | null; rolled: boolean }
```

- No window, or an unparseable `resetsAt`: `{ pct: w?.utilizationPct ?? null, resetsAtMs: null, rolled: false }`.
- `resetsAt` in the future: the reading as it is.
- `resetsAt` at or before now: the window has reset since the reading. `pct: 0`, `rolled: true`, and the next reset is projected by adding whole window lengths (5 hours, 7 days) until it is in the future. A rolled window is an estimate: it can only say "this much room at least as of the reset", and usage since the reset is unknown.

Window lengths are constants: 5 hours for `fiveHour`, 7 days for `sevenDay` and `fable`. These are the providers' published window lengths; step 1's fixed-window check reports any provider that behaves otherwise.

### 2. Which windows bind a placement

`SelectionOptions` gains `model?: string`. A model whose family is Fable (`modelFamily(model) === 'fable'`, the existing classifier used by the routing code) adds the `fable` window to the binding set. Every other model, and an unknown model, uses the 5-hour and weekly windows only, as today.

`bindingUtilization(snap, at?: { nowMs: number; model?: string })` returns the highest `pct` over the binding windows read through `windowNow`. Called without `at`, it behaves exactly as today, so display callers are unchanged. Every decision caller passes `at`:

- `selectAccount()` and `poolHeadroom()` (they must keep the same eligibility predicate, the never-loop invariant documented in the file);
- `ProactiveSwapMonitor` (threshold and target choice);
- `SwapAntiThrash` (its validity gate keeps its own staleness rules; only the utilization it compares comes through the helper);
- `UsageWallRescue.spawnAccount()` and `codexDeviceLimitWiring`.

### 3. The score pairs room with its own reset

```
weekly windows = sevenDay, plus fable when the model is Fable
for each weekly window w with a reading: score_w = (100 - pct_w) / max(0.25, hoursToReset_w)
score = min over weekly windows of score_w
```

The weekly window is the use-it-or-lose-it window; the 5-hour window refills within hours and so is never "lost". The 5-hour window stays what it is today: an eligibility gate through the soft line. Taking the minimum across weekly windows means a Fable session is ranked by whichever of its two weekly limits leaves the least room per hour.

- An account with no weekly reading keeps today's rule: room from the binding utilization, low urgency (`0.0001`), so a freshly enrolled account is still selectable.
- A rolled weekly window scores on its projected next reset (about a week away), so it ranks as a fresh account, not as the most urgent one.
- Ties break by account id, as today.

### 4. Model reaches the spawn resolver

The resolver types in `SessionManager` widen to `(ctx?: { model?: string }) => …`. The three call sites (lines about 4960, 5442 and 8345 on `db6455652`) pass the spawn's resolved model. `UsageWallRescue.spawnAccount(ctx?)` and the `pinSessionsToPool` resolver in `server.ts` forward it to `selectAccount`. Swap paths pass the session's recorded model where the session record has one. A caller with no model behaves as today, and the shadow row records `model: null`.

### 5. Switch and shadow log

- **Switch:** `subscriptionPool.pacing.windowAwareChoice`, resolved through `resolveDevAgentGate()` (on for development agents without the key, off for the fleet, an explicit value always wins). Registered in `src/core/devGatedFeatures.ts` and given a ladder in `src/data/feature-ladders.json`. Off = every function returns exactly what it returns today; a test proves byte-identical selection over a fixture pool.
- **Shadow log:** whether the switch is on or off, every decision caller computes both the old and the new choice. When they differ, one row goes to `logs/account-choice-shadow.jsonl`: `{ ts, machineId, caller, framework, model, oldPick, newPick, reason: 'window-pairing' | 'fable' | 'rolled-window', accounts: [{ id, fiveHour, sevenDay, fable, rolled }] }` (percentages and reset times only, no tokens or emails). Rows are capped at 500 a day per machine with a dropped count, and rotated like the other jsonl logs. This is the evidence the graduation review reads: how often the choice changes, for which reason, and what happened to the session afterwards (it hit a wall or it did not, read from the existing wall and swap logs by session name).

## Maturation plan

- **test-agent-live:** before merge, a throwaway agent with a seeded pool of four accounts (the example A and B above, a Fable-heavy account, and one read at 92% one minute before its reset) boots the real server; placement through `POST /sessions/spawn` lands on B for a non-Fable session, skips the Fable-heavy account for a Fable session, and accepts the rolled account. The shadow log holds one row per changed decision with the right reason.
- **dev-agent-live:** on from merge on Echo's machines through the dev gate.
- **fleet:** default-on for every agent is the last rung, after the review.
- **graduation criterion:** a review on the maturation board, filed at merge, reads the shadow log after at least two weekly resets per Claude account: how many choices changed and why, and whether sessions placed by the new rule hit a wall less often than the old rule's counterfactual pick was at at the time. It promotes on judgment from that evidence, not on a timer.
- **dark-window:** 3 weeks on Echo.

## Safety and side effects

- **Authority:** unchanged in kind. Placement already decides where a session runs; this changes which numbers it reads. With the switch off nothing changes.
- **Worst case of a rolled estimate:** an account is treated as fresh after its reset while it was in fact used heavily since. The 5-hour window and the reactive wall rescue still catch that, exactly as they catch a freshly enrolled account today, and the next successful poll replaces the estimate.
- **Fable classification wrong:** an unknown model uses today's rule, so a misclassification can only drop back to current behaviour.
- **Never-loop invariant:** `poolHeadroom()` and `selectAccount()` share the same eligibility through the same helper; a unit test asserts `placeable ⟺ selectAccount(...) !== null` over randomized pools with rolled windows and Fable models.
- **Cost:** a few comparisons per decision; the shadow log is bounded.

## Tests (three tiers)

- **Unit, `windowNow`:** future reset; reset exactly now; reset hours ago (rolled, next reset projected forward by whole windows); reset several weeks ago; missing and unparseable `resetsAt`.
- **Unit, `bindingUtilization`/`scoreAccount`/`selectAccount`:** the A/B example picks B; 5-hour window never sets urgency; Fable model adds the Fable window and an unknown model does not; minimum across weekly windows; rolled account is eligible and not maximally urgent; no-weekly-reading account keeps today's score; switch off gives today's results on a fixture pool; never-loop invariant over randomized pools.
- **Unit, shadow log:** one row per differing decision, reason chosen correctly, daily cap with dropped count, no row when picks agree.
- **Wiring:** each decision caller passes `nowMs` (and the model where it has one); the SessionManager resolver receives the spawn's model at all three call sites; the dev-gate resolution.
- **Integration:** `tests/integration/subscription-pin-sessions.test.ts` extended: a pinned spawn over the seeded pool lands on the account the new rule picks, and on the old one with the switch off.
- **E2E (feature is alive):** the production init path in `server.ts` wires the resolver with model context, and a development agent with no config key resolves the switch to on.

## Measure of success

- Correctness is the unit tests.
- Usefulness, on Echo within two weekly resets: the shadow log shows how often each fault changed a choice, and the sessions the new rule placed hit no more walls than the old rule's picks would have.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A window whose `resetsAt` has passed counts as reset (pct 0, next reset projected) | invariant; basis: external-constraint; evidence: the provider's `resetsAt` is its own statement of when the window refills; a fixed window cannot still hold last cycle's usage after it | Reading the provider's data correctly, not a tuned value. |
| Weekly windows set urgency; the 5-hour window is eligibility only | invariant; basis: enumerable-domain; evidence: the 5-hour window refills within hours, so its unused room is never lost; only weekly room expires unused | Fixes a pairing error, not a threshold. |
| Fable window binds only Fable-family models; unknown model uses today's rule | invariant; basis: external-constraint; evidence: the provider scopes that window to the Fable model (`scope.model.display_name`) | Fallback is the current behaviour. |
| Minimum across weekly windows for a Fable session | judgment-candidate; floor: it can only rank an account lower, never make an ineligible one eligible; arbiter: the graduation review from the shadow log | Conservative combination. |
| 500 shadow rows a day per machine | judgment-candidate; floor: a dropped count is always recorded; arbiter: the graduation review | Storage bound. |

## Multi-machine posture

- Placement is per machine and reads the pool records each machine already has. Nothing new is replicated.
- The switch is per machine, like every dev-gated switch.
- The shadow log is per machine telemetry, excluded from git-sync like the other `logs/` files, and read on the machine where the decision was made.

## Frontloaded Decisions

- Fix the shared helpers rather than each caller, so placement, headroom and the swap paths cannot drift apart.
- The old signature of `bindingUtilization` stays valid for display callers.
- The model reaches placement through an optional resolver context, not a new global.
- Dev-gated through `resolveDevAgentGate`; no config migration (the key has never existed).

## Open questions

*(none)*
