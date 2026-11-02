# Convergence Report — Machine self-maintenance

## Accepted by the operator at the cap, 2026-11-01 14:55 PST

**This spec did not converge. The operator accepted it at the cap.** The `review-convergence` tag it now carries records that acceptance and nothing more. Nine rounds ran against a cap of six, every external verdict was SERIOUS ISSUES, and **round 9's three design fixes have been read by no reviewer**.

His acceptance is Telegram topic 134088, message 135179, sender Justin (uid 7812716706), provenance `user`, 22:55:37Z: `"go"`. It answers message 135176, which said: near the 10-day limit he gets one question, and if he does not answer the machine restarts that night even if some work cannot be paused; someone actively using the machine at restart time means it never restarts automatically, even on the last night, and a stuck OS update or disk operation also holds it; "the last outside review found three more problems, which are fixed but unreviewed"; the core is built first, starting watch-only for 14 nights. Both messages were read from the local topic log, not taken from the launching session's summary.

That message is an acceptance of the stated rules and of building the core. It is not a statement that he read this report or the spec text. Under `skills/spec-converge`, a cap exit with safety findings asks the operator, and this is his answer. Increment 1 cannot issue a restart or stop work, so the unread fixes reach no running behaviour in it; they must be read before any later increment makes the drain real.

The sections below are the record as it stood before that message, and are left as written.

## Convergence verdict: CONVERGENCE FAILED AT THE ROUND CAP

Six rounds were used, the Tier 2 cap. Round 6 still raised DESIGN findings, three about safety or data loss, and under the skill's rule that exit is `convergence-failed`. Three external reads ran beyond the cap. The fixes for rounds 6, 7 and 8 are in the spec.

On 2026-11-01 at 14:30 PST the operator read the overview and answered in topic 134088: "It looks good, however" and that "it waits" is a trap that never ends, so the plan needs global Instar work coordination to pause work and let the machine restart. The spec was amended to make a scheduled restart a commitment with a time. Round 9 read the amended text and returned SERIOUS ISSUES with three design findings. All three were clear and are fixed in the spec, after the read, so **no reviewer has seen those three fixes**.

The spec carries `approved: true`, citing that message, on the launching session's instruction that the operator accepted the design with this amendment. I checked the message text and time in the local topic log. What it does not cover: he had not seen the amended text, the restart-on-silence default, or this report. The `convergence-status` stays `failed-at-cap` and there is no `review-convergence` tag, so `/instar-dev`, which requires both tags, still refuses to build from it.

**Decision for the operator:** none is needed for the design as instructed. See "For the operator" below for what is his to know before enforcement.

## Cross-model review: codex-cli:gpt-6-astra

Real external passes ran in all six rounds, each returning a verdict, on a changed body each time, and three times beyond the cap, in rounds 7, 8 and 9. Round 1 first degraded on the agent home's stale module (`gpt-5.5`, `error`); that attempt is not counted, and the worktree was rebuilt with sibling `node_modules` to reach the current reviewer.

⚠ Gemini did not run (`gemini-not-authed`). Grok did not run (`grok-not-enabled`). The clean-door Anthropic read returned `no-supported-framework` in round 1 and was not retried. Every external round's verdict was SERIOUS ISSUES, including rounds 6 to 9.

## ELI10 Overview

Machines that run agents for weeks collect stuck windows, stuck processes and strange states. On 1 November the Studio got so stuck that remote access failed, and only a restart fixed it. This spec teaches Instar to look after its own machines: a clean restart about once a week at a set time, with all running work paused first and resumed afterward, a rescue when a machine wedges, and proof afterward that everything came back. It also makes agents close the browsers they open, and stops one misleading flag being reported as "locked".

Nothing restarts until the owner taps once per machine. A machine that would stop at a password screen is never restarted by itself. Work that cannot be picked back up delays a restart only up to a fixed limit, and after one plain question to the owner, the default is to restart. The trade-offs: a weekly restart briefly interrupts everyone on the machine, unsaved work in ordinary apps cannot be seen, and a machine frozen below the level software can reach still needs a person.

## Original vs Converged

