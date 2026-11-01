# Convergence Report — Machine self-maintenance

## Convergence verdict: CONVERGENCE FAILED AT THE ROUND CAP

Six rounds were used, the Tier 2 cap. Round 6 still raised DESIGN findings, and three concern safety or data loss. Under the skill's rule that exit is `convergence-failed` and the operator is asked. The fixes for every round 6 finding are in the spec, but **no reviewer has read them**. The spec carries `convergence-status: failed-at-cap` and has no `review-convergence` tag and no `approved: true`. `/instar-dev` will refuse to build from it, which is the correct state.

The trend was narrowing, not stalled: round 1's findings were structural (a readable password path, resume entries destroyed before the reboot), and round 6's are about the timing of checks at the edges.

**Decision for the operator:** allow one more review round on the final text, or accept the spec as it stands. Recommendation: allow the round.

## Cross-model review: codex-cli:gpt-6-astra

Real external passes ran in all six rounds, each returning a verdict, on a changed body each time. Round 1 first degraded on the agent home's stale module (`gpt-5.5`, `error`); that attempt is not counted, and the worktree was rebuilt with sibling `node_modules` to reach the current reviewer.

⚠ Gemini did not run (`gemini-not-authed`). Grok did not run (`grok-not-enabled`). The clean-door Anthropic read returned `no-supported-framework` in round 1 and was not retried. Every external round's verdict was SERIOUS ISSUES, including round 6.

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
| 6 | all-lens, Astra | 5 | 9 | ran (2 flags) | Fixes applied, **unreviewed** |

Internal reviewers ran as Claude subagents on the authoring session's model, Opus 5.5, in every round. Rounds 1–2 used split lens groups; rounds 3–6 used one reviewer holding all six lenses, a reduction from six independent reads that a reader should weigh.

## Proportion

Tier 2, spec 506 lines, 6 of 6 rounds. ⚠ The spec grew from about 49 KB to about 69 KB across review. It is large for one document, though the build order splits it into five parts and later runs.

## Left behind

Gate flags, recurring through round 6, not resolved:

- *Structure beats Willpower:* a session can run the sudo rule directly. Accepted: same OS user, and a wrapper cannot authenticate its caller either. Detected at the next boot.
- *Mobile-Complete Operator Actions:* a Mac with no passwordless sudo and no desktop path needs a person at the machine once. Accepted: a macOS system password box needs a screen.

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

**Round 6, resolved in the text but unreviewed.**

| Finding | Reviewer | Concerns | Resolution applied |
|---|---|---|---|
| Final safety check came before a 90 s wait, and none before Rung 2 | Astra | Safety | Fresh check before every privileged dispatch, inside the lock |
| Same-user apps with unsaved state undetected | Astra | Data loss | Bounded the promise to identifiable work; enrolment acknowledgment naming open apps |
| Rung 3 could restart the helper during a live grant | All-lens | Safety | Presence gate on rung 3 |
| Abandoned entries could release on an unrelated reboot | Astra | Work loss | Entries bound to episode and a dispatch record; reconciled at expiry and start |
| Part B cannot hold on Windows | All-lens | None | `not-covered` in v1 |

## Counts

Frontloaded decisions 14, cheap-to-change tags surviving 0, contested-then-cleared 4 (round 6). Open questions 0. No constitution file is touched.

## Conclusion

Not converged. Round 6 found design issues about safety and data loss, and the round cap stops review there. The spec is not ready for approval until the operator allows a further round or accepts it as it stands.
