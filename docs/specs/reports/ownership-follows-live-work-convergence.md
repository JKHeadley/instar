# Convergence Report — Ownership Follows Live Work (release-on-complete + claim-on-spawn + double-dispatch recovery gate)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in every round (rounds 1–3, all
`status: ok`), and a Gemini-tier pass (gemini-cli:gemini-2.5-pro) ran in rounds 1, 2, and a round-3
retry — also `status: ok`. Both external families gave a genuine outside opinion on the converged body.
This is the clean RAN state. (Round-3's first gemini invocation returned empty output once — a transient
degraded call — but the retry on the same round-3 body succeeded, and codex ran clean every round, so
the spec received real cross-model review of its converged content.)

External verdict trajectory:
- **codex-cli:gpt-5.5** — round 1: SERIOUS ISSUES → round 2: MINOR ISSUES → round 3: MINOR ISSUES.
- **gemini-cli:gemini-2.5-pro** — round 1: MINOR ISSUES → round 2: MINOR ISSUES → round 3: MINOR ISSUES.

The remaining round-3 external findings are cosmetic (terminology density — mitigated by the ELI16
companion) or hardening explicitly deferred as separate work (a registry-error circuit breaker; naming
the heartbeat/liveness mechanism as a soak dependency) — none required a spec change to converge.

## ELI10 Overview

