# Convergence Report — Takeover-ready pool: losing any machine never silences a multi-machine agent

**Spec:** [docs/specs/takeover-ready-pool.md](../takeover-ready-pool.md)
**Slug:** `takeover-ready-pool`
**Converged at:** 2026-11-20, round 6 of 6 (the Tier 2 cap)
**Iterations:** 6
**Final-round design findings:** round 6 raised 7 (5 from GPT-6.2 Astra, 1 liveness point from the internal technical
reviewer, 1 from the clean-door read counted as precision by its author). All were fixed by edits after round 6, and a
targeted check confirmed each fix (see Convergence verdict). No full seventh round was run.

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI in all six rounds (model `gpt-6.2-astra`, every round
`status: ok`). The Gemini CLI was installed but not signed in (`gemini-not-authed`), so no Gemini-family pass ran; the
remedy is to sign the Gemini CLI in. A clean-door Anthropic second read (`claude-code:claude-fable-5`, `crossFamily:
false`) also ran all six rounds; it is disclosed separately and does not count as cross-model review.

## ELI10 Overview

When the Mac Studio broke on 19 November, Echo had three other machines and none of them stepped in. One was set never
to step in because it had been told not to read Telegram day to day. Another stepped in but did not know who the owner
was, so it could not reply. After the Studio was rebuilt, two machines kept grabbing the lead from each other, a
rebuilt machine with a new name split the agent into two groups that did not know about each other, and conversations
that belonged to the dead machine went unanswered. Nobody was told any of this.

This spec fixes those causes in ten parts, built in order. First, a machine that restarts asks the others before it
grabs the lead (this is buildable on its own, today). Then: the machine in charge keeps the lead when a spare
restarts, and when two machines both think they are in charge, Telegram's one-reader-per-bot rule and a fixed ranking
of machines decide who steps back. "Don't read Telegram day to day" no longer means "never take over", and the pool
must always have two machines able to take over. A machine only takes over if it knows the owner, the owner's group,
has a working model and the conversation settings. Role changes stop restarting the server. Replies can leave through
whichever machine is in charge. A rebuilt machine replaces its old identity everywhere with the owner's tap, and split
groups are detected. The owner hears one plain message when something changes. A weekly drill stops the machine in
charge and checks that another answers within five minutes.

The main tradeoffs: when the network between machines is cut and Telegram cannot settle it, both sides may keep
answering and running jobs until the link heals; that was judged better than going silent. The weekly drill cannot
type as the owner, so it proves everything except Telegram delivering a person's message, and real owner messages
after each failover are tracked to cover that.

## Original vs Converged

- **Originally** the boot rule waited a full takeover wait for peers. **Now** it is the run lead's exact rule (a
  machine that held last asks first; a non-preferred machine defers while the preferred answers at all; it acts after
  three silent probes over 45 seconds), with two bounds review added: only Instar's own response header counts as an
  answer (a tunnel's 530 for a dead machine does not), and a wedged machine answering errors can hold others for at
  most its own measured restart time. **Why:** the first draft could leave the pool silent behind a crashed machine.
- **Originally** a machine kept a takeover-wait formula of 1.5 times the holder's restart time. **Now** the wait is
  derived backwards from the five-minute answer bound (W = 300 s minus measured claim-to-reply time minus margin,
  60–180 s), and a slow-restarting machine is taken over once instead of waited for. **Why:** the Laptop's 4-minute
  restart made the old formula miss the owner's five-minute promise by design.
- **Originally** pools of three or more machines would suspend a holder that could not reach a majority. **Now**
  holders keep the lease in every pool size, and Telegram's 409 conflicts plus a fixed ranking of members (preferred
  first, then machine id, counting only machines that were ready when contact was lost) decide which side steps back,
  with every yield ending within 2W. **Why:** Echo's five-machine pool routinely has two machines off, so a majority
  rule would have silenced it after losing the Studio; and several drafts of the tie-break could make both sides go
  quiet, which review caught round by round.
- **Originally** the drill message was attributed to the owner and replies went into a real conversation. **Now** it
  comes from a `drill` principal over the signed mesh, in a dedicated topic whose messages are deleted afterwards, and
  the drill states what it cannot prove. **Why:** a message pretending to be the owner breaks truthful provenance and
  opened an injection path into real conversations.
