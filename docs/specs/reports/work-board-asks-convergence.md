# Convergence Report — Work Board, phase 1: a card for everything the agent needs from a person, whose chat is a native conversation

**Spec:** [docs/specs/work-board-asks.md](../work-board-asks.md)
**Slug:** `work-board-asks`
**Iterations:** 6 (Tier 2 cap: 6)

## Cross-model review: codex-cli:gpt-6-astra

RAN. A real GPT-tier external pass ran through the agent's codex CLI in every round, 1 to 6 (model `gpt-6-astra`), each against that round's spec body (hashes in the Iteration Summary). Gemini was detected as installed but not signed in (`gemini-not-authed`) and Grok as not enabled, so one external family ran.

Clean-door Anthropic reviewer: available on this agent (`claude-code:claude-fable-5`) but not run. The six internal lenses ran as subagents on the authoring session's model, Fable 5.2, in every round. In rounds 5 and 6 the six lenses ran as three paired subagents (security + adversarial, scalability + integration, decision-completeness + lessons-aware), each reporting its two lenses under separate headings.

## ELI10 Overview

Right now, if your agent needs something from you (a yes, an answer, a sign-off), that need can sit in half a dozen different places, and a plain question in a chat sits in none of them. Luna built a card board for SageMind that fixed this for three people, and it worked very well. Its one real weakness was that the chat on a card and the conversation where the work actually happened were two separate things, so things got copied by hand and the card fell behind.

This spec builds the first piece of that idea into Instar itself. There is a page called Work, and its first lane is "Waiting on you". Each card says what is needed, what done means, who is carrying it and who has to act next, and each card has its own chat that is a real Instar conversation. When you type on a card the agent gets it at once. The rules that matter are enforced by the system, not left to the agent: only a person can approve, your tap covers exactly what you saw, you can always stop a card, nobody types a status, and a card only finishes with evidence.

The main trade-offs: this first piece is deliberately small. Cards are carried by the agent or by the team owner, and only the team owner taps; teammates can see and discuss cards shared with them. Scheduled progress reports, cards that block other cards, several boards, teammate approval, handing cards to another agent and client-visible cards are later phases, tracked under CMT-1420. Whether "done" evidence is actually true is not something the system can check in this phase; it makes agent-finished cards visible and reversible instead.

## Original vs Converged

- **Who needs approval.** Originally a card needed approval when its "owner" field said the agent. Reviewers pointed out the agent sets that field, so it could skip approval by naming a person. Now approval follows who actually wrote each important part of the card: if the agent wrote any of it, a person approves; if the team owner wrote all of it, that was the instruction.
- **What a tap covers.** Originally a tap was tied only to the card's main text. Now it is tied to everything the person was shown: the wording, the checklist and who may tick each item, the links, the question, and for a sign-off the exact evidence. If any of it changes afterwards the tap stops counting, and nothing comes back to life if a field is changed and changed back.
- **Stopping always works.** Hold, withdraw approval, reopen, archive and remove can never be refused, even when the card just changed or another machine is behind. Originally they could be.
- **The agent cannot hide or fake things.** Approval and sign-off became states the system works out, not questions the agent writes, so the agent cannot move a card out of your lane while it needs you. It cannot archive a card, change a finished one, or quietly swap one question for another.
- **Handing work to the agent.** The first draft only started work after a tap and retried on restart. Now any event that makes a card ready starts it; if no session is free the card says so and keeps checking; if the hand-over fails three times the card comes back to you with the reason and a Try again; and if a machine dies mid-hand-over, anything that sends outside the team waits for you rather than risk being done twice.
- **Team scope.** The first draft let teammates carry and finish their own cards. The code for that (a conversation a teammate owns, teammate approval) does not exist yet, so it moved to phase 3 with the reason stated.
- **Things removed for being wrong about the code.** A promise record mirrored per card (promises are stored per machine and could not be kept in step), a claim that conversations have an archive flag (they do not), a claim that the journal is in backups (it is not; the build adds it), and several smaller claims were corrected against the source.
- **Sensitive text.** Added late: card text is checked for passwords and keys on every write and refused, and a person can remove a card's text from every screen. The bytes leave disk at phase 2's cleanup, and the spec says that plainly.

## Iteration Summary

