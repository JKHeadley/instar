---
title: "Pool-Aware Quota Throttle"
slug: "pool-aware-quota-throttle"
author: "echo"
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"
eli16-overview: "POOL-AWARE-QUOTA-THROTTLE-SPEC.eli16.md"
approved: true
approved-by: "echo (pre-approved autonomous run — Justin 2026-06-15 'enter a 24 hour autonomy session and fix this')"
review-convergence: "2026-06-16T07:31:26.310Z"
review-iterations: 3
review-completed-at: "2026-06-16T07:31:26.310Z"
review-report: "docs/specs/reports/POOL-AWARE-QUOTA-THROTTLE-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 0
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Pool-Aware Quota Throttle — Spec

Status: draft (pre review-convergence)
Author: Echo · Date: 2026-06-16 · Commitment: CMT-1574
Authorized: Justin 2026-06-15 — "account load balancing very robust and safe… then optimizations."

## Problem

The global quota brake is **account-blind**. `QuotaTracker.shouldSpawnSession()` reads a single
number — `usagePercent` from `.instar/quota-state.json` — and at the `shutdown` threshold returns
`allowed:false, "Weekly quota at N% — all jobs stopped"`, halting the WHOLE agent. The collector
(`QuotaCollector`) writes ONE account's value (the default OAuth account) to that file. It DOES
collect per-account `accountSnapshots` (`pollMultipleAccounts()`), but they are in-memory only and
the throttle never sees them.

Live consequence (2026-06-15): sagemind-justin at 100% weekly + a degraded `claude-jsonl` estimate
of 186% jammed the brake → `/autonomous/can-start` = "all jobs stopped" → the whole agent throttled
while `adriana` and `sagemind-adriana` sat at 0%/0%, never used. This is the exact "two accounts
untouched while work stalls" symptom the operator reported.

## Goal

The brake must reflect **pool headroom**, not one account. If ANY enrolled, eligible account has
headroom, work is ALLOWED — because the subscription pool places the session on the best-available
account. Never stop the agent while a fresh account exists. Robust + safe FIRST; optimizations later.

## Design (revised after convergence round 1 — see reports/POOL-AWARE-QUOTA-THROTTLE-round1-findings.md)

Round 1 (6 internal reviewers + codex GPT-5.5) rejected the first design (collector folds per-account
snapshots into `quota-state.json`): it was **dead in production** (the collector is constructed with
no `registryPath`), it read a **different store at a different threshold** than the placement layer
(reintroducing a respawn loop in the 90-95% band), and it folded **stale error-branch snapshots as
fresh 0% headroom**. The revised design below shares placement's exact predicate, by construction.

### 1. A live pool-placeability provider (shared with placement)
`QuotaTracker` gains an optional injected provider `setPoolQuotaProvider(() => PoolQuota | null)`,
where `PoolQuota = { placeable: boolean; weeklyPercent?: number|null; fiveHourPercent?: number|null }`.
It is wired in `server.ts` (after the SubscriptionPool exists, only when `subscriptionPool.size() > 1`)
to call `poolHeadroom(subscriptionPool.list(), { nowMs })` — a helper in the placement module that
shares `selectAccount`'s EXACT eligibility predicate but returns the MOST-HEADROOM eligible account
(not the use-it-or-lose-it drain-first winner). `placeable` ⟺ `selectAccount(...) !== null`. This reads the SAME
LIVE store placement uses - not a persisted snapshot - so there is no staleness gap and no
dead-wiring gap. A solo agent (<=1 account) gets no provider, so the legacy path is byte-identical.

### 2. Pool-aware `shouldSpawnSession`
- When a provider is set and returns a result: if `!placeable` => STOP ("no placeable account").
  Otherwise gate the best placeable account's `weeklyPercent`/`fiveHourPercent` through the existing
  tiered `evaluateAccountQuota(priority)` (so load-shedding by priority still applies). Because
  `selectAccount` already vouched for placeability - and its soft threshold (default 90%) is STRICTER
  than the shutdown threshold (95%) - a throttle "allow" is GUARANTEED to correspond to an account
  placement can land on. **This closes the never-loop gap by construction** (F2): allowed => placeable.