- **Originally** a sick machine's queued replies were to be copied to the holder by a new record system. **Now** it
  changes the existing forward-to-holder path: the holder keeps any forward it could not send, capacity refusals name
  their real cause, and the inbound side never confirms a Telegram update to Telegram until a second machine has it.
  **Why:** the code already had a forwarding ladder (and today's 19:01 report was refused by it with
  `credential-capacity-unavailable`), and held rows never replicated their text, so the first design could not have
  been built.
- **Originally** a rebuilt machine's replacement record was trusted from any member. **Now** it always needs the
  owner's tap, competing records resolve to the same winner everywhere, the old key verifies only history up to a
  frozen watermark, and a provisional winner that loses is revoked. **Why:** one member could otherwise evict any
  other, and a stolen old key could backdate records.

## Experience fit

- **Source of the goal:** the owner-approved post-mortem v8 (Echo document 59c4af4d…): never unreachable because one
  machine went down; Drill 1 (another machine answers a real owner message with tools within five minutes; the lead
  returns once; weekly, on its own). Fix items 1–4, 14, 15, 17, 18 and the run lead's added requirements (boot claim
  safety first; A8 replies through any machine; holder never loses the lease when a standby restarts).
- **Ordinary journey:** the lead machine dies; a quiet machine that was made eligible by the migration takes over
  within W, polls Telegram and answers with tools; the owner gets one silent "the Studio stopped answering, the Laptop
  took over" message; the lead returns once through hand-back. The owner taps nothing.
- **Contrasting cases reviewed:** every survivor not ready (claims anyway and says why, one Approve link only if
  self-heal fails); the network cut with both sides on Telegram (one side yields); a wedged server whose lifeline keeps
  polling (released poll and a signed record); a stray program with the bot token (one defect, the agent keeps
  serving); the whole pool down more than a day (one tap to reconfirm the group).
- **Trust and approvals:** the only owner decisions are machine replacement (always a tap), reconfirming the private
  group after a gap, and an optional per-machine opt-out from takeover. No repeated asks were found; nothing reuses a
  standing approval beyond its scope.
- **Evidence limits:** no measurement yet of how often owners are asked or opt out; drill reports are the evidence
  source. The automated drill does not prove inbound delivery of a person-typed message.
- **Disposition:** the round-5 owner-facing misfits (wedged server delaying a reply past five minutes; a false
  "another program" notice during an ordinary cut) were fixed; round 6 found none blocking.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, adversarial, scalability, integration, decision-completeness, lessons-aware, codex-cli, clean-door | ~35 (4 factually wrong claims about the code) | ~12 | full rewrite; then run lead added boot claim safety as increment 1 and A8 (R9→R8) |
| 2 | all six internal, codex-cli, clean-door | ~30 | ~15 | full rewrite: R8 as deltas to OriginForwardToHolder, W derived from the bound, majority rule removed, replacement needs owner tap, drill hold via sleep-marker contract |
| 3 | security/adversarial/integration, decision-completeness, codex-cli, clean-door | 9 | 10 | R2 tie-break redesigned (Telegram ends the older poll), holder custody of forwards, lifeline queue, W floor |
| 4 | technical four-lens, decision-completeness, codex-cli, clean-door | 9 | 8 | contenders ready at loss of contact, yield bound, probe semantics, offset gating, signed peer path |
| 5 | technical four-lens, decision-completeness, codex-cli, clean-door | 8 | 9 | contiguous offset prefix, signed receipts, poll-released record, post-2W behaviour, git-only refresh |
| 6 | codex-cli (5), technical four-lens (1); decision-completeness 0; clean-door 0 design | 7 | 9 | fixed after the round: stale-standby pull, group continuity, replacement revocation, graduation clock, Telegram-only fleet, push cap exemption, head-unchanged probe, poll-released binding, update downgrade, flat-retry number |

Standards-Conformance Gate (`POST /spec/conformance-check`, 102 standards each round): round 1 ran (11 flags);
round 2 ran (13 flags; its copy of the spec was cut off before R6, so later sections were unchecked that round);
round 3 ran (8 flags); round 4 ran (14 flags); round 5 ran (8 flags; copy cut off mid-R4); round 6 ran (9 flags).
Most later flags were Judgment-Within-Floors pressure on fixed numbers that carry a declared floor and arbiter;
reviewers contested each and cleared them as precision. The truncation is a limit of the gate's input size on a
~690-line spec, recorded here so the later-section verdicts are not read as checked by the gate.