| Iteration | Spec body hash | Reviewers who flagged design issues | Design findings | Left behind | Spec changes |
|---|---|---|---|---|---|
| 1 | `57edccf6` | all six internal + Astra | 37 (many duplicates across lenses; 18 distinct) | 9 | Full rewrite: vocabulary, approval rule, tap binding, member cards cut, pointer brief, single-home table, retry |
| 2 | `27a59c39` | all six internal + Astra | 27 (17 distinct) | 14 | Per-field last writer, pickups from workable events, derived asks, restricting taps, archive taps, park, corrected source claims |
| 3 | `5111e327` | all six internal + Astra | 20 (14 distinct) | 17 | §5 and §6 rebuilt: transition-derived pickups, capacity wait vs spending attempts, policy as a record, one hash, `systemSource` |
| 4 | `8cf01f0d` | scalability, adversarial, decision-completeness, integration, lessons + Astra (security: none) | 13 (8 distinct) | 21 | Mirror commitment removed; `quiet` status; reopen generation; anti-flapping; `with-person`; owner-change wait |
| 5 | `2b0c5527` | all three paired reviewers + Astra | 14 (8 distinct) | 15 | Ledger note on every machine by id; exact "caught up" definition; two park kinds; no-revival rule; `redact` and write-time credential guard |
| 6 | `2f3b0878` | security, adversarial, decision-completeness + Astra (scalability, integration, lessons: none) | 6 (5 distinct; all in pieces added during review) | 18 | Direct text fixes, then one verification read (see Convergence verdict) |

Standards-Conformance Gate: ran in every round (7, 4, 3, 3, 4, 3 flags). The three flags that persisted from round 3 to round 6 (the 200-a-day ceiling, the default approval policy, `systemSource` being dropped by older builds) were each ruled "not a violation" by the lessons-aware reviewer in rounds 4 and 5, with reasons recorded under Left behind.

## Proportion

Tier 2 (new replicated store, new person-approval surface, changes to the app-conversation dispatch path). The spec is about 400 lines. Six rounds were used against a cap of six. That is the full budget, and it is proportionate to a feature whose core is "who may approve what": design findings fell from 18 distinct in round 1 to 8 in rounds 4 and 5, and from round 4 on they concentrated in pieces added during review, not in the original design.

## Left behind

Precision and long-tail items not iterated on. None changes what gets built in a way a reviewer classed as design.

- The console PIN proves knowledge of the PIN on that machine, not a person at the keyboard. Stated in §4 as the existing Approvals posture; each tap records which proof it had.
- A session can post an ordinary reply that imitates a "Work board:" line. Surfaces style a line as the board's only by the card store's id list, and the hand-over re-checks the store.
- Gate flag, 200-a-day ceiling: only the existence of a ceiling is the invariant; the value is owner-set, the refusal names the reset time and the other two ways through.
- Gate flag, default approval policy: the default is the operator's own rule from Luna's board, waiting cards are visible, and the alternative is put to the operator with the spec.
- Gate flag, `systemSource` on older builds: a distinct role would be refused outright by older builds, which loses the line; the id list is the structural channel on builds that have the feature.
- An agent that touches a card just to look busy can keep it out of `quiet`. Stated in §6; the remedy is phase 2's leases.
- A web link is approved as an address, not as the content it serves later. Stated in §1 and on the approval screen; fixed content goes in an attached file.
- The stop brief is an instruction to a session, not a mechanical halt. What the store enforces is stated in §6.
- At the daily ceiling the journal would grow about 1.3 GB a year and the index would hold every finished card in memory; the 64 MB event is the only signal until phase 2's compaction.
- The capacity probe should name the limits it mirrors and must not write to the admission audit log (the second is stated in §6).
- `run-once` catch-up for the graduation job asks before replaying after a takeover unless the lease provider vouches for the missed run.
- Machines may briefly disagree on the `quiet` lane at the boundary because of clock skew.
- The policy-change prompt counts cards that would start, not cards that would stop.
- Agent records per card are unbounded in number; each is bounded in size.
- A narrow double hand-over race (an old owner makes its intent durable after the new owner read its advert): closed in round 6 by the ownership re-check after the durable intent.
- The credential guard runs at the route; records arriving by replication were already checked on the machine that accepted them. It has no override, so a false positive means rewording; the refusal names the kind matched.
- A person's hold-then-release clears an "agent keeps changing this card" park. Accepted: a person acted.
- A Try again on a quiet card whose session is in fact alive injects a recovery brief into working context. Harmless.
- "No record that changed a material field": two machines making the identical edit count as one change of value; the fold compares values.
- Earlier backups still hold a removed card's text. Stated beside the button.
- The boot fold should stream archives rather than load them whole.

