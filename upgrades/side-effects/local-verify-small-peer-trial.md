# Side-effects review for memory-bounded peer verification

The coordinator may dispatch one normal PR to an explicitly named Mac below the ordinary heavy-work size floor. Dispatch still requires measured CPU headroom, matching verifier and policy, a pinned signing key and the coordinator lease. The peer repeats admission after asynchronous reads and binds the exact reduced worker configuration to the immutable request. Main and arbitration stay outside this exception.

The peer measures native Darwin available memory and native pressure. It fences the trial runner in a dedicated launchd resource coalition. An independent watchdog measures all coalition members and cancels on unavailable or low memory. The server checks the timestamp of each completed valid observation. Losing either supervisor results in cleanup, and startup reconciliation keeps the slot occupied until the job is removed and the coalition is empty. The physical calibration observed a detached worker after it reparented to PID 1. These observations cannot guarantee the host reserve between samples.

The dispatcher and the dedicated runtime write attempt-scoped records on their own disks. Cleanup sends signals only to kernel-identified members of the recorded trial coalition with verified identity. A receipt from a capacity interruption cannot supply a passing verdict. Roll back by removing the optional setting on the coordinator and the peer. A Mac previously designated for the trial retains its small-peer restriction on direct requests. Deleting or recalibrating a quarantine marker requires owner review of the receipt.

Chief holds publication and rollout custody. The physical fixtures were isolated. A real release, Mini activation, and the first three PR receipts are still pending.

## Over-block and under-block

Strict version, worker-count and collector checks can leave an apparently idle host unavailable. A missing metric or loss of the verifier lease interrupts an attempt. The job runs under the same Darwin account as the existing peer verifier. The resource coalition covers detached and reparented descendants of the job. Other applications still compete for host memory between samples.

## Placement and authority

The machine-wide placement floor stays authoritative outside the single named verification peer. The coordinator authorizes the signed request. Native memory measurements inform a local refusal or cancellation. A separate signed capacity receipt carries observations through restarts. The normal result signature, current lease and status projection rules govern a successful verdict.

## Restart and external surfaces

The peer stores a unique launchd label before starting the waiting prelude and records its boot and resource-coalition identities before permitting work. Cleanup unregisters the label and verifies the coalition has drained. A receiver retains an immutable attempt-bound receipt. Redelivery repeats signed acknowledgement without creating another verdict. An interrupted provisional completion becomes a capacity interruption during recovery. Settings on both machines must match. The setting and ordinary verifier status are the operator controls.

## Rollback and remaining exposure

Remove the setting on both machines to cancel active trial work and stop new admissions. Retain receipts and the managed-peer marker. Unavailability of both the verifier and its watchdog can delay cleanup until recovery. Sampling and shutdown measurements bound behavior seen during calibration. Unrelated host-wide memory bursts and prolonged scheduler starvation can exceed that envelope.

## Independent review

The named reviewer /root/mini_trial/design_review examined dispatch, scope ownership, receipt finalization and restart. Findings included asynchronous slot races, detached workers, stale heartbeats, direct admission before persistent enrollment, publishing a provisional result before cancellation settled, and recovery after server loss. The findings drove implementation changes and regression checks.

## Class-Closure Declaration

The unbounded-self-action guard is registered as small-peer-trial-admission. The convergence test exercises the real memory predicate under sustained pressure. Admission refuses each attempted start. Recovery requires consecutive healthy samples, and the existing per-entry remote attempt budget bounds a PR that exhausts capacity after admission.

## Shared verification repair

- Over-block. Ordinary reservations poll first. Trial receipt recovery runs before polling a trial reservation, so a recovered signed receipt can inform terminal decisions.
- Under-block. Trial renewal still requires the exact epoch sent with the accepted request and the current lease to match it. Adoption never changes that renewal epoch.
- Layer. The coordinator owns both result polling and receipt recovery. The dispatched request already carries the binding needed by the renewal sender.
- Signal and authority. A receipt recovery error emits an audit event. The existing lease and signed receipt checks still govern renewal and import. See docs/signal-vs-authority.md.
- Interactions. The existing poll lock covers the ordinary poll, trial receipt recovery, and trial polling. Concurrent ticks cannot start a second recovery pass.
- External surfaces. The wire schema and eligibility rules are unchanged. Ordinary peer result requests start without waiting for trial receipt recovery.
- Multi-machine posture. The coordinator retains ownership of polling and validates signed Mini receipts through the existing transport. The Mini retains its local memory and scope enforcement.
- Rollback. Disable the Mini trial setting to stop trial dispatch. Reverting the repair requires no migration.

Focused verification reproduced both failures on the published head. The initial repair passed all 176 cases. The second-pass revision preserves receipt precedence and single-flight recovery. Both focused files passed all 176 cases on the second-pass revision.

Independent second pass by /root/mini_trial. Concur with the revised repair. Ordinary reservations poll first, receipt recovery precedes the first trial reservation's terminal checks, and empty-reservation ticks still recover pending receipts. Recovery stays within the polling lock. Renewal uses the dispatched request epoch and checks current custody before and after requesting the nonce.

## Main branch refresh after borrowed-machine verification merged

The merge combines three overlapping files. The coordinator keeps its Mini trial state and the borrowed-machine observer and helper seams. Peer status carries validated trial policy and parsed borrowed-machine fields. The request parser retains both optional fields and their existing validation. Trial policy still applies only to ordinary pull request verification and file counts still apply only to main.

Both features retain their separate settings and admission checks. A malformed policy or request continues to fail closed. The resolver adds neither a route nor a persisted format. Rollback remains disabling the trial setting.

Independent second pass by /root/mini_trial. Concur with the three-file merge resolution. Both parents' request and status validations survive. A trial remains pull-request-only and baseline file counts remain main-only. Returned records retain their signed receipt and known helper checks. The Mini's measured peak RSS covers processes on that host.

## Second-pass review

**Reviewer:** /root/publisher_review

The reviewer concurs across all twelve changed Local Verify paths at 76f46aae and the five-file correction with SHA-256 4cef156c31a258db31f6f7547bc40f5683cf7a67c77f057691b87f761afe9519. A memory reading started during cleanup is processed before the receipt is finalized. Unavailable or stale measurements quarantine the Mini across restart. Valid readings below the floor retain the normal cooldown. Cleanup avoids sampling the closed execution scope. All 18 focused tests passed, including both final-probe cases.
