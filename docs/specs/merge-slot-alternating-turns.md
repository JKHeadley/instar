---
title: "Bounded turns for Studio merge checks and ordinary full suites"
slug: merge-slot-alternating-turns
author: echo
status: draft
parent-spec: test-runner-concurrency-bound
parent-principle: Structure beats Willpower
ships-staged: true
supervision: tier0
lessons-engaged: [P1-structure-beats-willpower, P2-signal-vs-authority, P4-testing-integrity, P6-zero-failure, P19-no-unbounded-loops, P20-verify-the-state, P21-multi-machine-entity, bounded-blast-radius]
approved: true
approved-by: "Justin's explicit 24-hour implementation instruction in Telegram topic 130715, 2026-10-30 23:43 PDT; this is implementation authorization for the throughput plan, not a claim that he separately reviewed this spec."
delegated-scope: "Justin, Telegram topic 130715, 2026-10-30 23:43 PDT, approved a 24-hour throughput implementation plan; this is a candidate scheduling increment under that scope."
eli16-overview: merge-slot-alternating-turns.eli16.md
review-convergence: "2026-10-31T07:19:34.671Z"
review-iterations: 7
review-completed-at: "2026-10-31T07:19:34.671Z"
review-report: "docs/specs/reports/merge-slot-alternating-turns-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 1
cheap-to-change-tags: 1
contested-then-cleared: 0
---

# Bounded turns for Studio merge checks and ordinary full suites

## Problem and evidence

The default host cap is one full Vitest suite, and Studio currently enforces that cap. A merge-gate priority claim normally gives Local Verify the next slot. The fair-waiter refinement gives **every** ordinary waiter aged 15 minutes a higher tier than merge-gate work. With several aged ordinary waiters, a new long ordinary suite can begin after each release while Local Verify waits; a mere `mergeGatePriority.active` report does not mean the next slot belongs to the merge gate. Conversely, removing aging would recreate the previous ordinary-run starvation. On 2026-10-30 23:23 PDT, Studio had a progressing unrelated `test:all` suite holding its sole slot for over 90 minutes, four ordinary waiters, and a queued `main` verify. Peers were accepting PRs, but peers cannot verify `main` under `local-verify-capacity.md`.

The first capacity limit remains one full suite. This increment changes only who gets a free slot when both classes want it. It never stops a running suite, changes the tests selected, or treats a timeout as a pass.

## Decision

Under contention, **alternate classes at each successful enforcing suite admission**. If the last suite admitted was ordinary and a live merge-gate waiter is acquiring with its own live child claim, the next free suite slot is offered to that waiter for a bounded handoff. If it has not admitted within twelve seconds of the first observed free slot, the next eligible poll by the merge child or an aged ordinary waiter wins; the same ticket cannot restart the offer. If the last suite admitted was merge-gate and an ordinary waiter is aged at least 15 minutes, the next slot goes to the oldest aged ordinary waiter. Without an aged ordinary waiter, live merge-gate work wins as today. A coordinator claim without a live child-claim-backed merge waiter follows today's aged-waiter policy. This change does not preempt a holder; inherited TTL reclamation or fail-open behavior may still allow overlap. The turn rule applies only at the next healthy free-slot admission.

This gives each class at least every other admission **while a child-claim-backed merge waiter and an aged ordinary waiter both remain live, metadata is valid, all actual admissions use this policy, and the selected process polls within the twelve-second handoff**. A paused merge child may miss its turn, and the first-poll rule after expiry may let a merge child beat an ordinary waiter between its polls; those events are excluded from strict alternation claims and counted. The added reservation lasts at most twelve seconds from the first observed free-slot decision; the existing 5±1-second polling cadence can delay the next ordinary attempt by up to another six seconds when that process stays runnable. It bounds consecutive *turns*, not wall time: one suite can still run a long time. Ordinary acquisition has a default 45-minute timeout, so a suite lasting over 90 minutes may erase the entire waiting line; launcher retry and timeout loss must be measured separately. A claim is a demand signal, not proof that a merge child is runnable. The Local Verify child already creates its own PID-bound claim before `acquire()`; the upgraded semaphore registers its merge waiter ticket before its first admission attempt. A merge ticket without that same child's live claim loses merge priority immediately. Retries begin a new waiter age unless the launcher explicitly carries the original age; the initial version keeps the current new-age behavior and reports retries separately.

