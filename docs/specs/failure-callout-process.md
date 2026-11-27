---
title: Failure callouts become investigated and verified cases
slug: failure-callout-process
author: Echo
parent-principle: "Never-Waste Feedback — corrections compound"
status: approved
approved: true
approved-by: "Echo under Justin's explicit nonconstitution delegation"
approval-context: "Justin explicitly authorized completing and merging this nonconstitution fix in topic 10000002152; only constitution changes require Justin."
eli16-overview: docs/specs/failure-callout-process.eli16.md
review-convergence: "2026-11-06T04:50:59.747Z"
review-iterations: 5
review-completed-at: "2026-11-06T04:50:59.747Z"
review-report: "docs/specs/reports/failure-callout-process-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "Installed reviewer timed out; independent internal reviews completed and limitations disclosed"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Failure-callout process

## Problem statement

Detection already exists in the correction sentinel. Echo-local bugs-intake already routes records to Echo Bugs. The missing shared product behavior is rich evidence, severity, class investigation, and honest repeat-prevention closure. The existing correction ledger, class review and feedback system remain the owners; no second incident store or bug-report API is introduced. This implements the shared process for Instar agents; Echo's topic routing and intake policies stay local.

The full topic contains three incident classes: approved Telegram group setup handed to the user, a locked screen asserted as an unverified input blocker, and an already-approved rule described as waiting for user review without a direct link. Fixtures derive from logged source messages. Their presence verifies the process, never certifies those original product defects as repaired.

## Proposed design

The distiller assigns severity correction or failure-callout by meaning, without requiring an alert phrase. Default agents activate the existing correction capture pipeline in failures-only mode: ordinary preference corrections are discarded after distillation, never enrolled into preference promotion. Explicit monitoring.correctionLearning.enabled:true retains existing preference behavior. monitoring.failureCallouts.enabled:false stops automatic serious-case capture and investigation, and refuses manual new forensic writes; historical evidence remains readable. Production initialization uses the same mode resolver. The existing detector and provider availability still determine which inbound messages reach distillation; this does not invent cross-platform detection where no sentinel exists.

Failure cases retain bounded scrubbed turns and explicit missing instructions, decisions and source references. The current case is stored in an additive nullable JSON column on CorrectionLedger; up to five earlier revisions are embedded for display. Every revision is also archived immutably in the same SQLite ledger, with paged GET /corrections/:id/failure-episodes access; display rotation never deletes chronology. Each context has at most 12 turns of 4,000 characters and 20 strings per evidence field. This evidence is intentionally durable with the correction ledger. Bounds disclose evidence loss through persistent missing markers; oversized verification receipts are rejected, and truncation blocks closure until resolved against the full source. Ordinary correction records retain no conversation; the pre-distillation capacity backlog can temporarily retain scrubbed candidate excerpts under its existing TTL until severity is known. Broad lists and agent-state responses omit detail; authenticated per-record reads expose it. Existing installs receive the additive SQLite column, updated awareness and built-in job through existing update paths.

The bounded investigator runs twice an hour, at most three cases and ten minutes per run. Its zero-token gate reads a merged eligible queue and reserves at most three durable per-case attempts before admitting model work. A case has three attempts per occurrence, with 30-minute then one-hour backoff. Exhaustion pauses automatic attempts indefinitely and creates one stalled-work attention item; the case remains unresolved. Ordinary context/progress updates and restart never reset the budget. A new occurrence rearms it; explicit resume requires a previously unused evidence reference already recorded on the case. The admission handoff file contains only IDs and bounded scheduling receipts, never conversation or credentials. Canonical gate routing binds the correct agent home, state directory and port. Queued work reuses an authenticated current-claim receipt for at most 30 minutes without spending a new attempt; unknown holders hold the batch only until that expiry, never refunding a possibly committed attempt. Per-slug gate serialization prevents receipt clobbering. The scheduler snapshots IDs into the prompt, durably consumes before model launch, refuses on failed consumption, and restores the same reservation only after a confirmed pre-session launch failure. The gate fits the scheduler ten-second timeout with bounded concurrent claims and never retries uncertain writes. It gathers evidence from history, briefs, decisions, actual guard verdicts and override receipts. Missing evidence stays missing. It records a structured constitution-gap (rule absent/inadequate) or enforcement-gap (adequate rule not applied) diagnosis as soon as supportable, even before evidence collection, ratification or repair finishes. It records root cause, planned class remedy and durable existing actions/commitments. Actual fix references remain empty until repair. Product defects use normal /feedback; constitution changes stay proposals under the existing ratification process. No new policy amendment authority is granted.

The case advances captured → investigated → verified; recurrence reopens it independently of preference status. Verification requires complete context with nonempty failing agent reply and user callout, governing instructions, decision evidence, source references and no unresolved missing facts; implemented class-fix references; the original failing scenario/baseline; and passing repeat and legitimate allowed-case receipts. The API validates the evidence contract and reported outcomes; it does not execute tests or certify receipt authenticity. The investigator must actually run the original scenario, a paraphrase, and an allowed case. A PR link, apology, prompt reminder or silence is insufficient. Capacity-unavailable judgment never passes replay. Recurrence clears active verification while archiving earlier evidence. A version CAS prevents stale closure.