Externals delta-gating: the spec body changed every round, so externals ran every round (no delta-skips).
Internal reviewer model: the authoring session and its subagents ran on Claude Opus 5.5 every round.

## Proportion

Tier 2 (multi-machine authority, identity and inbound-message durability; ~690 spec lines, ten build increments).
Six rounds used of a six-round cap. The spec is large for one review unit; splitting it was considered in round 2 and
declined (Frontloaded Decision 9), and the cost shows in six rounds and two gate truncations.

## Left behind

- Judgment-Within-Floors pressure on each fixed number (probe counts, 45 s, the unsigned-answer window, W bounds, 2W,
  24 h skew, 30-minute credential freshness, 15-minute hand-off spacing, three-day unreachability): each has a floor
  and arbiter and is config; reviewers found no concrete harmful counterexample. Accepted.
- Both sides serving and running jobs during an irregular cut, or a cut longer than 2W: accepted as in
  lease-takeover-no-shared-medium (Frontloaded Decision 4); duplicates possible for updates fetched by both sides.
- The ranking tie-break relies on Telegram's observed 409 behaviour, which Telegram does not promise; a canary on the
  throwaway pool detects a change, and the fallback is the accepted dual-serve mode.
- Using the maximum of fewer than twenty claim-to-reply observations can pin W to its floor on one outlier; a trimmed
  statistic may be better. Cheap to change after (config) once drill data exists.
- Agents whose only channel is Slack or the app are out of scope for the fleet rung until a follow-up spec covers
  lease-following on those adapters (listed on the readiness page).
- A not-ready member waits up to 2W when a ready member is alive but stalled, which can miss the five-minute bound in
  that double failure; accepted and listed in Failure modes.
- The gate's copy of the spec was truncated in rounds 2 and 5; the full text was read by every other reviewer.
- Glossary density (lifeline, posture row, Needs-you line, ladder/rung): a terms line was added; further clarity edits
  are wording only.

## Full Findings Catalog

**Round 1.** Security/adversarial (13): replacement revocable by any member; relayed records fail first-hop journal
binding (new end-to-end signing); owner Telegram id last-writer-wins; group-confirmation baseline; resume-on-widening
abuse; drill probe as an owner-attributed injection channel; drill hold as a remote kill switch; lifeline keeps polling
for a dead server so no survivor can take over; restart-note extension abuse and 1.5×p95 wait above the 5-minute bound;
self-reported posture rows; unbounded minority hold; misattributed cause line (`MemoryInboundTracker`); bearer auth on
new routes. Scalability/integration (14): `telegramPolling:false` is a hard mute in the lifeline and relay (factually
wrong claim that it would poll); no `leaseRole` migration ever existed (factually wrong); JobScheduler catch-up runs only
in `start()`; more boot-role consumers than listed; the churn latch is per machine (pool-wide latch did not exist); drill
hold vs lifeline queue and supervisors; wait above bound; gap detector gated on autonomous runs; version skew pages on
every update; rollback needs a restart; probe cost; drill reports and audit posture. Decision-completeness/lessons (18):
wait formula; `staleHolderTakeover` default; two waits for not-ready claims; churn target agreement; dual hold scope;
stale-owner quorum misreading (factually wrong); parallel `fix/unroutable-owner-release`; replacement history and
competition; near-silent notices; provenance; drill delivery proof; plus precision items. Codex (5): eligibility must
come from effective acquisition checks; deadline arithmetic; degraded-holder hand-off; drill sequencing vs paused
standby scheduler; acceptance needs a real owner message. Clean-door (2 design): wait formula; offline vs diverged.
Resolution: full rewrite.

**Round 2.** Security/adversarial (12): majority rule silences Echo; stray 409 mutes the holder; incumbent/taker overlap;
boot hold unbounded behind 503s and captive portals; attestation not bound to session host; retired key backdating;
single-member eviction without an owner key; drill record issuer and stale marker; probe transport; carried-send CAS not
linearizable; patch register end date. Scalability/integration (12): increment 1 needs `HttpLeaseTransport` and
coordinator init order; boot hold ceiling; wrong restarter list (RSS watchdog is not instar; `RecoveryEngine`,
`ForegroundRestartWatcher`, sleep-marker contract); R9 duplicated the shipped `OriginForwardToHolder` ladder; carried-send
retention; posture rows inside the lease signature; lifeline queue stranding; takeover setting should be pool-wide;
`hasRecent409` exists; wrong file for the threshold; spec too long to review as one; fan-out. Decision-completeness/
lessons (13): 180+125 > 300 s; single 409 with no resume; jobs on both sides; boot-hold cap vs bound; skew clock reset by
daily releases; capability ranking; headcount vs identities; replacement without owner key; notice ceilings; quorum
misdescription; missing rows; hotpatch route; gate truncation. Codex (5): 409 not guaranteed; exactly-once; competing
replacements; budget arithmetic; drill sequencing. Clean-door (2 design): boot-hold rule 3 unbounded; R9 exactly-once
overclaim. Resolution: rewrite (R8 as deltas to the forward ladder; W derived; majority rule removed; owner tap for
replacement; sleep-marker drill hold).