- **Password.** Originally a one-time link passed the machine password through Instar. Review showed agent sessions could read it. Now Instar never touches it: macOS's own password box does the job, and Linux without passwordless sudo is refused.
- **The ceiling.** Originally, "work is safe to interrupt" let an overdue restart end anything. Review made unresumable work block for ever. The operator's amendment replaced both: a restart has a set time, work yields under a declared contract, seven delays have fixed limits, and past a maximum interval the owner gets one question with a default of restarting.
- **Resume.** Originally entries were queued early, and the queue would have thrown them away while the sessions were still alive. Now they are written at the last moment, held until a real boot, tied to a recorded dispatch, and accounted for by topic.
- **Dialogs.** Originally, anything on screen for 30 minutes could be clicked away. Now only one known harmless alert type is touched, only inside a confirmed wedge. Permission prompts are never answered.
- **Wedge detection.** Originally two signals that fail together counted as two, so a healthy Mac with missing permissions could look wedged. Now those are one family, each probe must have worked on that machine first, and the forced path has to earn its authority with evidence.
- **Who can act.** Originally the tap was called proof of the owner, and every path wrote files freely. Now there is an approval press, an honest statement of what it proves, one atomic reservation for every path, and fencing against a stale controller.
- **Scope cut.** Removed: the password drop, the command-guard change, a peer-view signal that read the wrong direction, and a build-time write to the M5 Pro. Mama PC is attended-only, because nothing brings its agent back after a Windows boot. One-at-a-time across a pool became openly best-effort.

## Iteration Summary

| Round | Reviewers who flagged | Design findings | Left behind | Standards-Conformance Gate | Spec changes |
|---|---|---|---|---|---|
| 1 | security, adversarial, integration, scalability, decision-completeness, lessons-aware, Astra | 38 before grouping | 3 | ran (2 flags) | Major rewrite of Parts A, B, C, D, E |
| 2 | safety lenses, integration/decision lenses, Astra | 13 | 5 | ran (1 flag) | Password drop, guard, F5 cut; fencing, receipts, gating |
| 3 | all-lens, Astra | 8 | 5 | ran (2 flags) | Linux paste removed; quiesce rule; operator takeover |
| 4 | all-lens, Astra | 6 | 4 | ran (2 flags) | Generation on all writes; forced due; binding acks |
| 5 | all-lens, Astra | 6 | 3 | ran (2 flags) | Subagents unrecoverable; census order; claim best-effort |
| 6 | all-lens, Astra | 5 | 9 | ran (2 flags) | Fixes applied |
| 7, beyond the cap | Astra only | 2 | 0 | ran (1 flag; parent-principle fit weak) | Dispatch outcomes, browser close conditions, reservation order |
| 8, beyond the cap | Astra only | 3 | 0 | not read from the result | Dispatch and wedge-gap fixes and one wording fix; browser lease rule settled afterward |
| 9, beyond the cap, on the operator's amendment | Astra only | 3 | 0 open; fixes not re-read | not returned by the script | Drain amendment, then fixes for operator dispatch, call-off and receipts |

Internal reviewers ran as Claude subagents on the authoring session's model, Opus 5.5, in every round. Rounds 1–2 used split lens groups; rounds 3–6 used one reviewer holding all six lenses, a reduction from six independent reads that a reader should weigh. Rounds 7, 8 and 9 were one external read each and no internal reviewer, so they are not like-for-like rounds.

## Proportion

Tier 2, 6 of 6 rounds plus 3 external reads beyond the cap. ⚠ The spec grew from about 49 KB to about 100 KB across review and the amendment. It is large for one document, though the build order splits it into five parts and later runs.

## Left behind

Gate flags, recurring through round 6, not resolved:

- *Structure beats Willpower:* a session can run the sudo rule directly. Accepted: same OS user, and a wrapper cannot authenticate its caller either. Detected at the next boot.
- *Mobile-Complete Operator Actions:* a Mac with no passwordless sudo and no desktop path needs a person at the machine once. Accepted: a macOS system password box needs a screen.

Round 8's browser finding is settled in the spec on the safe side: a default lease expiry only reports, and only a declared disposable lifetime closes. Round 9 read that text and raised nothing on it.

Fixed after their reads and not re-read: round 8's `refused` narrowing, wedge observation gap, and "recoverable-work deferral" wording, which round 9 did read; round 9's three fixes, which nobody has.

New since round 7, by request, with no design: a short Part C reminder that an unusable macOS privacy state needs a guided repair and that enrolment must verify permissions live.

Precision and long-tail:

