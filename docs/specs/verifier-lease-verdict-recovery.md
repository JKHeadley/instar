---
title: "Recover verification verdicts after lease movement"
slug: verifier-lease-verdict-recovery
parent-principle: "Structure beats Willpower"
parent-spec: docs/specs/local-verify-queue-controls.md
approved: true
approved-by: "Chief of Staff, 2026-11-24 10:20:43 PST, explicit priority admission on ambiguity"
eli16-overview: docs/specs/verifier-lease-verdict-recovery.eli16.md
review-convergence: "2026-11-24T18:23:23.467Z"
review-iterations: 6
review-completed-at: "2026-11-24T18:23:23.467Z"
review-report: "docs/specs/reports/verifier-lease-verdict-recovery-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
---
# Recover completed verification verdicts after a lease change

Chief requested this card at 08:13:04 PST on November 24. PR 3745 head 6ee167dc passed all three lanes against 8d0ee94f. Its journal write succeeded at 15:45:50 UTC. Both status-post triggers skipped publication because the acquired epoch was 23783 and the observed epoch was 23784. Main had moved to a5c812a5.

On lease acquisition, recover completed verdicts whose GitHub status publication is outstanding. Re-evaluate the current head, the recorded base, main health and the usual status rules under the acquired epoch. Post a verdict only when those rules allow it. When main has moved and a replacement run is required, request priority admission for the same still-open head. Preserve holds and deduplicate recovery across lease renewals, concurrent reconciliation and restarts.

Regression: persist a complete passing verdict, advance the lease epoch between the write and the post, and restart. Verify publication under the new epoch for an eligible record. When projection refuses specifically on the changed base and priority admission is authorized, verify exactly one replacement run.

Incident outcome: the active holder posted success for PR 3745 after main recovered and repository settings became readable. That PR needs no replacement or author refresh. The following behavior applies to future incidents.

## Existing behavior and reproduction

The current status reconciler already audits an interrupted publication as post-skipped-lease. Its acquisition handler clears the observed status cache and its next pass reads open heads from GitHub. The regression in tests/unit/localVerify/StatusReconciler.test.ts covering an epoch change at an event-driven post exercises this same-process recovery. Add a cold-start case that reconstructs the service from its persisted journal and exercises the production status listing against the saved result.

LocalVerifyService.request currently returns a successful record before considering the operator's priority admission. An unchanged head with a changed base therefore receives recorded even when the operator needs fresh verification. Limit explicit replacement admission to an authorized priority request with a different resolved base. Preserve ordinary reuse and same-base deduplication. On restore, compare the queued replacement's base with the recorded success before dropping it. Test this at the HTTP entry point and across restart. If the host has already verified the requested execution inputs, reuse its normal execution-key checks.

For automatic recovery, attempt ordinary status projection first. A healthy main can authorize an earlier-base result. A repository settings read error, independent review requirement, or operator hold cannot be repaired by queueing a run. Apply priority re-admission only to an outstanding completed verdict blocked specifically on base, using the current holder's gates and respecting all queue limits. Supersession, successful publication, or an existing queued or running replacement resolves the recovery intent idempotently.

## Recovery ownership and crash boundaries

The existing periodic status pass owns re-evaluation when main changes within the same lease epoch. Test acquisition while main is pending, then a green main with no new lease or PR event. In the first fixture, projection accepts the previous result and requests no replacement. In the second fixture, a resolved current base differs, the main-health repair rule refuses the prior base, and the operator authorizes a replacement.

Once a replacement is admitted, persist the invalidation of that prior verdict for projection. Use the normal verification queue's single-writer admission boundary. A single durable transition must describe both the reservation and the execution inputs that supersede the previous result. On restart before launch, restore the reservation; after launch, follow existing interrupted-run handling. A cached old success must remain in the audit journal but cannot become the published result even if main turns healthy before the replacement finishes. Concurrent requests for the same PR, head, and target base must converge on the same admission, including if either caller retries after the process exits. Test concurrency, a restart immediately after admission, and the green-main transition while the new run is in flight.

## Decision points touched

- Publication eligibility — invariant | basis: external-constraint | evidence: GitHub accepts commit-scoped statuses and cannot condition them on the sender lease. Eligibility is derived from the existing projector, the lease epoch, and the persisted replacement state.
- Admission priority — invariant | basis: enumerable-domain | evidence: Only the front route expresses explicit priority for an existing successful head. Admission is governed by the existing operator-front and capacity controls. A failed settings read leaves the existing settings hold active.

