---
slug: proactive-default-account-swap
title: Proactive Swap for Bound Default-Account Sessions
author: instar-codey
parent-principle: "Capacity Safety — No Unbounded Self-Action"
eli16-overview: proactive-default-account-swap.eli16.md
approved: true
approved-basis: "Operator-directed implementation in Slack conversation -1734007126 on 2026-07-22: trace current main, then fix the confirmed gap with full tiers and auto-merge."
review-convergence: "2026-07-22T20:08:05.697Z"
review-iterations: 3
review-completed-at: "2026-07-22T20:08:05.697Z"
review-report: "docs/specs/reports/proactive-default-account-swap-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Proactive Swap for Bound Default-Account Sessions

## Problem statement

The live anti-thrash pipeline in `ProactiveSwapMonitor` excludes every untagged
session even though the legacy path resolves an untagged session through the
default login. This leaves the primary interactive session on a hot account
until the reactive wall even when a much fresher same-framework account exists.
The production candidate list also includes headless/background sessions that
`SessionRefresh` cannot respawn because they have no Telegram or Slack binding;
their structured refusal is collapsed to `refresh-failed` and recorded as an
`execFailure`. Finally, the anti-thrash selector scores eligible targets by
use-before-reset rather than choosing the freshest (lowest-utilization) target.

## Proposed design

Extend the existing subscription-pool/proactive-swap path only:

1. Add an optional `refreshable` admission signal to the monitor's existing session view.
   Production wiring computes it from the same Telegram-first, Slack-second,
   memory-plus-disk binding resolution that `SessionRefresh` uses. Sessions
   known not to be refreshable never become proactive candidates. Absence of
   the optional signal preserves existing callers and tests. It is recomputed
   each tick and never replaces `SessionRefresh`'s authoritative execute-time
   binding lookup. Add the missing real
   Slack disk-backed reverse lookup so the classifier and `SessionRefresh`
   consult the same binding truth. Memory wins; disk is consulted only on a
   memory miss. Malformed/unreadable disk state yields no binding. A stale disk
   entry may admit an attempt, but execute-time resolution still refuses before
   kill when the route is unusable. The read does not mutate the registry.
   Dual-bound precedence is identical to `SessionRefresh`: Telegram memory,
   Telegram disk, Slack memory, then Slack disk. A higher-priority binding wins;
   lower-priority bindings are not combined. Within one transport memory wins
   over disagreeing disk state.
2. In the live anti-thrash path, resolve the default account once per tick and
   use it as the effective source for untagged refreshable sessions. The
   successful respawn is pinned to the chosen account through the existing
   `SessionRefresh` account-swap arguments; it does not create a new credential
   store or selection path and does not change the configured default login.
   Execute-time revalidation resolves the effective source again, so a default
   login change between decision and kill refuses as `intent-stale`. Concretely,
   the monitor passes `sourceWasUntagged` into the proactive scheduler call and
   the scheduler's existing anti-thrash revalidation hook becomes an async
   `resolveEffectiveAccountId(sessionName, sourceWasUntagged)` dependency. The
   server resolves a tag when present and otherwise calls the existing
   `InUseAccountResolver`; `SessionRefresh` is never called on mismatch. The swap
   ledger gains the accurate additive marker `sourceWasUntagged: true`;
   `defaultAccountChanged` remains absent because the default did not change.
   Identity comparison uses canonical pool account id; local/enabled state,
   framework, source pressure, and quota freshness are separately revalidated
   from the current pool snapshot.
3. Keep every existing eligibility floor: local execution, same framework,
   present/fresh quota reading, target ceiling, material improvement, per-tick
   pile-on cap, dwell, breaker, and work-in-flight pause. Among survivors,
   select the account with the lowest binding-window utilization. The named
   calculation is the existing `bindingUtilization(snapshot)`: maximum percent
   utilized across the known five-hour and seven-day quota windows. Percentages
   are already normalized by each framework's quota poller; an absent snapshot
   or window never passes the proactive reading-validity gate. This is the
   quota window constraining the session; every reading must meet the same age
   bound even if measured at a different instant. Reset urgency is intentionally
   secondary because this is pre-wall safety, not reactive draining. Use the
   existing score only as a deterministic tie-breaker, then account id for a
   stable final tie.