### Atomic admission metadata

The host semaphore records `{v:1, hostname, last:'ordinary'|'merge-gate', grantedAt, grantId}` as optional top-level metadata in the **same atomic holders-file write** that creates a suite holder. The metadata is never user-editable through an HTTP route. It is evidence of the last successful host-limiter-enforcing suite admission among upgraded writers, not a completed test. A free-slot episode record `{episodeId, startedAt, offeredTicketId, handoffState:'unused'|'offered'|'consumed'}` lives in that envelope. At the first free-slot decision, one merge ticket may receive a twelve-second offer. Expiry or loss of that ticket/claim marks the **episode** consumed; a new ticket cannot restart the deadline while the slot remains free. After expiry, the first eligible poll by a merge child or the oldest aged ordinary waiter wins; young ordinary suites still follow the existing coordinator-claim reservation. A successful suite admission ends the episode; a later occupied-to-free transition starts a new one. Repeated polls never refresh `startedAt`.

Every upgraded holders write also writes a small proof sidecar under the same lock after the atomic holders write. The sidecar records the new file's device, inode, ctime, mtime, size, and content digest. A reader accepts the turn and episode metadata only when the current holders file matches that proof. A crash between the two writes, proof-write failure, or a legacy writer that rewrites holders while erasing **or preserving** unknown fields produces an invalid proof and falls back to the existing aged-waiter policy; the acquired test remains admitted. A legacy process that writes without the shared lock is outside the parent semaphore's contract. The proof is a validation witness, never an independent admission authority. On **every** upgraded write, an invalid input holders/proof pair discards the old turn and episode before writing the new holders file and proof; release, prune, and targeted writes cannot launder stale history into a new valid proof. Only a subsequent eligible cap-one suite admission establishes new turn history. Upgraded release, prune, and targeted-lane writes preserve turn metadata only when their input proof was valid. Missing, invalid, unreadable, or future-version metadata or proof falls back to the existing policy. A holders-file write failure follows existing acquire failure behavior and never claims a successful admission.

The turn decision is made under the same lock as the holder count and ticket comparison. The **host limiter posture** (`enforcing` versus `dry-run`/`off`) and the **alternating-turn feature mode** (`enforce` versus `observe`/`off`) are separate controls. Metadata is updated for every host-limiter-enforcing cap-one suite admission, including uncontested admissions made while alternating turns are off or observe, so later feature enforcement has current history. Targeted runs, release, and prune preserve it. A dry-run or cap-above-one admission that writes holders invalidates turn history; returning to cap-one enforcement first uses unknown/aged-waiter fallback until a new eligible admission establishes it. A legacy actor may use the old order while mixed versions run. Its **atomic holders rewrite under the shared lock** invalidates the proof, which is detected at the next upgraded read even if it preserved unknown fields. **Before enforcement on each host, inventory running test processes and the semaphore code each active checkout/direct Vitest launcher actually loads, wait for old processes to drain, then activate upgraded launchers.** A later legacy process using the holders write contract triggers proof mismatch and fallback; fairness claims exclude those intervals. Feature enforce is eligible only when host limiter posture is enforcing and resolved suite cap is exactly one.

An `off` or unwritable/fail-open admission may leave holders and proof untouched. No reader can infer that invisible event from those files. Such bypasses are **outside the turn-history and one-slot guarantee**; the feature never labels a bypass as a verified alternating admission. A fail-open path writes the existing witness when possible; upgraded readers seeing a live witness mark turn history unknown. If witness persistence also fails, correctness cannot be reconstructed after recovery without an external audit; the status reports the last validated file state but expressly does not certify absence of bypassed admissions. A successfully written fail-open witness also writes a best-effort persistent turn-invalidation marker unique to that witness. Upgraded readers keep turn history unknown while any marker exists, even after its witness disappears; the next healthy cap-one suite admission without a live witness establishes fresh history and clears only markers present before that admission, so a concurrent new bypass cannot be erased. If witness or marker persistence fails, lack of a marker is not proof of no bypass. A host with observed bypasses returns to feature `off` and restarts observe after a healthy interval. The existing fail-open behavior remains a deliberate availability choice of the parent semaphore and is surfaced as degraded, never counted as evidence for fairness.