## Full Findings Catalog

Organised by round. "→" gives the resolution taken.

**Round 1**
- Security, adversarial: approval keyed on agent-set `owner`/`outward` → approval follows authenticated authorship.
- Security, lessons, integration, Astra, decision-completeness: member-owned cards unreadable by their creator, no routes, no bounds → cut from phase 1 with reason.
- Security, adversarial: taps not bound to the ask shown; console path did not recompute; signature covered only the title → full action payload bound on both paths.
- Adversarial, decision-completeness: `agent-may-certify` claim about the Chief of Staff false; deterministic items closed on free text → own item type; claim corrected; graduation samples agent-finished cards.
- Adversarial, Astra: dispatch did not re-check the tap; hold and withdraw had no brief; approval could revive → re-fold, stop brief, never-revives.
- Scalability, lessons, integration, adversarial, decision-completeness, gate: no retry cadence → timed retry.
- Decision-completeness, lessons, integration, scalability, gate: sizes did not follow from the 16,000-character cap → pointer brief; record ceiling with a stated basis.
- Decision-completeness, lessons, scalability, gate: budgets 20/30 as hard refusals → soft budget; one daily ceiling.
- Integration: conversation creation not idempotent on card id → derived key.
- Lessons, integration: brief had no system identity; no delivery record; outbox machine-local → system origin; replicated `dispatched`.
- Integration: phone taps not provable on any machine → machine-local with justification.
- Astra: concurrent edits vs writer-supplied hash; evidence survived checklist edits → fold computes hashes.
- Security: close ignored approval and hold; agent close could outrank reopen → derived finishing.
- Security: scoped sessions could list or create across places → per-card only.
- Scalability: no retention posture; fold per request → `rotateKeep: 0`, in-memory index.
- Lessons: seventh need surface with no single-home rule → table.
- Lessons, gate: blanket approval vs standing authority → policy setting, flagged to operator.
- Decision-completeness: iPhone screen and real-phone proof inside the run boundary → boundary moved.

**Round 2**
- Adversarial, Astra: approval rule had two wordings; owner typo fix laundered agent scope → per-field last writer.
- Adversarial, Astra: work needing no tap never dispatched → pickups from workable events.
- Astra, lessons: stop dispatch contradicted the void check and could spawn → live-only injector.
- Adversarial: reopen undone by re-claim with old evidence → evidence after reopen; sign-off after any reopen.
- Security, Astra: confirm-done not bound to evidence shown; claim id not signed → claim lists evidence; full payload signed.
- Security, decision-completeness, lessons, scalability: stop taps and stale cards refusable → restricting taps never refused; warning only.
- Adversarial: archive had no person path → archive and unarchive taps.
- Adversarial, decision-completeness, lessons, gate: agent could hide a pending approval; ask auto-closed → derived states; explicit replacement.
- Decision-completeness, lessons, gate: blanket project refusal → structural floor plus judgment row.
- Scalability, lessons, gate ×2: retry had no breaker → park.
- Integration, lessons: four false claims about source (archive flag, dispatch outcome, backups, `rotateKeep`) → corrected.
- Astra: at-least-once with no mechanism → intent record, recovery brief.
- Lessons: L16/L17 citation untruthful → corrected; mirror commitment added (later removed).
- Security: `msp` role unstated → row and test.
- Decision-completeness: iPhone source not on this machine → Mac Studio named, completion test.

**Round 3**
- Scalability, security, integration, lessons, adversarial: mirror commitment could not be opened as described, crowded the beacon cap, could start a session → no topic, no beacon (removed in round 4).
- Scalability, decision-completeness, lessons, integration, adversarial, gate: park basis and clock → capacity wait never parks; spending attempts counted in records.
- Integration: admission did not cover capacity; spawn admitted as operator → pure probe; `automatic`.
- Adversarial: refused attempt looked like a crash; recovery hold had no writer → closing record; outward cards park.
- Decision-completeness: answer on a non-workable card voided → answer-only brief.
- Astra, adversarial, security: pickup causes missed unarchive and policy change → transition-derived.
- Adversarial: agent archive contradicted an invariant; restricting taps that did not restrict; policy outside the fold; whole-form post laundering → all four fixed.
- Lessons, gate: transcript lines with no carrier → `systemSource`.
- Astra: stale execution before replication; completion surviving scope change; intent durability → eventual revocation stated; one hash; durable acknowledgement.