4. Preserve structured refresh refusal codes through `QuotaAwareScheduler` so
   a genuine execution refusal survives from `SessionRefresh`, through the
   scheduler result, into the swap ledger's `errorClass` instead of the generic
   `refresh-failed` bucket. A binding that disappears after admission is an
   honest structured execution failure; a session unbound at enumeration is
   excluded and creates no failure row.
5. Construct the scheduler and proactive monitor when either Telegram or Slack
   is present. Telegram attention remains optional and is injected only when
   available; account selection and refresh do not depend on that notification
   surface. This makes Slack-only installs use the same general mechanism.

This spec supersedes only candidate rule Q3 / invariant I10 in
`swap-continuity-antithrash.md`. That rule assumed moving an untagged session
mutated the machine's global default slot. The shipped refresh funnel instead
pins the respawned conversation to the selected account. The global default is
unchanged, so the original blast-radius concern does not apply. Every other
anti-thrash and continuity invariant remains in force.

## Acceptance criteria

- A bound untagged/default interactive session at or above the proactive
  threshold swaps before the wall when a fresher eligible same-framework
  account exists.
- The target is the eligible account with the lowest binding-window
  utilization, even when use-before-reset scoring would prefer another.
- The same source session holds when no fresher eligible same-framework target
  survives the existing ceiling and material-improvement floors.
- An unrefreshable running session is excluded before execution and creates no
  recurring `execFailure` row.
- Effective default source admission holds without execution when resolution
  fails, resolves outside the pool, is non-local/disabled, lacks a fresh quota
  reading, or cannot establish a same-framework source.
- Production wiring proves Telegram memory + disk bindings, Slack memory + disk
  bindings, Slack-only bootstrap, genuinely unbound exclusion, and a binding
  race whose concrete refresh refusal reaches the ledger.
- Negative binding tests prove Telegram wins a Telegram/Slack conflict, memory
  wins a same-transport memory/disk conflict, and malformed disk state excludes
  an otherwise unbound session without execution.
- Swapping one untagged session leaves the configured default resolver and any
  other untagged session unchanged.
- A boundary test resolves default A during decision, changes it to B before
  scheduler execution, expects `intent-stale`, and proves refresh is never called.
- Busy work still defers; reactive wall rescue remains unchanged.
- Unit, wiring/integration, E2E, typecheck, and full repository test tiers pass.

## Decision points touched

| Decision point | Classification | Rule |
|---|---|---|
| Proactive candidate admission | invariant | A proactive restart requires a conversation binding that the existing refresh primitive can route; known-unrefreshable sessions cannot succeed. |
| Untagged source resolution | invariant | An absent session account tag resolves through the existing default-account resolver once per tick, and re-resolves at the kill chokepoint. Unknown, non-pool, non-local/disabled, stale, or framework-unknown sources hold. |
| Target eligibility | invariant | Existing safety floors remain unchanged and are enumerated by the anti-thrash contract. |
| Target preference | invariant | The operator explicitly requires the freshest eligible same-framework account; lowest utilization is the direct measurable definition, with deterministic ties. |
| In-flight execution | invariant | Existing work gate remains authoritative: optimization defers or drops rather than killing live work. |

## Decision rationale

These are deterministic resource-routing invariants over structured state, not
semantic judgments over competing conversational signals. No new LLM arbiter is
appropriate.

Stale-decision taxonomy at execution remains the scheduler's existing one:
effective source id drift or source pressure subsiding returns `intent-stale`;
missing/hot/stale/non-local target or insufficient improvement returns
`target-revalidation-failed`; framework drift returns
`target-framework-mismatch`; a post-admission conversation-binding loss carries
the concrete `SessionRefresh` code into ledger `errorClass`. No case silently
reselects or calls refresh after a failed scheduler revalidation.

## Signal versus authority

Binding lookup and quota readings are signals. Candidate admission and target
selection remain within the existing proactive-swap authority, which already
owns the complete filter/score/verify pipeline and durable brake ledger. The
change does not add a parallel blocker or a second authority.

## Multi-machine posture

The behavior is **machine-local by design** because subscription logins and
conversation bindings are physically local to the machine that owns the
running session.

machine-local-justification: physical-credential-locality

