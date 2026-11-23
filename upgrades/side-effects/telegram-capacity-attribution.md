# Side-Effects Review: Explain Telegram Capacity Failures

Author: Echo. Scope authority: Chief 9d7e7289 and operator-delegated bounded closure b039c9e8. Full convergence is false; both bounded checks were clean. Tier 2 because the existing credential/outbox safety boundary is touched, even though this change adds diagnostics rather than authority. Six capped review iterations included two external/conformance prechecks without full internal lenses, transparently retained in the report. No source change was made before the bounded closure. The allocated targets and startup check passed as recorded below; complete final-head verification and installed capacity-refusal positive control remain pending.

## Summary and decision points

The existing capacity evaluator can explain consume decisions; the same IPC requests carry optional explanation fields. The prepared send closure captures bounded timing and named causes. Its existing scheduler refusal metadata stays unchanged. The exact existing claim transaction records optional secret-free evidence or a fixed unavailable status. Existing HTTP/federated/archive attempt readback carries it. No capacity number, lease rule, retry time, sender or queue owner is changed.

## 1. Over-block

Malformed optional explanation cannot turn a valid grant or consumed=true into denial. Valid legacy null/false means a received refusal with unavailable cause; lost replies mean owner verdict unknown. Old clients use unchanged requests and fields. A diagnostic write has its own savepoint, preventing its recoverable failure from rolling back a valid delivery outcome. The existing one-use/owner/deadline decisions remain in the same order.

## 2. Under-block

Diagnostics never authorize transport or retry. Only the existing egress closure's request-bound proof returns transport budget. Newly explained IPC and consume lease causes are NOT attached to the old refusal metadata consumed by scheduler classification. Existing known/unknown acceptance and stale claim fences remain. Optional evidence cannot supply a receipt or override dispatch state.

## 3. Abstraction fit

Measurements sit at the capacity boundary, where timestamps and decisions are observed, and on the matching durable attempt. This avoids interpreting a generic error as expiry or configuring a larger permit lifetime without evidence. Existing automatic recovery already accepted the Windows successor; no manual drain is needed for that operation.

## 4. Signal versus authority

The new fields are observations only. They do not grant a lease, debit a second capacity pool, change attempt budgets, extend deadlines, retry a possibly accepted request or select a new root-cause policy. The fixed enum/schema validator excludes credentials and message content; invalid diagnostics cannot change an outcome.

## 4b. Judgment

The root cause remains an evidence-dependent judgment after actual-path observation. Inherited capacity values remain unchanged and are not claimed optimal. Review mode is operator-delegated bounded closure, not full convergence. No unsupervised numeric tuning is introduced.

## 5. Interactions and retention

Both server and Lifeline share the same owner authority. Runtime wrappers preserve explained methods but maintain legacy retry classification. A separate attempt-keyed table leaves old positional inserts intact. A database delete trigger removes evidence even under old attempt purge. New archives serialize optional evidence/status via existing records; old newly written archives can lose diagnostic fields during rollback, explicitly disclosed. No orphan evidence should survive attempt purge. Fixed degradation reporting cannot alter the accepted outcome.

## 6. External surfaces and operator quality

No new endpoint, UI, notification flow or permission. Existing operator-authorized origin audit readback adds optional capacityEvidence and capacityEvidenceStatus. Awareness explains pending/unknown messages must not be resent and absence limits. No operator action is required by diagnostic fields alone.

## 7. Multi-machine posture

Evidence follows the existing authoritative attempt through local and federated readback, forwarding and archives. It creates no new distributed queue. Credential-owner IPC remains same-principal. Monotonic durations stay local to one caller; epoch remaining-lifetime comparisons are annotated for clock/sampling uncertainty and never establish lease authority.

## 8. Rollback

Revert code normally. The separate table/trigger remain inert and preserve old table shapes. Old readers ignore optional archive JSON; old writers may omit new diagnostics when archiving, a known diagnostic-loss limitation rather than message loss. Do not remove a live database or mutate queue custody to roll back.

## Verification and maturation

Private Node24 ABI137 SQLite probe, type check, source build and all 55 lint steps passed. Independent implementation reviewers concurred. The one allocated target batch passed 86 unit, 20 HTTP and 18 lifecycle cases with no failures or skips; actual admissions were 26762, 12226 and 21610, each under ordinary enforcement. The supported startup-only command exited 0 with PASS and verified exact target process/listener/home cleanup. Installed capacity-refusal positive control and complete final-head LocalVerify remain pending. ACT-442 persists later natural-attempt/root-cause follow-through under Echo and Chief, due 2026-11-24T03:30Z.