The queue excludes verified cases before applying its limit and sorts least-recently updated first. A blocked case records progress to rotate behind others. An unchanged diagnosis PATCH can touch progress without resetting context; when context changes, the investigator submits supported diagnosis again in the same PATCH because changed evidence invalidates previous conclusions. Per-machine-independent gates use the origin ledger as the sole admission authority, preventing competing global job claims from discarding already reserved work. The existing lease/runtime admission still governs session execution; progress uses existing conversation delivery, not a new notice channel.

## Decision points touched

- Severity: judgment-candidate. Existing signal admission is the floor; bounded untrusted conversation goes to the existing distiller. Semantic severity is evidence, never outbound block authority.
- Capture mode and opt-out: invariant. Explicit configuration determines forensic retention and preference enrollment independently.
- Investigation classification: judgment-candidate. The investigator reads governing standards and evidence, records rationale and a class remedy; no automatic constitution amendment.
- Verification: invariant. Structural completeness, actual repair references, affirmative outcomes and current version are mechanically required. Truth of reported evidence remains the investigator's responsibility.
- Pool access: invariant. Registered, credential-admitted peer targets only, bounded fanout, response size and timeout, no recursive proxying or automatic mutation retry.
- Job admission and convergence: invariant. At most three attempts per unchanged occurrence across any pressure horizon and restart. Durable reservation precedes model launch; backoff, a hard breaker and evidence-only rearm constrain resource use, not user task permission.

## Multi-machine posture

Replicated with proxied current reads: GET /corrections?scope=pool merges detail-free summaries, tagging origin machineId. The full registered roster is accounted for: unavailable, disabled, rejected and unreachable holders appear as unknown in pool.failed. It never reports a fully clear agent while a holder is unknown. A bounded maximum of 16 remote fetches prevents an unbounded pool fanout; excess holders are explicitly unknown.

Failure snapshots and each immutable episode replicate through the existing coherence journal and peer streams under the failureCallout store. Each chunk stays below the substrate 80 KiB entry bound; complete snapshots require matching version, digest and authenticated origin. Inner-origin spoofing and dropped origins are rejected. Only changed/missing chunks are reconciled; history is incremental, never one growing whole-lineage payload. Replication defaults on with failure capture, while explicit transport/store opt-outs remain honored. When transport is implicitly activated, it accepts only failure-callout-chunk records; placement, working-set and session movement retain their original activation. Evidence is therefore available from complete cached copies when the origin is down, marked stale and read-only, while current writes stay on the origin.

Current access: GET /corrections/:id?machineId=<origin> and PATCH /corrections/:id/failure-case?machineId=<origin> proxy to its registered holder after topic transfer. Detail responses allow up to 16 MiB, covering bounded five-revision UTF-8 evidence; summary responses retain the smaller existing peer cap. An unavailable origin serves a complete stale/read-only replica if present, otherwise unknown/503 or 502. Unreachable holders remain unknown in pool coverage even when cached cases are available. Replicas never grant work admission or allow closure writes. Proxy mutation is never retried blindly: after an uncertain outcome the investigator rereads the origin version. The origin admission budget is the cross-machine dedupe authority; existing one-voice conversation delivery owns notices. This introduces no generated user URL and no new status/health/capabilities surface.

## Evidence and verification

Unit tests cover mode separation, real capture seams, all three fixture classes, scrubbing, bounded revisions, early diagnosis, strict malformed input handling, closure preconditions, CAS, recurrence, and migration parity. HTTP tests cover auth/intent, sanitized conflicts/lists, opt-outs, genuine two-holder proxying, unreachable holders and large bounded detail. Production AgentServer lifecycle tests prove default availability without preference promotion and premature-closure refusal. Installer tests prove the shipped bounded job survives normal installation/update.

A semantic replay script uses the existing real provider/tone gate without sending messages or launching tool-capable test agents. It explicitly fails when judgment is unavailable. This tests reported judgment, not deployed actuation or real group creation. Tests and builds run on the Studio, never the laptop. Fresh source: origin/main bc4355b8075dad89e8667ab082c526c0460b0455, version 1.3.1683, origin JKHeadley/instar; fresh isolated clone under /tmp because sandbox prohibits shared worktree Git metadata writes.

## Rollback

Revert code/templates and disable the investigator through its existing schedule manifest. Older code ignores the additive nullable column. There is no external action, payment, secret replication or automatic constitution change in this feature.

## Maturation plan

- **test-agent-live:** In-process production AgentServer fixtures and real journal/peer readers prove capture, closure, admission and offline history without starting a test agent or sending a message.
- **dev-agent-live:** After the ordinary update, the default-on shared failure-only path handles actual callouts; existing correction audit, admission metadata and full chronology expose outcomes and unknowns.
- **fleet:** Ship this reversible corrective process default-on as Justin requested for every agent; explicit opt-out remains available. Existing preference enrollment and its graduation stay separate and opt-in.
- **graduation criterion:** Green type/lint, unit, authenticated HTTP and production lifecycle checks; real SQLite restart pressure remains at three admissions; sender-bound replica and lossless chronology tests pass. No unavailable model replay counts as evidence of a founding incident's repair.
- **dark-window:** Zero additional dark window for this bug fix: detection exists, and the missing shared follow-through is explicitly requested now. The existing preference-learning rollout is unchanged; observed investigation outcomes remain evidence for later quality improvements, not a claim that every incident is already repaired.
- **ladder:** monitoring.correctionLearning

## Open questions

None.