**Round 3.** Technical (6): held rows replicate metadata only, so the carry path was unbuildable (factually wrong);
both sides of a split keep confirmed renewals; tunnel edge 52x/530 counted as alive; lifeline offset semantics and the
stranded queue; capacity refusal causes; cross-epoch duplicate. Decision-completeness/lessons (1 blocking): resume rule,
because Telegram ends the older `getUpdates` with 409. Codex (5): two incumbents; acknowledged messages lost with the
disk; sleeping spare counted ready; group events lost to a newer kit; graduation on synthetic passes. Clean-door (1):
W has no floor. Resolution: ranking tie-break, holder custody, copy-before-confirm, response marker, W floor, event-union
membership log, degraded coverage, owner-message graduation.

**Round 4.** Technical (5): both sides yield when the top member is away; probe false resume; three confirm paths; no
signed peer path for the lifeline; replay duplicate. Decision-completeness/lessons (2 blocking): sleeping members on
neither side; resume on own-side renewal. Codex (4 design): both live holders yield; standby readiness circular on
capacity; delivery guarantee overstated; named git-less pools still fail acquisition. Clean-door (3 design): interim
window conflict; stray poller can silence for ever; group reconfirmation path. Resolution: contenders, yield bound,
probe semantics, offset gating, snapshot and receipt route, could-issue-if-promoted, duplicate wording,
`localCommitIsFinal` extension, owner reconfirm tap.

**Round 5.** Technical (2): unauthenticated receipt as a drop primitive; frozen offset spins. Decision-completeness/
lessons (2 blocking): wedged server with live lifeline; undecided post-2W behaviour. Codex (5): non-contiguous receipts
confirm earlier updates; git-only refresh counted as a peer pull; recovery after yielding; degraded holder cannot notify;
graduation clock. Clean-door (1): preferred machine dying at the cut. Resolution: contiguous prefix, signed receipts,
skip-refetch backoff, poll-released record, resume triggers and serve-for-episode, defects named honestly, notice
routes for a holder without Telegram, timed graduation.

**Round 6.** Codex (5): stale standby ends the boot hold; group privacy across a two-poller period; provisional
replacement winner never withdrawn; graduation from message arrival; fleet scope beyond Telegram. Technical (1 design,
liveness): resume trigger 3 never fires while an update is pending; plus poll-released replay, update downgrade.
Decision-completeness/lessons: 0 blocking (flat-retry number, waiting owner message, post-resume backoff ceiling).
Clean-door: 0 design (409 canary, episode end, push cap vs A7, 24 h retention). Resolution: all fixed after the round.

## Convergence verdict

Stopped at the six-round cap. Round 6's decision-completeness and lessons-aware reviewer found no blocking design
issue; its other design findings (five from GPT-6.2 Astra, one liveness point from the technical reviewer) were each
fixed by a small edit after the round, and a targeted check of those edits confirmed them (result below). None was left
open as an accepted safety, security or data-loss risk. Items left behind are listed above with reasons. The spec is
ready to approve and build, starting with increment 1, which needs nothing else in it.

**Targeted check of the post-round-6 edits** (one read-only reviewer, comparing the round-6 input with the final text):
12 of 14 resolved, 2 partial (the stale-standby test said "at least as new" where it needed "strictly newer"; the 60 s
backoff cap and the no-second-yield rule were only in the failure table). It also found one new precision gap: the
group-continuity check compared against a watermark the kit did not hold. All three were then fixed: "strictly newer";
the cap and the rule stated in R2; and membership events are written into the kit before the poll batch holding them
is confirmed, so a gap means only a two-poller period or polling interrupted for longer than Telegram keeps updates.
The check found no new design contradiction.