## Class Closure

This change adds no self-triggered controller. Existing recovery scheduling is unchanged, with exact retry reason/time assertions required. Trace will declare the diagnostic-only negative self-action scope rather than invent a new rate/retry guard.

## Retention correction and implementation review

Independent security review found and verified corrections for phase-invalid IPC explanations and runtime closure overwriting a received owner decision. Retention review found that folding could erase the fixed unavailable marker before archive; Chief applied the reviewed source-only filters and cleanup statements after the command guard refused SQL text edits. Author independently read the full resulting diff. The installed released 1.3.1979 has no evidence table or trigger, but Chief applied the additive separately named unavailable cleanup trigger, and the author independently read it back, covering a retained earlier definition without dropping it. An isolated upgrade fixture reconstructs that earlier definition from stored schema, reopens the normal worker, and requires the new independent trigger plus no orphan marker after supported archive/purge. This fixture passed in the allocated five-case evidence-store file. No production SQL, queue mutation or resend occurred.

Final independent implementation review concurred: security/request-bound proof and retry classification, then retention/rollback/archive/federated counter integrity. The final exact source build exited 0 and all 55 lint checks passed after the additive trigger. The allocated targeted run passed; installed capacity-refusal proof remains pending. The retained-trigger upgrade case passed in the actual normal allocated batch.

## Actual Evidence and Remaining Gates

Frozen tested manifest 00759653045f2f59dea972bcd6d582e0d59da76bde0c7093dc97aa854609733a at base e4e416ee79889233dbdd6f449bf923df9c735685: 7 unit files/86 cases, 2 HTTP files/20 cases, 2 lifecycle files/18 cases, all exit 0 and no required skips, completed 2026-11-23T05:36:20.597314Z. Source and test bytes were rechecked unchanged after execution. The supported startup-only allocation 28358cfa ran once, CLI exit 0 and report PASS at 05:38:04.748Z, no bot or roundtrip. Exact target test-deploys/2026-11-23T05-37-59-595Z had no process/listener after CLI; its inspection home was removed only through SafeFsExecutor and absence was independently verified at 05:39:25.798954Z. Startup does not prove the capacity-refusal path. Chief 2bcb2a19 authorizes the normal draft handoff now and requires the separate throwaway/demo positive-control proposal before running it. No live owner channel is eligible. The final document/trace evidence updates do not alter tested source/test bytes.


## Committed positive-control integration

Chief `fadc7c59`/`0acf7276` selects normal complete verification instead of an unsupported standalone suite-front. Only the normal lifecycle test, tracked fixtures and evidence documentation are added; the existing production diagnostics source is unchanged. The current verifier owns checkout/build integrity. The fixture records the actual verification tree and imported dist hashes rather than depending on private manifests or the old head. Synthetic credentials, deny-only external transport, real IPC and one operation retain all original capacity/readback/timing/scheduler assertions. Normal success must be a natural front and owner exit; no process.exit(0) manufactures completion. A scoped wrapper delegates real interval registration unchanged, restores it immediately and clears only captured route-owned handles during cleanup.

The parent validates fresh invocation identity and front PID before accepting its receipt, then independently checks exact target processes, loopback listener, guarded home and socket absence. Artifacts stay separate from the removed runtime home and are retained in normal verification stdout. Normal case timeout and cleanup deadlines are unchanged. No bot, owner message, production home, restart, queue priority, capacity policy or native binding is touched. `/tmp/n82-capacity-fixtures/proof-*` is exact-realpath guarded and keeps the POSIX socket below its kernel pathname limit. Owned failure cleanup may terminate its own child; success cannot be forced.

The test explicitly skips Windows because OriginNoticeIpc uses a chmod-protected POSIX socket. It must actually run on the Studio and M5 verification workers. This new skip requires the normal independent-review classification. The new unified review artifact and trace must cover every changed test path in the branch, including unchanged previously reviewed tests, instead of splitting coverage across traces. No skip is waived or relabeled. Actual collection and execution are pending the final new-head gate; prior private failures and capacity timeouts remain retained evidence, not a pass.