### Exact selection table

| Live acquiring merge waiter and claim | Aged ordinary waiter | Last valid admitted class | Next class |
| --- | --- | --- | --- |
| no, no coordinator claim | either | either | ordinary FIFO |
| no, live coordinator claim only | yes | either | existing aged-ordinary-first policy |
| no, live coordinator claim only | no | either | existing claim reservation for young ordinary suites |
| yes | no | either | merge-gate; young ordinary suites still yield |
| yes | yes | ordinary | merge-gate |
| yes | yes | ordinary, episode consumed by expiry or offered-ticket/claim loss | first eligible poll by merge or oldest aged ordinary |
| yes | yes | merge-gate | oldest aged ordinary |
| yes | yes | absent/invalid | existing aged-ordinary-first policy |

The selected class is implemented both in the suite waiter ordering and in the ordinary `priorityWait` claim check. An aged ordinary ticket may ignore a live claim on its ordinary turn, whenever no live acquiring merge waiter exists, or after that waiter's twelve-second handoff expires; after expiry, there is no reservation **between classes**, but ordinary FIFO still selects the oldest aged ordinary ticket among ordinary pollers. A merge-gate acquisition must see the same ordering under the lock and have the child's own live claim; an expired claim downgrades its ticket in the next locked decision and the child requeues or fails closed if renewal fails. Compute the claim and bounded ticket set once per locked decision, retaining the current 64-file bounds; do not add process spawning or a second full scan under lock. The guarantee applies only to accepted tickets inside this bound: if 64 live tickets fill the directory, a new requester cannot gain a fairness ticket, follows the existing bounded barging fallback, and emits an overflow event. Observe telemetry emits one counterfactual event for each eligible free-slot admission with two visible classes and one episode outcome, linked by episodeId; a proposed merge offer is labeled `not-applied-observe` when the ordinary class actually admits. Enforcing telemetry emits an offer event and one offer outcome (admitted, expired, claim lost, or bypassed after a write failure) for each persisted offer, plus an episode outcome when a class admits; it never logs each blocked poll. Events include contender classes, prior class, selected class, actual winner, and eligibility reason. A paused ordinary ticket can still delay a merge child under inherited ordinary FIFO until its 60-second lease expires; measure that separately from the twelve-second merge offer. The status route shows metadata validity and a momentary advisory `nextSuiteClass` only when both live sides are visible; unknown stays unknown and never authorizes a merge.

## Rollout and rollback

Add a host tuning field `alternatingSuiteTurns` with `off|observe|enforce`; default `off` on every host. `observe` computes and logs a counterfactual without changing admission; it must label dry-run over-admissions and fail-open admissions as ineligible, never count them as fairness evidence. Enforce degrades to observe if posture/cap prerequisites cease to hold; metadata loss causes aged-waiter fallback for that admission and an unknown-cause event unless a specific cause is established. An explicit `off` restores the previous aged-waiter policy immediately. Keep the targeted lane and merge authorization unchanged. The installed CLI/config awareness and update path must describe the new tuning field; existing agents remain on `off` unless deliberately enabled.

## Maturation plan

- **dark-window:** Keep the feature dark on the fleet for a bounded 48-hour window while focused unit, child-process fault injection, integration, lifecycle, and full-suite checks pass. Record the window and test evidence.
- **test-agent-live:** Rehearse on an isolated test agent with enforcing cap one, ordinary and merge child processes, stale claims, a lost child, a paused merge child, a paused ordinary child, ticket churn within one free-slot episode, a legacy writer preserving unknown fields, and a simulated >45-minute holder using accelerated clocks. Require a fixed twelve-second reservation plus at most one ordinary poll interval for a runnable waiter, proof mismatch fallback, and no over-admission.
- **dev-agent-live:** On Echo, the development agent, enable observe on Studio and record at least 24 hours of admission, queue wait, claim-only idle time, timeout/retry loss, and fallback events. Compare counterfactual choices only for eligible host-limiter-enforcing admissions. Before feature enforcement, inventory every active checkout and direct Vitest launcher to verify the semaphore code it actually loads, then wait for older processes to drain; package version alone is insufficient. Then enable feature enforce on Studio if coherent and monitor a second 24-hour window; roll back on over-admission, increasing free-slot idle time, repeated metadata loss, or worse eligible admission share. Echo's Mini and M5 are peer machines of the same development agent; they remain off until each host repeats the evidence path.
- **fleet:** After the development agent graduates, offer the feature as opt-in to other Instar agents, first in observe then enforce on each host. No automatic fleet flip.
- **graduation criterion:** A fleet candidate needs an explicit development-agent record of healthy one-slot enforcement, at most a twelve-second added reservation plus one ordinary poll interval per handoff, eligible admission opportunities shared as specified, and improved merge queue latency over a comparable sample. Report elapsed ordinary waits and timeout/retry loss separately, including the new-age retry rule.