**Round 4**
- Integration, lessons, scalability, adversarial: mirror commitment not unified across machines, full-store writes, auto-expiry loop → removed.
- Adversarial: agent could flap workable; agent edit unfinished a confirmed card; crashed attempts uncounted → fixed.
- Decision-completeness: team-owner-carried card had no status → `with-person`.
- Astra: owner change before replication; reopen out-sorted by later records; `unknown` still workable; link URL does not bind content → owner-change wait; reopen generation; workable requires readable; stated plainly with attachment links.

**Round 5**
- Scalability, decision-completeness, adversarial, Astra: `quiet` source, index and Try again → card records only, read-time lane, retry binding.
- Integration, security, adversarial: ledger entry machine-local, title leak, kind never closes → note on every machine, id only.
- Integration: no truthful caught-up signal → exact definition and detector.
- Integration, security: attachment id not content-addressed → sha256 in the link.
- Adversarial, Astra: ownership changes re-armed decision parks and bypassed the cap → two park kinds.
- Astra: evidence and claims could revive → no-revival rule.
- Astra: withdrawal precedence → unconditional.
- Lessons, gate: no permitted deletion; secrets in a permanent store → `redact`, write-time credential guard.

**Round 6**
- Scalability, integration, lessons-aware: no design-class findings. Integration re-ran Standard A (passes in both directions) and confirmed the new source claims: the credential guard is a pure text function already called from a route helper; a live-apply hook separate from the boot fold exists; ledger kind `note` is valid; the journal reader does report `current` unconditionally, as the spec's caveat says.
- Security and decision-completeness (same finding): `redact` was not wired into the pickup path, so a removed card was still workable. SECURITY class → workable and the done-claim rule exclude removed; `redact` is a stop cause that voids pickups with a title-free brief; later non-tap records are refused.
- Adversarial: a decision park's uncertainty was lost when the park was voided, so withdraw-then-approve could hand an `outward` card over as ordinary work. SAFETY class → uncertainty is a fact about the card until a recovery-brief pickup succeeds.
- Astra: a work brief could follow its own stop when a hold landed during the durability wait → re-check after the durable intent; one delivery queue per conversation.
- Astra: a release that never saw a concurrent restriction could erase it → releases name the restriction they lift.
- Astra: the capacity probe blocked delivery to a session that was already running → a free slot is needed only when a session must be started.

## Convergence verdict

**Converged at the round cap (6 of 6), with one honest caveat.** Round 6 was not a quiet round: three of the six internal lenses found nothing that changes the build, but the other three and the external reviewer raised five distinct design findings, two of them classed safety or security. All five were in pieces added during review (the `redact` tap from round 5, the park and recovery machinery from rounds 3 to 5), not in the original design, and each had a direct, small fix.

The skill's rule at the cap is that safety, security and data-loss findings go to the operator. I did not leave them open for him: each was fixed with a direct text change, and one verification read (not a seventh review round) then checked the five fixes and the mechanical gates. Its result is recorded below. The operator should read this section before applying `approved: true`, because the final text of those five fixes has had one read, not a full seven-reviewer round.

**Verification read:** findings 2 to 5 were confirmed resolved with no contradiction introduced, and the mechanical gates passed (steps numbered 1 to 7 consistently, every decision row classified, no open questions). Finding 1 (`redact`) met all five expected points but the read found two remaining ways a removed card's title could still reach a session: a pending answer pickup on a held or unapproved card, and the system tag on the stop brief, which carries the title by definition. Both were closed with one sentence each after the read (answer pickups are voided on a removed card; after a `redact` the stop brief's tag carries the card id). It also caught that the "refuse everything after a redact" rule would have refused the controller's own closing records, which is now exempted, and one stale test phrase, which is corrected. Those last edits have had no further read. The read also noted one mild tension that is left as is: a re-approved `outward` card that is marked uncertain gets the recovery brief without being parked again, and relies on the warning shown on the approval screen.

**Final spec body hash:** `fb2f6c2d`. The round-6 external pass reviewed `2f3b0878`; the five fixes came after it.

Decision-completeness, final round: 29 frontloaded decisions; 0 cheap-to-change tags; 0 open user decisions. One choice is put to the operator with the spec and has a safe default: the approval policy (`every-agent-card` by default, `outward-only` as the alternative).