## Multi-machine posture

The active coordinator owns the same queue, journal, lease fencing and restart behavior as other verification requests. A new lease holder that lacks the prior record or the replacement state must withhold success until the inputs can be verified. Publication is shared through the existing GitHub status channel.

## Publication ordering

GitHub commit statuses are append-only. A status already sent may arrive after the lease changes. This change provides eventual correction under the active holder. Reuse the existing per-head serialized publication path. After replacement admission request a fresh projection, which supersedes a late prior status. The merger retains its own verification checks at the time it considers the PR. Exercise admission while an earlier post is awaiting a GitHub response, then drain reconciliation and inspect the final visible status.

A takeover by a different machine continues through the existing takeover flow that marks main health suspect and checks local evidence. This change does not import a predecessor's local recovery state or journal. When the new holder has no authoritative evidence for this head and current base, it must schedule fresh verification before it authorizes success from recovery. Cover this by providing the predecessor's old-base receipt and no receipt for the new holder's current base after a foreign takeover. A same-machine restart restores its durable queue before running status reconciliation.

Across holders, the active holder's ordinary periodic pass compares GitHub's latest status with its current projection and corrects mismatches even if a predecessor's late status lands last. Exercise two holders with reversed delivery order and a later ordinary pass, without another PR or lease event.

A crash after replacement launch and before completion follows the coordinator's durable interrupted-attempt path. An interrupted attempt must have an explicit terminal error receipt or one restored retry. An absent process alone never makes its superseded success eligible. Cover a restart at the point where the durable queue says the run was launched and the process is gone.

Determine whether base is the sole blocker by evaluating the existing full set of projection inputs, including the effective repository floor and shared-head status, with only the candidate base aligned to current main. Request admission only if that hypothetical projection is authorized success and the real one has the specific main-health/base refusal. The hypothetical evaluation never authorizes a status post. Test a changed base with an unreadable settings hold; admission must wait, and the periodic pass must reevaluate after settings become readable.

## Recovery completion

Recovery targets convergence of the visible status for the repository, commit SHA and context. A matching existing status from the accepted producer completes an intent even if the local acknowledgement was lost. Future changes to main alone cannot resurrect completed recovery intent. The normal periodic pass still reevaluates the visible status under current conditions. Exercise a pre-existing matching success and an accepted publication whose acknowledgement is lost; neither incurs a replacement on a later main advance.

The coordinator's existing projectHead function owns the sole status projection across all open PRs sharing a SHA on main. Use its aggregated decision for ordinary posting, recovery and any late-post correction. Two open PRs with the same SHA, one blocked, must converge on the shared pending result across repeated passes, with no replacement run started solely to clear the unrelated blocker. The queue control setting and live lease remain mandatory for automatic priority admission. If either is absent, emit the refusal reason for the normal operator report, leave the verdict intact, and let the periodic status pass continue.

If main advances before a cold-start holder learns whether the previous success reached GitHub, resolve prior delivery from the accepted producer's status history for this exact head and verdict. A visible matching success closes delivery intent. Correct any newly conflicting projection through ordinary reconciliation. If delivery history is unreadable or ambiguous, recover conservatively through normal status reconciliation and avoid automatic replacement until the operator requests one.

Keep one outstanding run per PR and head. If main advances again while a replacement is queued, normal queue base refresh updates that reservation and revalidates the base at launch. After launch, preserve the execution's exact base. A later run waits for the earlier execution to terminate or cancel. An out-of-order result from a superseded attempt cannot authorize a status or overwrite the latest record; use the verifier's existing attempt-token and peer-lease acceptance checks. Cover the queue and in-flight cases and a late receipt for a superseded attempt.

## Open questions

None.

## Convergence disposition

At 10:20:43 PST on November 24 Chief approved explicit priority admission when identical success statuses make the original attempt ambiguous. On ambiguity, ordinary status reconciliation continues and the priority route accepts a fresh current-base run only when explicitly requested. The six independent review receipts and the original failing test are stored in the throughput project's lease-recovery-review report directory.

## Maturation plan

- **ladder:** local-verify-queue-controls
- **test-agent-live:** exercise priority admission and cold restore in an isolated verifier.
- **dev-agent-live:** after publication, use the Studio operator queue to front a previously green changed-base candidate with an ambiguous status history.
- **fleet:** the coordinator retains sole queue ownership through the existing queue-controls setting.
- **graduation criterion:** observe a single complete current-base replacement and an authorized status under the active holder.
- **dark-window:** from merge until the coordinator installs the release.