## Acceptance

1. Unit tests cover every row of the table, a sequence of ordinary/merge/ordinary under contention, stable FIFO among ordinary tickets, and a newly arriving merge claim after a long ordinary run.
2. Unit tests cover absent/corrupt/foreign/future-version/clock-skewed/oversized metadata and proof, holders/proof write failure, both legacy behaviors (erase and preserve stale metadata), stale metadata followed by upgraded release/prune/targeted writes without laundering, stale and mismatched claims/tickets, dry-run/cap-change/off/observe and quarantine branches, claim-only fallback, paused merge child and ticket churn within one fixed twelve-second free-slot episode, several ordinary polls after expiry, 64-ticket overflow, and ordinary timeout before holder release. A fail-open with no writable witness must be explicitly outside fairness status; a visible witness forces unknown history. Every healthy enforcing-cap-one compatible-writer case preserves the one-suite cap and an honest fallback.
3. Integration test uses two real semaphore processes and the authenticated `GET /test-runner-limiter` route: under contention, metadata and route agree on who wins; targeted tests remain independent; observe/off modes do not change admission. Fault injection covers a child dying immediately after the atomic holders write before its proof, plus a legacy child preserving metadata on its own holders rewrite. A focused contention benchmark verifies the additional stat/digest/proof write stays within the existing lock budget; sidecar write failure remains fail-open for tests and unknown for turns.
4. E2E boot through the production AgentServer wiring sees the tuning mode and status, and a queued Local Verify `main` can take its turn after one ordinary suite while another aged ordinary waits. A red or timed-out `main` cannot authorize merge.
5. Full build and `npm run test:all` are green. Live rollout first proves observe, then enforce on Studio; before/after queue wait and ordinary wait are reported, with the small sample stated.

## Multi-machine posture

The suite slot, holder envelope, waiter tickets, claims, and tuning are **machine-local by design**: each controls tests on one physical host for Instar actors sharing the same OS-user home. Separate user homes do not share this rendezvous. Studio, Mini, and M5 each arbitrate only their own capacity. The coordinator's merged PR queue remains the pool-wide view; a host's status is a labeled observation of that host, never a pool-wide admission promise.

machine-local-justification: hardware-bound-resource

## Frontloaded Decisions

Justin authorized the 24-hour throughput implementation scope in Telegram topic 130715 on 2026-10-30 23:43 PDT. The feature ships dark and is cheap to change after because `alternatingSuiteTurns: off` restores the existing policy without changing PR records, merge authority, or external state. The twelve-second handoff is a reversible host tuning implementation choice within that scope. No user decision is required mid-build. Compatibility with old host processes is an explicit rollout limitation; the host cutover audits versions before activation.

## Open questions

*(none)*

## Decision points touched

| Decision point | Class | Why |
| --- | --- | --- |
| Host suite admission and handoff | invariant | The single physical slot, class turn, fixed deadline, and fallback require deterministic shared-lock arbitration; an LLM decision in the hot path would add latency and disagreement. |
| Live merge claim and waiter eligibility | invariant | PID, lease, and ticket evidence are typed process facts. Unknown or expired evidence loses priority; status is never authority. |
| Metadata validity and unknown fallback | invariant | Invalid or uncorroborated history must use the existing aged-waiter policy; a probabilistic answer cannot safely choose a turn. |
| Rollout tuning and rollback | invariant | The operator-controlled `off|observe|enforce` switch and host-limiter prerequisites are explicit; `off` restores the prior policy. |
