---
title: "Quota-aware placement must see the open LLM circuit"
slug: "placement-llm-circuit-aware-quota"
author: "echo"
parent-principle: "No Silent Degradation to Brittle Fallback — a machine that cannot actually serve LLM work must report itself blocked, not present a healthy-looking quota signal that misroutes work onto it."
review-convergence: "2026-06-16T07:32:20.073Z"
review-iterations: 3
review-completed-at: "2026-06-16T07:32:20.073Z"
review-report: "docs/specs/reports/placement-llm-circuit-aware-quota-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
approved: true
approved-by: "echo (autonomous run, standing operator pre-approval for topic 13481 — design/spec decisions are mine to approve and report in the ELI16)"
---

# Quota-aware placement must see the open LLM circuit

## Problem statement

Quota-aware placement (`PlacementExecutor`) avoids machines whose capacity heartbeat reports
`quotaState.blocked === true`. That `quotaState` is produced by `selfQuotaState()` in
`src/commands/server.ts`, which derives `blocked` ONLY from the account-quota poll
(`quotaTracker.getState()` → `blockedUntil` in the future, or `fiveHourPercent >= 95`).

It does **not** consider the `LlmCircuitBreaker`. The circuit trips on ACTUAL provider call
failures (`claude -p` returning a rate-limit error) and, while open, pauses all LLM-backed
work on that machine. So a machine can have an **open** circuit (its CLI is genuinely
rate-limited and cannot run a session) while its account-quota poll still reports
`blocked: false` — the two signals disagree, and the poll is the one placement reads.

**Live-test finding (2026-06-16, topic 13481):** applying the gold-standard live test to the
multi-machine transfer, a real Slack message routed cross-machine to the Mac Mini (placement
chose it; the Laptop is over-subscribed). The Mini's `GET /pool` reported
`quotaState: {blocked: false}`, but its `logs/server.log` showed
`[llm-circuit] OPEN: provider rate-limited — pausing ALL LLM-backed work`. The handed-off
session's Claude CLI errored immediately, the session died, and the user received a "session
stopped" stall notice instead of a reply. Placement had routed a session onto a machine that
could not serve it — the exact thing quota-aware placement exists to prevent. The docs claim
placement "avoids machines whose account is currently rate-limited"; it doesn't, because an
open circuit isn't reflected in `quotaState.blocked`.

## Proposed design

Make `selfQuotaState()` treat an **open (or half-open) LLM circuit as a quota block**, OR-ed
with the existing account-quota signals. The circuit reflects REAL CLI behavior (calls are
failing right now), which is precisely what "can this machine serve a session" needs.

`llmCircuitAvailable()` already exists on the shared breaker singleton
(`src/core/LlmCircuitBreaker.ts`): it returns `!enabled || state === 'closed'` — so
`!llmCircuitAvailable()` is true **only** when the breaker is enabled AND not closed
(open/half-open). A disabled breaker reports available → never a false block.

### Extract a testable pure function (Structure > Willpower)

The current logic is inline in `server.ts` and untestable. Extract it into
`src/core/selfQuotaState.ts`:

```ts
export interface QuotaSnapshot { blockedUntil?: string | null; fiveHourPercent?: number | null; blockReason?: string | null; }
// Type-level discriminator for the block CAUSE so consumers branch on a closed set, not a
// free string (addresses the "widened signal" review: the field is placement-eligibility,
// the reason names which cause). `provider-block`/`five-hour-*` = account quota;
// `llm-circuit-open` = operational unavailability. Free-form quota strings still flow through
// for back-compat, typed as the open `string` arm.
export type SelfQuotaBlockReason = 'llm-circuit-open' | 'five-hour-exhausted' | 'provider-block' | (string & {});
export interface SelfQuotaBlock { blocked: boolean; blockedUntil?: string; reason?: SelfQuotaBlockReason; }

export function computeSelfQuotaState(
  quota: QuotaSnapshot | null | undefined,
  circuitAvailable: boolean,
  now: number = Date.now(),
): SelfQuotaBlock | undefined {
  // An open llm-circuit is a hard block regardless of the account-quota poll — the machine's
  // provider calls are failing right now, so it cannot serve a session. This wins even when
  // there is no quota snapshot (a machine with no tracker but an open circuit is still blocked).
  if (!circuitAvailable) return { blocked: true, reason: 'llm-circuit-open' };
  if (!quota) return undefined;            // no tracker + circuit ok = unknown ≠ blocked
  const blockActive = !!quota.blockedUntil && Date.parse(quota.blockedUntil) > now;
  const fiveHourExhausted = (quota.fiveHourPercent ?? 0) >= 95;
  if (!blockActive && !fiveHourExhausted) return { blocked: false };
  return {
    blocked: true,
    blockedUntil: quota.blockedUntil ?? undefined,
    reason: quota.blockReason ?? (fiveHourExhausted ? `5-hour window at ${quota.fiveHourPercent}%` : 'provider block'),
  };
}
```