- Scheduled success notices are routine narration; kept because the operator asked for before and after notices.
- A controller frozen between claim and dispatch past the lock's staleness bound can cause one extra counted restart.
- `-lifeline` registry filter, macOS sudoers command paths, and whether a shutdown rewrites a resume UUID were not verified in code.
- Rung 6 at the cap of its plan window relies on the single `expiresAt` extension.
- Whether `lockEvent` earns a row is decided by L1.

## Full Findings Catalog

**Round 1.** Astra: lossless-interruption claim false; 3-sample rule conflicted with 2-minute sampling; no exclusive authority; lock policy read as lock state. Security/adversarial: session could read the password; sudoers swap window; F1+F2 positive on healthy machines; stuck plan closed admission indefinitely; ceiling could reboot over another human; tap overclaimed its proof; dialog care could answer permission prompts; "never stalls" false; unattributed reboots invisible; guard would block ordinary work; `maintenance` close reason could not work. Integration: resume entries invalidated before reboot; eligibility refusals; "I have your message" could be false; `HandoffSentinel` cannot target a peer; wedge path died with the maintainer; lifeline had no identity gate; per-agent scalar ownership; readiness ignored autostart; registry a poor census; claim rollout undefined; `shutdown.exe /a` proved nothing. Decisions/lessons: soft-blocker `invariant` rejected; ceiling broke the card's promise; notice preceded heal; no-op heal during soak; no shadow evidence; 30 minutes proves unattended, not stuck; offer as a nag; lifeline contradicted the actuator; governor registration wrong; resume claims outran the drainer; ownership not host-scoped; buried operator stops. All resolved in the spec.

**Round 2.** Astra: unresponsive agent labelled recoverable; second maintainer could also actuate; F5 direction wrong. Safety: lifeline press impossible with server down; no owner id; PIN claim false; password exposure; drop branch point; entries could vanish unlisted; overlapping pools. Integration: co-resident enqueue race; stranded entries on failure; rollout contradiction; `failDirection` value wrong; lifeline skipped other-human check; M5 marker had no owner; lint failure; stale statements. Gate: guard held blocking authority. All resolved, several by cutting.

**Round 3.** Astra: receipts required before restart; fencing stopped at the check; quiesce timeout conflicted with Absolute blockers. All-lens: operator blocked by an open episode; lifeline versus brakes; lifeline reach overstated; display sleep wrongly excluded the canary; Mini install. Resolved.

**Round 4.** Astra: cap eviction ignored dry-run; acks not bound to the episode; autonomous resume guarantee overstated. All-lens: single-family fallback versus dry-run; takeover guarded only `claimRung`; lifeline stopped at rung 5. Resolved.

**Round 5.** Astra: subagents and shells not recoverable; census could omit new work; claim did not give mutual exclusion. All-lens: rung 4 versus judge outcomes; dry-run inversion; same evidence ended dry-run and unlocked `restart-now`. Resolved.

**Round 6, resolved in the text.**

| Finding | Reviewer | Concerns | Resolution applied |
|---|---|---|---|
| Final safety check came before a 90 s wait, and none before Rung 2 | Astra | Safety | Fresh check before every privileged dispatch, inside the lock |
| Same-user apps with unsaved state undetected | Astra | Data loss | Bounded the promise to identifiable work; enrolment acknowledgment naming open apps |
| Rung 3 could restart the helper during a live grant | All-lens | Safety | Presence gate on rung 3 |
| Abandoned entries could release on an unrelated reboot | Astra | Work loss | Entries bound to episode and a dispatch record; reconciled at expiry and start |
| Part B cannot hold on Windows | All-lens | None | `not-covered` in v1 |

**Round 7, run beyond the cap.** External read only, `codex-cli:gpt-6-astra`, verdict SERIOUS ISSUES, on the text after the round 6 fixes. Standards-Conformance Gate: ran (1 flag), Mobile-Complete Operator Actions, `possible-violation`, the same accepted item as above; parent-principle fit `weak`. No `review-convergence` or `approved` tag was added. All four findings are now resolved in the spec. The decision table says best-effort stagger; Part D separates dispatch failed from outcome unknown and holds recovery and admission through `outcome-unknown`; Part B requires a completion signal, an expired renewable lease or a confirmed absent owner, then checks for unsaved input; `reserve()` is the first write of an episode, and only a dispatched restart spends budget. Astra's text, verbatim:

