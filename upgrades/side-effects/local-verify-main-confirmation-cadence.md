# Side-effects review for Local Verify main confirmation and cadence

Second-pass reviewer: independent main-health review. Concurred after the scheduler was changed to promote an existing queued main check when local corroboration becomes due.

## Decision changes

- A covered green main result records its observed completion time. Healthy head-change checks coalesce until the 60-minute interval opens. The existing unverified-age bound, recovery checks and required local corroboration take precedence.
- A repeated named file or two unnamed failures on the same commit confirm red. Two different failures trigger one more check. A third failure without a match turns main red with a distinct reason and raises the existing alert.
- Only the current coordinator judges main health. Same-machine state survives restart. Foreign lease acquisition discards local confirmation and cadence inputs. A previously red state still requires an eligible green result to clear.

## Side effects

- Over-block. A healthy later head with no other demand can wait for the 60-minute window to open. An inconclusive failure keeps the existing suspect restrictions and consumes up to one more immediate check.
- Under-block. Unmatched failures retain suspect restrictions until the third failure raises red. The existing suspect merge rules and the three-hour unverified bound remain active.
- Layer and authority. The health state machine compares recorded file evidence, and the coordinator applies the resulting state in its existing scheduling and admission paths. This follows the boundary in docs/signal-vs-authority.md. The signed PR result, body and review gates remain independent.
- Interactions. Local corroboration promotes an already queued main check when its independent age threshold is met. A pending ordinary check obeys the interval if a covered green arrives while it waits. Running checks retain their reservation.
- External surfaces. Status reports red after three different failures. Existing red notifications still use the same deduplication key.
- Multi-machine posture. File evidence and timing are machine-local in the existing watermark. A peer contributes through the authenticated signed-result path. The current coordinator alone changes main health and sends its existing lease-bound alerts.

- Healthy main can carry unverified later merges longer, within the existing age limit. Full PR verification and merge predicates remain in force.
- Three unrelated transient failures can raise red. The third check consumes a slot when the first two failures differ. Two unnamed failures raise red on the second check.
- Existing watermarks have no timestamp or failure confirmation. They retain the stored health state and use the existing scheduling cadence until the first covered green result supplies a timestamp.
- The release-only alias mismatch affects merge-time authority and is tracked separately. This change keeps merge predicates intact.

## Rollback

Revert the change and deploy the previous verifier through the coordinated fleet rollout. The prior watermark reader ignores the optional fields. Keep existing verification and merge holds in force during the rollback.

## Second-pass review

**Reviewer:** Independent Claude Fable 5.2 helper for the Echo Chief of Staff session.

CONCUR on cfe48a172ec23509fd7a7680e0d1e84fe3988149. The earlier dissent is closed. The reviewer checked the full main-health decision path, the existing merge restrictions, restart recovery, and mixed-verifier handling. Review record: pr-4007-rereview.md. Pipeline Strategy also concurred on the follow-up.