`server.ts` calls `computeSelfQuotaState(quotaTracker?.getState(), llmCircuitAvailable())`
inside the existing `try` (a thrown error still yields `undefined` = unknown ≠ blocked,
preserving today's fail-open semantics). `llmCircuitAvailable` is added to the existing
top-level `LlmCircuitBreaker` import.

### Why fail-open is preserved where it matters

- **Unknown stays unknown:** any throw (or no tracker + closed circuit) → `undefined`, which
  `PlacementExecutor` treats as not-blocked (older-heartbeat semantics). We do NOT newly block
  on missing information — only on a *positively observed* open circuit.
- **All-blocked still proceeds (and is honest about its limit):** `PlacementExecutor` already
  falls back to least-loaded with `all-machines-quota-blocked` when every machine is blocked,
  so adding a real block can never STRAND placement. When *every* machine's circuit is open the
  fallback does route into a machine that will fail — but this is identical to today's
  all-account-quota-blocked case and is an inherent property of "no machine can serve," NOT a
  regression this fix introduces: there is genuinely nowhere good to route, and placement is the
  wrong layer to manufacture capacity that does not exist. The honest outcome is the
  `all-machines-quota-blocked` flag (now possibly carrying `llm-circuit-open` reasons) plus the
  session-death/stall path that already exists — surfaced, not hidden. The fix is strictly
  better whenever *some* machine is available (it steers off the circuit-open ones); it is
  exactly neutral (today's behavior) only when all are blocked.
- **Half-open = avoid:** a half-open circuit (probing recovery) is treated as blocked; new work
  shouldn't be routed to a machine still proving it recovered. It becomes eligible the moment
  the circuit closes.

### Semantic contract & consumers (the signal widens — say so explicitly)

`quotaState.blocked` is, and has always been, a **placement-eligibility** signal — "this
machine cannot serve LLM work right now" — NOT a pure account-quota readout. Account-quota
exhaustion was simply its only cause until now; an open circuit is a second cause. The
`reason` field is the discriminator and must be treated as **operational unavailability**:
`llm-circuit-open` (provider calls failing) vs `5-hour window at N%` / `provider block`
(account quota). Consumers audited for this widening:

- `PlacementExecutor` — the primary consumer; it only needs "eligible or not," so the wider
  meaning is exactly right (it already flags `pinned-machine-quota-blocked` /
  `all-machines-quota-blocked`).
- `GET /pool` — surfaces `quotaState` per machine; the `reason` now distinguishes the cause,
  so the display is MORE informative, not misleading. Any user-facing copy that renders this
  must say "currently unable to serve" (operational), never "account out of quota"
  specifically — the reason string carries the precise cause.
- No other code path keys on `quotaState.reason === '<a specific quota string>'`; the block is
  consumed as a boolean + a human reason, so widening the cause set is non-breaking.

**On the field NAME (`quotaState`).** The name is retained deliberately, not by omission:
`quotaState` is a REPLICATED wire field on the capacity heartbeat, consumed cross-machine by
every peer's `MachinePoolRegistry` and rendered by the dashboard + `GET /pool`. Renaming it to
`availabilityState`/`placementBlockState` is a breaking wire-format change requiring its own
mixed-version migration (old peers send `quotaState`, new peers read the new name) — a distinct
wire-migration concern, out of scope for this correctness fix by construction (not in this fix's
file set and not a thing this fix leaves half-done). This fix pins the *meaning* two ways
instead: the documented contract above, and the `SelfQuotaBlockReason` enum that makes the cause
type-level explicit, which is the seam any eventual rename would build on.

### Observability

The block is observable without any new metric: `GET /pool` shows each machine's
`quotaState.blocked` + `quotaState.reason` (now `llm-circuit-open` when circuit-derived), and
`PlacementExecutor`'s decision flags (`pinned-machine-quota-blocked`,
`all-machines-quota-blocked`) already record when a block drove a placement. The circuit's own
transitions are already audited in `logs/server.log` (`[llm-circuit] OPEN/closing`). So
"how often did a circuit-derived block steer placement?" is answerable by correlating the
existing placement flags with the `llm-circuit-open` reason — no new surface required, and the
fix's success criterion is precisely that a circuit-open machine now shows
`quotaState.blocked:true` in `/pool` (the live-test signature was `blocked:false` while the
circuit was open). **Tuning lever:** the behavior is governed by the existing
`intelligence.circuitBreaker` config (`enabled`, `openMs`) — disabling the breaker (or it never
tripping) keeps `llmCircuitAvailable()` true so this never blocks; the operator can turn the
driving signal off without a new knob. A dedicated counter is judged gold-plating here (the
cause is a low-frequency, already-logged circuit transition); if circuit-derived blocks ever
become frequent enough to warrant one, the `reason` enum is the ready aggregation key.

### Multi-machine posture

This strengthens an existing replicated signal: `quotaState` already rides the capacity
heartbeat to every peer (`PeerPresencePuller` / `MachinePoolRegistry`), and placement reads
the merged view. No new state, route, or URL — the block is computed per-beat on each machine
from its own breaker and propagates through the existing heartbeat. Single machine: placement
has nowhere else to go, so the existing all-blocked least-loaded fallback applies (unchanged).

## Decision points touched

No new block/allow gate is introduced. It widens one existing placement-eligibility signal
(`quotaState.blocked`) to include a real, already-computed condition (the open circuit). The
change is strictly toward correctness: a machine that cannot serve LLM work now says so.

## Frontloaded Decisions

- **Block on half-open, not just open.** Chosen: conservative — don't route to a machine still
  probing recovery; it re-qualifies on close. Cheap-to-change (a one-line predicate) and
  observe-only in effect (placement preference), no durable side-effect.
- **Circuit block wins over a missing quota tracker.** Chosen: an open circuit is authoritative
  even with no quota snapshot (the machine's calls are failing). Reversible; pure function.

## Testing

- **Tier 1 (`tests/unit/selfQuotaState.test.ts`):** both sides of every boundary —
  circuit-open ⇒ blocked even when quota is healthy (THE fix / the Mini case); circuit-closed +
  quota-healthy ⇒ `{blocked:false}`; circuit-disabled (`llmCircuitAvailable()===true`) ⇒ not
  blocked (no false-positive); quota `fiveHourPercent>=95` ⇒ blocked; `blockedUntil` future ⇒
  blocked; no quota + circuit-open ⇒ blocked; no quota + circuit-ok ⇒ `undefined` (unknown).
- **Wiring-integrity:** assert `server.ts` calls `computeSelfQuotaState` with both the live
  quota snapshot AND `llmCircuitAvailable()` (the regression guard for "placement blind to the
  circuit"), so the two-signal contract can't silently regress to quota-only.
- **Tier 2 (integration):** `PlacementExecutor` over a fixture machine set where one machine's
  `quotaState` is `{blocked:true, reason:'llm-circuit-open'}` — assert it is filtered out of
  `quotaOk` and placement avoids it (and the all-blocked least-loaded fallback still fires when
  every machine is circuit-blocked).
- **Tier 3 / E2E — the live re-run.** A capacity-heartbeat→placement path only fully manifests
  across real machines, so the gold-standard live re-run is the E2E and a release gate (not
  optional): on a pool where one machine has a genuinely open circuit (the Mini's exact
  condition), `GET /pool` shows that machine `quotaState.blocked:true / reason:'llm-circuit-open'`
  and a newly-routed conversation lands on a machine that can serve it (a real reply comes back),
  rather than dying on the circuit-open machine. The durable proof is the `/pool` block reason
  plus the served reply; the previous live test recorded the failing baseline
  (`blocked:false` while the circuit was open), so the before→after is the artifact.

## Open questions

*(none)*