> **Verdict: SERIOUS ISSUES**
>
> Review limited to the inlined spec; no implementation source was provided. These are specification findings, not measured runtime failures.
>
> - **DESIGN — Part D, “Actuate” / “Resume”: timeout does not establish that reboot was cancelled.** The spec clears the plan, reopens admission and cancels resume entries five minutes after Rung 2 if the machine remains alive. It provides no evidence that previously dispatched shutdown work cannot subsequently complete. A delayed reboot could therefore interrupt newly admitted work after its recovery records were cancelled. **Resolution:** distinguish “dispatch failed before acceptance” from “shutdown outcome unknown.” After accepted or uncertain dispatch, preserve recovery entries and keep automatic admission closed until reboot or independently verified cancellation. Notify the operator when that outcome cannot be established.
>
> - **DESIGN — Part B, “Sweep” / “Who may be closed”: browser ownership is not evidence that work is disposable.** The TTL branch permits closing a browser even while its owning session remains alive. Only two script helpers refresh `lastUsedAt`; the spec gives no activity signal for downloads, page-side work or a long-running interaction. Frontmost-window protection does not cover background work. The decision table’s assertion that a wrong close “costs a relaunch” is consequently unsupported. **Resolution:** make TTL trigger an eligibility check rather than unconditional closure. Require an explicit task-completion signal, expired renewable activity lease, or confirmed absence of the owning session before closing; retain the existing exclusions.
>
> - **PRECISION — Part D, “Host store” / “Actuate”: episode reservation timing is contradictory.** `reserve()` opens an episode and consumes budget, but “Actuate” places it after quiesce and acknowledgements that already require an episode ID and generation. **Resolution:** specify one reservation point before episode-dependent writes, distinguish reservation from dispatch, and define whether an aborted pre-dispatch episode consumes the restart quota.
>
> - **PRECISION — “Decision points touched”: claims are called “mechanical mutual exclusion.”** Part D explicitly accepts concurrent restarts and describes claims as best-effort staggering. **Resolution:** use that description consistently; the design does not provide mutual exclusion.

**Round 8, run beyond the cap.** External read only, `codex-cli:gpt-6-astra`, verdict SERIOUS ISSUES, on the text with the round 7 fixes and the privacy reminder. The first design finding is open. The other three are folded in after the read and were not re-read. No `review-convergence` or `approved` tag was added. Astra's text, verbatim:

> **Verdict: SERIOUS ISSUES**
>
> Review is limited to the inlined spec. Referenced implementation files were not supplied, so their behavior is unverified.
>
> - **DESIGN — Part B, “Sweep” and “Unsaved input and downloads.”** The spec says “Time never closes anything,” but an expired default lease independently permits closure—even with a live owner. The remaining checks establish only absence of detectable form edits and recent download growth, not completion. A browser performing background work without helper calls can therefore qualify for closure. The acknowledged canvas/in-memory limitation reinforces this gap; it does not resolve it. **Resolution:** require explicit completion for live-owner instances, or an explicitly declared, disposable lifetime. Treat default lease expiry as a reason to investigate or report, not terminate.
>
> - **DESIGN — Part D, “Dispatch outcome.”** The spec equates any completed nonzero command exit with “The OS accepted nothing,” then reopens admission and cancels recovery entries. No supplied source establishes that transactional guarantee for every privileged command. A command’s error status alone does not establish that earlier shutdown side effects were reversed. This is an unsupported safety assumption, not a measured command failure. **Resolution:** classify only demonstrably pre-dispatch failures as `refused`; retain `unknown` for other nonzero exits unless an OS-specific contract or independently verified cancellation establishes safety.
>
> - **DESIGN — Part E, “Wedge candidate.”** The spec requires a “continuous 20-minute evidence window,” yet missing samples neither reset nor invalidate it, and no maximum observation gap is specified. Thus two positive observations, a long monitoring outage, and another positive observation can satisfy the written rule without demonstrating continuity. That matters when the monitor resumes after a stall or maintainer takeover. **Resolution:** require a bounded gap between observations and fresh evidence before judging and dispatching; restart the evidence window after exceeding that gap.
>
> - **PRECISION — Part D, “Hard ceiling.”** “Automatic deferral is bounded” overstates the implemented guarantee. The spec expressly permits persistent unrecoverable work to block indefinitely; sending an attention item does not make silence a “person’s recorded choice.” **Resolution:** say that recoverable-work deferral is bounded, while Absolute blockers can persist indefinitely.

