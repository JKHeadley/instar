# Convergence Report — Machine self-maintenance

## Convergence verdict: CONVERGENCE FAILED AT THE ROUND CAP

Six rounds were used, the Tier 2 cap. Round 6 still raised DESIGN findings, and three concern safety or data loss. Under the skill's rule that exit is `convergence-failed` and the operator is asked. The fixes for every round 6 finding are in the spec. Two further external reads ran beyond the cap. Round 7 returned SERIOUS ISSUES with two design findings and a precision finding, all three now resolved in the spec. Round 8 read those fixes and also returned SERIOUS ISSUES: three design findings and one precision finding. Two design findings and the precision finding were clear and are folded in after the read, so no reviewer has seen those fixes. One design finding, about closing a browser at lease expiry, remains open. The spec carries `convergence-status: failed-at-cap` and has no `review-convergence` tag and no `approved: true`. `/instar-dev` will refuse to build from it, which is the correct state.

The trend was narrowing, not stalled: round 1's findings were structural (a readable password path, resume entries destroyed before the reboot), and round 6's are about the timing of checks at the edges.

**Decision for the operator:** settle the open round 8 design finding, then allow a further round or accept the spec as it stands. Rounds 7 and 8 did not change the convergence status.

## Cross-model review: codex-cli:gpt-6-astra

Real external passes ran in all six rounds, each returning a verdict, on a changed body each time, and twice more beyond the cap, in rounds 7 and 8. Round 1 first degraded on the agent home's stale module (`gpt-5.5`, `error`); that attempt is not counted, and the worktree was rebuilt with sibling `node_modules` to reach the current reviewer.

⚠ Gemini did not run (`gemini-not-authed`). Grok did not run (`grok-not-enabled`). The clean-door Anthropic read returned `no-supported-framework` in round 1 and was not retried. Every external round's verdict was SERIOUS ISSUES, including rounds 6, 7 and 8.

## ELI10 Overview

Machines that run agents for weeks collect stuck windows, stuck processes and strange states. On 1 November the Studio got so stuck that remote access failed, and only a restart fixed it. This spec teaches Instar to look after its own machines: a clean restart about once a week when nothing is running, a rescue when a machine wedges, and proof afterward that everything came back. It also makes agents close the browsers they open, and stops one misleading flag being reported as "locked".

Nothing restarts until the owner taps once per machine. A machine that would stop at a password screen is never restarted by itself. Work that cannot be picked back up blocks an automatic restart. The trade-offs: a weekly restart briefly interrupts everyone on the machine, unsaved work in ordinary apps cannot be seen, and a machine frozen below the level software can reach still needs a person.

## Original vs Converged

- **Password.** Originally a one-time link passed the machine password through Instar. Review showed agent sessions could read it. Now Instar never touches it: macOS's own password box does the job, and Linux without passwordless sudo is refused.
- **The ceiling.** Originally, "work is safe to interrupt" let an overdue restart end anything. Now only work with a named resume path can be interrupted, and only inside the promised window. Other people's work reaches the owner as one question.
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
| 8, beyond the cap | Astra only | 3 | 1 design | not read from the result | Dispatch and wedge-gap fixes and one wording fix, not re-read |

Internal reviewers ran as Claude subagents on the authoring session's model, Opus 5.5, in every round. Rounds 1–2 used split lens groups; rounds 3–6 used one reviewer holding all six lenses, a reduction from six independent reads that a reader should weigh. Rounds 7 and 8 were one external read each and no internal reviewer, so they are not like-for-like rounds.

## Proportion

Tier 2, spec 562 lines, 6 of 6 rounds plus 2 external reads beyond the cap. ⚠ The spec grew from about 49 KB to about 79 KB across review. It is large for one document, though the build order splits it into five parts and later runs.

## Left behind

Gate flags, recurring through round 6, not resolved:

- *Structure beats Willpower:* a session can run the sudo rule directly. Accepted: same OS user, and a wrapper cannot authenticate its caller either. Detected at the next boot.
- *Mobile-Complete Operator Actions:* a Mac with no passwordless sudo and no desktop path needs a person at the machine once. Accepted: a macOS system password box needs a screen.

Open from round 8, unresolved:

- **Design, Part B:** an expired default lease permits a close even with a live owner, so a browser doing background work with no helper calls can be closed. The operator's instruction for round 7 named an expired renewable lease as sufficient, and Astra asks for more, so this is left for the operator. The spec's Honest limits names the gap.

Fixed after round 8 and not re-read: `refused` narrowed to failures shown to be before dispatch; a 6-minute observation gap and fresh evidence added to the wedge window; "automatic deferral is bounded" corrected to recoverable work.

New since round 7, by request, with no design: a short Part C reminder that an unusable macOS privacy state needs a guided repair and that enrolment must verify permissions live.

Precision and long-tail:

- Scheduled success notices are routine narration; kept because the operator asked for before and after notices.
- `max-wall-clock: 30m` in the WedgeMonitor fields does not mention the 2 h idle wait of `restart-at-next-idle`.
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

## Counts

Frontloaded decisions 14, cheap-to-change tags surviving 0, contested-then-cleared 4 (round 6). Open questions 0. No constitution file is touched.

## Conclusion

Not converged. Round 6 found design issues about safety and data loss, and the round cap stops review there. Round 7 found an unverified reboot cancellation and closing a live browser, both now fixed. Round 8 found the live-browser fix does not fully close that gap, plus two issues now fixed without a further read. The spec is not ready for approval until the operator settles the open finding and allows a further round or accepts it as it stands.