- A `null` weekly percent = "unknown but placeable" -> treated as 0 (selectAccount already deemed it
  eligible via `bindingUtilization`).
- Provider throws / returns null => fall through to the file-based logic below.
- No provider (solo agent) => legacy single-account path, unchanged.
- TWO QUESTIONS, ONE PREDICATE: the throttle asks "is there capacity ANYWHERE?" (`poolHeadroom`, gates
  on most-headroom); placement asks "WHERE should this land?" (`selectAccount`, drains soonest-to-reset
  for use-it-or-lose-it). Both share `isEligibleStatus` + the soft threshold, so `allowed ⟹ placeable`.

### 3. "Effective usage" definition (F5)
Placement's `bindingUtilization` already defines effective usage as `max(sevenDay, fiveHour)`. The
throttle reuses it implicitly: `evaluateAccountQuota` checks BOTH weekly and 5h independently against
the tiers, and `selectAccount` (which decides placeability) scores on `bindingUtilization`. No new
combination function is invented.

### 4. Degraded-data hardening - BOUNDED, non-authoritative only (F4)
An implausible/non-authoritative reading must not slam the brake, but because the real usage is
UNKNOWN, fail-open is **bounded**:
- Trigger only when the source is NOT authoritative (`source !== 'anthropic-oauth'`) AND it looks
  degraded (`source === 'claude-jsonl'` OR `usagePercent > 100`). An authoritative reading is NEVER
  treated as degraded - a genuine wall still stops (a real `anthropic-oauth` >=shutdown still halts).
- On degraded: still honor a genuine authoritative 5-hour wall (`fiveHourPercent >= 95` => stop);
  otherwise SHED low priority and allow medium+ (a conservative degraded-mode cap, not unbounded
  fail-open). This both prevents the 2026-06-15 whole-agent stall AND avoids unbounded spawning.

### 5. Never-loop invariant (placement) - enforced, not asserted
F2's loop came from the throttle and placement using different sources + thresholds. The provider
design makes the throttle ASK placement (`selectAccount`) directly, so the two can no longer diverge.
Pinned by a unit test sweeping usage 0->100 asserting `allowed => selectAccount() !== null`, and a
test of the 90-95% band (all accounts at 92% => STOP, because selectAccount excludes >90%).

## Convergence round 2 resolutions (pool-path data-quality)
Round 2 (adversarial + lessons-aware + codex) accepted F1-F5 as resolved but found the bounded
degraded protection guarded only the FILE path, not the new pool path. Resolved in round 3:
- **Pool-path data-quality guard.** `PoolQuota` carries an optional `degraded` flag. The server.ts
  provider CLAMPS each per-account percent to [0,100] (a non-finite/out-of-range reading becomes
  null) and sets `degraded: true` when a placeable account has NO trustworthy live reading (all
  snapshots missing/stale — freshly enrolled pool, or poller degraded). The throttle then applies the
  SAME bounded degraded cap (shed low, allow medium+, honor an authoritative 5h wall) instead of
  trusting a phantom "0% fresh". The bounded logic is one shared helper used by both paths.
- **Implausible per-account input** (>100 / negative / NaN) is treated as untrustworthy → bounded,
  never as headroom. Pinned by a test sweeping bad inputs.
- **`selectAccount` contract.** The provider relies on `selectAccount` being a pure, deterministic
  function of `(accounts, nowMs)` sharing placement's exact eligibility predicate. It reads the live
  in-memory pool with no side effects.
- **Decision-time invariant.** `allowed ⟹ placeable` holds AT DECISION TIME. A later placement that
  finds the last account just got consumed is a NORMAL non-looping outcome (caller backs off) — NOT
  the old respawn loop, which came from throttle/placement DISAGREEING (now impossible).