**Round 9, run beyond the cap, on the operator's amendment.** External read only, `codex-cli:gpt-6-astra`, verdict SERIOUS ISSUES. All three findings are fixed after the read: S1, S2 and the off switch are enforced inside `claimRung` for every caller and rung, and operator passes are enumerated; each work kind declares `undoYield()` with a durable yield row, covering roll, Skip, expiry, refused Rung 1, verified cancellation and Keep running; receipts move to a new `receipting` phase before `armed`, so D3 can delay or roll. Astra's text, verbatim:

> **Verdict: SERIOUS ISSUES**
>
> Review limited to the inlined spec; no implementation or supporting source was supplied.
>
> - **DESIGN — Operator dispatch can bypass non-overridable holds (Part D, “Fresh check”; Part E, “Operator trigger” and “Lifeline path”).** The spec says S1/S2 refuse even operator restarts, but explicitly exempts operator dispatches from the entire fresh check. An installer or disk operation could begin during the five-minute drain or before lifeline force escalation. **Resolution:** enforce S1/S2 inside `claimRung` for every caller and every rung. Explicitly enumerate the checks an operator may override instead of skipping the check wholesale.
>
> - **DESIGN — Cancelling a drain does not restore all stopped work (Part D, “Allowed delays,” “Work yield contract”; “Self-Heal Before Notify fields”).** A roll sends “carry on,” reopens admission and cancels resume entries. Earlier phases can already have terminated script jobs, interrupted sessions and marked autonomous state files `drain_suspended_for`. The specified compensation does not clear those markers or restart terminated work; a notice cannot restore a dead process. This can occur during an ordinary delayed night, without any reboot. **Resolution:** define durable, per-work-kind compensation for roll, expiry, skip and refused dispatch, including marker cleanup and same-boot revival or requeue. Test cancellation after each destructive phase.
>
> - **DESIGN — Missing revival receipts are discovered after their delay mechanism closes (Part D, “Actuate,” state machine and delay rules).** Resume entries and receipts are collected at `armed`; missing autonomous-run receipts become D3. However, delays can open only *up to* `armed`, and only states before `armed` can roll. Thus a non-final episode has no specified valid transition when this required receipt is missing. **Resolution:** collect and validate receipts in a distinct pre-arm state, allowing D3 to delay or roll there. Enter `armed` only after receipts pass or the explicitly authorized final-night exception applies.
>
> These are contradictions in the specified behavior, not measured implementation failures. The broader design appropriately uses deterministic scheduling, admission and browser rules; replacing those with additional model judgment would not address these gaps.

## The amendment, in brief

Reused: the host-wide file pattern of the spawn cap and test limiter, `MaintenanceGate` beside `WorkAdmission`, the recovery slot, `ResumeQueue`, Local Verify's `shutdown()` behaviour, `SessionDrainRunner`, overload shed's target rules, the `moved_to` marker pattern. New: `DrainController`, `WorkYieldRegistry`, the drain record's fields, `HostDrainingError`, `yieldForRestart()`, the app's machine-care routes.

Allowed delays: D1 owner at the machine 60 min, D2 work with no resume path 60, D3 agent not answering 30, D4 short critical step 30, D5 lease will not hand off 30, D6 another pool machine restarting 90, D7 unsaved input in an owned browser 30. Total 120 minutes in an episode, never past the window's end. Maximum interval 10 days, with the question at 9.

Safety holds, with no maximum: S1 OS update installing, S2 disk or firmware operation, S3 a person using the machine now, S4 battery under 50%. Reported every night they stop a restart.

Decisions reversed by the amendment: conversations now move where possible, the app gets controls, scheduled restart starts watch-only. Unsaved browser input is a delay, not a hold, and the spec gives the reason.

## For the operator

- On the final night, silence ends work that cannot be paused. That default came through the launching session's instruction and his message does not state it.
- A person typing at T-0 stops an automatic restart on every night, final included. I chose that; it is his to reverse.
- Slot times (T-20 and T-5) are estimates until the rehearsal measures them.
- Safety hold readings are unproven until L7, and an unproven reading is no hold.

## Counts

Frontloaded decisions 16, cheap-to-change tags surviving 0, contested-then-cleared 4 (round 6). Open questions 0. No constitution file is touched.

## Conclusion

Not formally converged. The operator accepted the design with an amendment, the amended text had one external read, and its three design findings are fixed without a further read. He then accepted at the cap with `go` (top of this report), so the build gate is open on that acceptance, not on a converged review.