This change fixes how the agent — running across more than one of Justin's computers — keeps track of
which machine is currently serving each conversation. Each conversation ("topic") has an ownership
record, a name tag that says "machine X owns this." Other machines read that tag to decide whether to do
the work or stay out of the way. The previous fix (PR #1258) stopped the worst harm: it stopped the
reaper from killing a live worker just because the name tag had gone stale. But it only *defended
against* a stale tag — it didn't stop the tag from going stale in the first place.

This spec removes the staleness at its source, in three small, independent places: **(A)** when a
session finishes, the machine that owns the topic takes its own name tag down ("released") instead of
leaving it stuck on "active" forever; **(B)** when the agent spawns an autonomous worker for a topic,
that machine claims the name tag so ownership follows the live work onto it; and **(D)** when a recovery
path (a sentinel restarting a wedged/stuck session) is about to re-run a topic, it first checks the name
tag — if another machine owns the topic, it forwards instead of re-running, so the same message can't be
answered twice.

All three ship behind one OFF-by-default flag that is live only on Echo's development machines and dark
on the fleet, so nothing changes for normal users until it has soaked and been promoted. Every ownership
write goes through the existing fenced compare-and-swap (a numbered "this is newer" check that makes
stale writes lose safely), and every part fails in the safe direction — A and B withhold a write when
uncertain; D withholds a local re-run when another machine owns the topic. The one deliberate exception,
named honestly rather than hidden: if the ownership registry itself can't be read, the recovery path
re-runs locally (a dead conversation is worse than a rare double-reply) — and that path is instrumented
with telemetry and gated to zero-or-counted before the flag can ever be promoted fleet-wide.

## Original vs Converged

The original spec was already unusually rigorous and well-grounded (every code anchor verified against
the real source). Review changed it in several load-bearing ways:

- **Honesty about "fail-closed."** The original called the whole feature "fail-closed everywhere." Three
  independent reviewers (codex, gemini, and the live conformance gate) caught that Part D's
  registry-read-error path actually *re-runs locally* — which is fail-OPEN, the exact condition where the
  machine knows least about peer ownership. The converged spec renames this honestly as a mixed
  direction, labels the one fail-open branch as such, and adds a mandatory telemetry row
  (`recovery-gate-registry-unknown`) plus a hard fleet-promotion gate requiring that path's
  double-dispatch count to be zero-or-counted. "Registry errors are rare enough to justify this" became a
  measured fact instead of an assumption.
- **A same-machine race the original missed.** The adversarial reviewer found that on ONE machine, an
  old session completing (Part A's release) could clobber a *new* session's ownership of the same topic
  ("released record, live session"). The converged spec adds a session-identity guard: Part A releases
  only when no DIFFERENT live session (compared by the session's stable `startedAt` instance key, not the
  reusable tmux name) is bound to the topic — and withholds the release if instance identity can't be
  proven.
- **Underspecified decisions made concrete.** The original left several implementer forks implicit: the
  nonce could collide within one millisecond (now a shared `ownershipNonce()` helper with a counter +
  UUID); the Part D forward path was "reuse route()" hand-waving (now a precise
  `forwardPendingInboundViaRoute(topicId): { forwarded, nonePending }` dep delegating to the existing
  FIFO durable-queue drain); the reachability check could throw with no defined branch (now mapped to the
  unreachable-peer withhold); the two recovery gates could use divergent reachability reads (now ONE
  shared injected helper); the `recoverStuckMessages` skip granularity was ambiguous (now explicitly
  per-topic, leaving messages queued).
- **The foundation surfaced.** The lessons-aware reviewer required the spec to state explicitly that it
  RESTS ON the existing CAS-replication being sound, and that PR #1258's snapshot gate stays the defense
  during the mixed-fleet soak — its retirement is evidence-gated on zero orphaned-record incidents, not
  on this merging.
- **Honest bounds.** Claims like "converges within one reconciler interval" were weakened to "bounded by
  the existing reconciler/failover policy" (force-claiming a live-but-wrong peer needs death-evidence, so
  it can exceed one tick). An alternatives tradeoff (explicit release/claim vs lease-TTL vs evented) was
  added to justify the incremental choice, including that explicit release does NOT cover
  crash-before-complete (the existing reconciler does, more slowly).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | codex (SERIOUS), gemini (MINOR), conformance gate, adversarial, decision-completeness, security, lessons-aware (scalability + integration: no blockers) | ~12 (deduped) | One coherent edit: honest fail-open labeling + telemetry; Part A session-identity guard; Part B bounded-degraded-state contract; Part D forward-payload spec; isOwnerReachable-throw branch; shared reachability helper; nonce helper; foundation-assumption section; alternatives tradeoff; mixed-fleet + new tests; FD9/10/11 added (8→11) |
| 2 | codex (MINOR), gemini (MINOR), conformance gate (pre-tag-state only) | 4 precision (tmux-name reuse, "one interval" overclaim, forward count/ordering, not-yet-bound interleaving) | All 6 internal angles returned CONVERGED; round-3 tightening edits applied: instance-id compare, weakened reconciler bound, precise forward signature, not-yet-bound lock test |
| 3 | codex (MINOR — cosmetic/hardening), gemini (MINOR — cosmetic/hardening), conformance gate (pre-tag-state only), internal tightening-verification (CONVERGED) | 0 material (1 real correction: `session.uuid` doesn't exist → use `startedAt`, applied) | `startedAt` instance key + fail-closed-if-absent; FD11 "one interval" contradiction removed; type-agnostic compare. No new design surface. |

Standards-Conformance Gate: ran each round (round 1: 1 finding — Cross-Machine-Coherence registry-error
double-dispatch, folded in; rounds 2–3: 2 findings, both pre-tag-state artifacts — empty
review-convergence/iterations while approved:true, and Know-Your-Principal on the blanket pre-auth —
neither a design finding; both resolve at tag-write / are covered by the disclosed approval provenance).
Parent-principle fit verdict: `fit` (parentResolved: true) every round.

## Full Findings Catalog

### Round 1 (material findings and resolutions)

1. **[material] Part D registry-error path is fail-OPEN, not fail-closed** (codex#1, gemini#3,
   conformance gate, adversarial-D1, security#3). Resolution: relabeled honestly as mixed-direction;
   `ownerOf`-throw → fail-open re-run, named as such; mandatory `recovery-gate-registry-unknown`
   telemetry; fleet-promotion criterion (e) gates it to zero-or-counted. Persistent-failure degenerate
   case noted.
2. **[material] Same-machine A∥B: release-on-complete clobbers a fresh claim for a NEW session**
   (adversarial #1 — strongest finding). Resolution: Part A session-identity guard (FD9) — release only
   when no different live session (by stable `startedAt` instance key) is bound; withhold if unprovable.
3. **[material] Part B failed-claim leaves a live local session with no ownership = split-brain shape**
   (codex#2, adversarial-B1, lessons-C3). Resolution: named as a BOUNDED, self-healing degraded state
   (FD11) — inbound routes to the record-owner so no double-handle; converges via the existing
   reconciler; no new retry loop (P19).
4. **[material] Part D forward payload underspecified** (codex#3, adversarial-X1,
   decision-completeness#7). Resolution: precise `forwardPendingInboundViaRoute` dep + message identity
   (existing per-event-id ledger), no-pending-inbound case, route() as an injected dep.
5. **[material] isOwnerReachable throw/indeterminate has no defined branch** (adversarial#2,
   decision-completeness#3). Resolution: maps to the unreachable-peer branch (withhold), distinct from
   `ownerOf`-throw; FD4 updated.
6. **[material] Reachability re-check timing + unification across the two Part-D gates**
   (decision-completeness#3/#4). Resolution: ONE shared injected `isOwnerReachable` helper; entry-time
   check sufficient because route() re-resolves the owner at dispatch.
7. **[material] Decision-completeness implicit forks** (event-ordering, spawn success boundary, nonce
   collision-resistance, audit-row schema, recoverStuckMessages granularity). Resolution: each resolved
   in-spec (handler order-independent via the guard; bounded-degraded contract; `ownershipNonce()`
   helper; fixed `{ts, topicId, decision, reason}` schema; per-topic skip granularity).
8. **[minor] Nonce same-millisecond collision** (security#1, decision-completeness#5). Resolution:
   shared `ownershipNonce()` with process-monotonic counter + randomUUID (FD10).
9. **[minor] CAS-replication foundation assumption should be surfaced** (lessons-C1). Resolution: explicit
   "Foundation assumption" section; snapshot-gate retirement evidence-gated on zero orphaned records.
10. **[minor] Mixed-fleet asserted-not-proven** (codex#5, lessons-C4). Resolution: explicit mixed-fleet
    test cases (ON-owner vs OFF-peer; OFF-owner vs ON-recovery; ON-respawn vs OFF-transfer).
11. **[minor] P18 audit-row finalization** (lessons-A4). Resolution: telemetry emitted at the decision
    point with a fixed schema; gated in fleet promotion.
12. **[minor] D2 unbounded queue on a long-dead peer** (adversarial-D2). Resolution: pointed at the
    existing durable-inbound-queue TTL + loss-notice as the bound (not a new mechanism).

Scalability (round 1) and integration (round 1) reported NO blockers — integration verified every
flag/DEV_GATED_FEATURES/types/no-migration/cas-emit-placement-lint claim against the real source.

### Round 2 (precision findings, all folded into round-3 tightening)

- codex#3 / adversarial / security note: tmux-name reuse in the session-identity guard → use a stable
  instance key.
- codex#2 / gemini#1: "bounded by one reconciler interval" overclaims → weaken to existing
  reconciler/failover policy.
- codex#1: forward dep needs a precise count/ordering signature.
- decision-completeness note: new-session-not-yet-bound interleaving → lock test + clarification.

All six internal angles returned CONVERGED in round 2 (adversarial, decision-completeness, lessons-aware,
security, integration; scalability had no findings).

### Round 3 (tightening; 0 material)

- Real correction: `session.uuid` does not exist on the `Session` type (confirmed by source grep) →
  changed to `session.startedAt` (the real stable instance key) with fail-closed-if-absent and a
  type-agnostic comparison. FD9 + the code block + the Tier-1 tests updated.
- FD11 "within one interval" contradiction removed (aligned with the weakened Part B wording).
- Remaining external findings (terminology glossary; registry-error circuit breaker; naming the liveness
  mechanism as a soak dependency; mixed-fleet telemetry breakdown by gate ON/OFF) are cosmetic or
  hardening explicitly out of this PR's scope — non-material to convergence.

### Deferred to a separate PR (acknowledged-as-separate, not convergence blockers)

- The evented/push-based ownership lifecycle and the per-topic lease-TTL (both named in Out of scope).
- PR #1258's reaper closeout itself (already shipped/armed) — this spec does not touch SessionReaper.ts.
- A registry-error circuit breaker (gemini r3 hardening suggestion) and explicitly validating the
  heartbeat/liveness mechanism's sensitivity under load (gemini r3) — sensible follow-on hardening for
  the soak, not required to converge the A/B/D record-correction.
- A terminology glossary (codex/gemini cosmetic) — the ELI16 companion is the sanctioned bridge for
  external readers.

## Convergence verdict

Converged at iteration 3. The new round produced no material findings (both externals MINOR with only
cosmetic/hardening items; the conformance gate's only flags are pre-tag-state artifacts; the internal
tightening-verification returned CONVERGED with the single real correction — `startedAt` not `uuid` —
applied). `## Open questions` is `*(none)*` and contains no live user-decision. The ELI16 companion is
present (5,599 characters). Spec is ready for `/instar-dev` build.

## Approval provenance (disclosed)

`approved: true` rests on the operator's explicit standing mission pre-authorization on topic 27515 (24h
autonomous mesh mission — "pre-approval for any decisions or specs needed; do NOT stop or wait"), Tier 2.
This is the same standing-authorization basis used for PR #1257 and PR #1258 in this session. The
conformance gate's Know-Your-Principal flag on the blanket pre-approval is acknowledged: the approving
principal is Justin's verified standing authorization (the same verified-operator basis as the sibling
PRs this session), not a name read from content. To be disclosed in the PR body and the Telegram cadence.