## Accepted minor notes (round 3, non-material — codex GPT-5.5)
- **Throttle couples to `selectAccount`'s semantics.** Sharing `selectAccount` is deliberate — it is
  exactly what guarantees throttle/placement can't diverge (closes F2). The known tradeoff: if
  `selectAccount` later layers ranking (stickiness/fairness/cost) on top of eligibility, the throttle
  inherits it. ACCEPTED for this PR; the clean future shape (a stable `isPoolPlaceable` predicate that
  ranking layers on top of) is noted for the optimizer PR. Today eligibility == placeability is the
  right, safe coupling.
- **Gating must use MOST-HEADROOM, not the drain-first winner — OVERRIDDEN by live proof.** Codex
  round 2 flagged that gating the single best-by-score account "can be marginally stricter" and marked
  it ACCEPTED. The 2026-06-16 live proof against Justin's REAL pool proved it was NOT marginal: with
  justin-gmail at 86% as the drain-first winner alongside a fresh 0% adriana reserve, gating on
  justin-gmail wrongly shed ALL non-critical work (autonomous can-start at medium → blocked) even
  though the pool had abundant capacity. Fixed: the throttle gates via `poolHeadroom` on the
  MOST-HEADROOM eligible account, so non-critical work runs whenever ANY account has room. Placement
  (`selectAccount`) still drains the soonest-to-reset account (use-it-or-lose-it) — the two questions
  are now answered by two helpers sharing one eligibility predicate.

## Multi-machine posture
`quota-state.json` and the SubscriptionPool view the throttle reads are **machine-local BY DESIGN**:
each host polls its own account credentials and places sessions locally. Replicating would be wrong
(machine A's stale view would gate machine B's spawns). The existing `GET /subscription-pool?scope=pool`
is the cross-machine quota surface and is unchanged by this PR.

## Decision boundaries (tested BOTH sides)
- Provider reports a placeable fresh account (underlying file 100%) => **allowed**.
- Provider reports no placeable account => **stop**.
- Best placeable account in the elevated band => priority load-shedding still applies (high+ only).
- 5h wall on the best placeable account => stop.
- Real `selectAccount` provider: one walled + one fresh => allowed; ALL at 92% => stop (F2 band).
- `allowed => placeable` invariant across a 0->100 usage sweep.
- Single-account legacy (no provider) => unchanged behavior (still stops at shutdown).
- Degraded estimate (186% / claude-jsonl), NO provider => BOUNDED: low shed, medium+ allowed.
- AUTHORITATIVE >100 (anthropic-oauth) => still STOPS (fail-open gated to non-authoritative).
- Pool provider signals `degraded` (placeable, no live reading) => BOUNDED: low shed, medium+ allowed.
- Implausible per-account weekly (>100 / negative / NaN) => untrustworthy => bounded (not phantom 0%).
- ALL accounts status=rate-limited => selectAccount null => STOP (placement can't land; self-clearing
  on the next poll when a window resets — the stop is re-evaluated each call, never latched).

## Non-goals (the SECOND PR — tracked, not dropped) <!-- tracked: CMT-1574 -->
Use-it-or-lose-it drain-near-reset, burn-rate weighting, resolving the 2 quarantined ledger slots,
and taking the credential-repointing optimizer live are the "optimizations" — owned by CMT-1574 and
sequenced after this throttle fix is proven stable, per the operator's order. <!-- tracked: CMT-1574 -->

## Testing (3 tiers, non-negotiable)
- Unit: `shouldSpawnSession` decision boundaries above, both sides; degraded-data fail-open.
- Integration: `GET /autonomous/can-start` returns allowed when `accounts[]` has a fresh account
  despite one walled; stop when all walled.
- E2E: the real server path persists `accounts[]` and the throttle consults it (feature-is-alive).
- Live proof: after merge, `adriana`/`sagemind-adriana` demonstrably carry load.

## Migration / awareness
- Pure code change to a core monitor — ships in code, reaches existing agents on update (verify
  `QuotaManager` passes snapshots through to `updateState`). No settings/config migration unless a
  dark-gate flag is added (none anticipated — this is a correctness fix, default-on, fail-safe).
- Agent Awareness: add 2+ mentions to the CLAUDE.md template (Token-Burn / quota section) describing
  pool-aware throttling so agents can explain "why didn't the agent stall with a maxed account?".

## Open questions
*(none)*