No new durable store, URL, or user-facing notice is introduced. The existing
JSONL ledger schema receives one optional audit field (`sourceWasUntagged`),
which is migration-free and ignored by older readers. Existing swap ledger and
attention behavior remain machine-local and pool-read behavior is unchanged. A
session is evaluated only on the machine that can actually respawn it,
preventing two machines from acting on the same local tmux process.

Session identity for this controller is the process-local tmux name, qualified
in every ledger row by `machineId`; it is not treated as a globally unique
logical-session id. Shared/restored disk state can affect admission signals but
cannot let one host kill another host's tmux process.

Mixed-version readers already ignore unknown optional JSONL fields, so the new
audit marker is compatible without migration. Slack-only bootstrap uses the
scheduler's existing optional attention callback: without Telegram, only the
notice is absent; account selection and refresh authority remain available.

## Self-action convergence

The monitor remains level-triggered and bounded by its existing one-tick
non-overlap guard, maximum swaps per cycle, per-target cap, dwell, failure
   backoff, breaker, work-pause ceiling, and periodic tick. Excluding known
unrefreshable sessions removes an impossible repeated edge. Including the
default interactive session adds no unbounded edge: after success the respawned
session is tagged to the target and dwell prevents re-entry; without a target
the existing refusal state holds without execution.

## Rollback

Immediate operational rollback is disabling `subscriptionPool.proactiveSwap`;
do not use anti-thrash dry-run as rollback because that exposes the legacy
untagged path. Code rollback is a revert plus patch release. The optional JSONL
field needs no migration or repair; older readers ignore it.

## Standards Applied / Lessons Carried

- **Extend the existing authority:** candidate and target changes stay in the
  proactive monitor and anti-thrash engine; no parallel store or selector.
- **One refresh funnel:** every execution still passes through
  `QuotaAwareScheduler` and `SessionRefresh`, including Slack-only installs.
- **Structure over willpower:** production-wiring tests prove transport binding
  lookup and refusal propagation rather than relying on comments or mocks.
- **Fail safe around live work:** the existing work gate, dwell, breaker,
  execution revalidation, and level-trigger bounds remain mandatory.
- **Foundation audit:** manual inspection covered `ProactiveSwapMonitor`,
  `SwapAntiThrash`, `QuotaAwareScheduler`, `SessionRefresh`, Slack binding
  persistence, server bootstrap, and their wiring/E2E tests.

## Frontloaded Decisions

- Default-account interactive sessions are eligible only when the existing
  refresh path can route their respawn.
- “Freshest” means lowest valid binding-window utilization after all current
  safety floors, with existing score and stable id only as tie-breakers.
- No new store, operator control, or notification surface is introduced.
- The parent spec's Q3/I10 exclusion is replaced only because the actual
  per-session pinned respawn does not mutate the configured default login.

## Open questions

*(none)*

## 2026-07-22 amendment — login-loss trigger

A live refreshable session may enter the same proactive swap pipeline when its
effective source account carries the explicit, current login-loss evidence
`identityDrifted:true` plus either `repairState:owner-relogin-required` or
`actualAccountId:missing-local-login`. No other identity-drift state authorizes
a session mutation.

For untagged sessions, candidacy is correlated from the session's real
`CLAUDE_CONFIG_DIR`/config home, not from `claude auth status` (which is expected
to be unavailable after login loss) and not from a stale recorded account tag.
The exact source account is re-resolved from that real config home immediately
before refresh. The kill boundary then rechecks both source identity and the
owner-relogin-required episode; repair or movement in the sub-tick window makes
the intent stale.

Login loss bypasses only quota-source pressure and relative-improvement
arithmetic. The target must still be local, same-framework, non-drifted, freshly
measured, and below the existing ceiling. Refreshability, in-flight-work
hold, dwell, failure backoff, target-per-tick cap, overall cycle cap, ledger
availability, reversal detection, breaker, and exact-target execute-time
revalidation remain binding.

The extension has its own development-agent dark gate at
`subscriptionPool.proactiveSwap.loginLoss.enabled`. The key is omitted from
defaults; `dryRun:true` is seeded. A dry-run evaluates the exact live decision
and writes a `sourceTrigger:login-loss` would-swap row but never admits a
session kill. Real refresh requires an explicit `dryRun:false` promotion.
