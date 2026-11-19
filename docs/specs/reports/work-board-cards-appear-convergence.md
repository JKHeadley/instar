# Convergence Report — Work Board cards actually appear

**Spec:** [docs/specs/work-board-cards-appear.md](../work-board-cards-appear.md)
**Slug:** `work-board-cards-appear`
**Iterations:** 6 (Tier 2 cap: 6)

## Cross-model review: codex-cli:gpt-6-astra

RAN. A real GPT-tier external pass ran through the agent's codex CLI in all six rounds (model `gpt-6-astra`), each against that round's revised body. Gemini was detected but not signed in (`gemini-not-authed`) and Grok not enabled, so one external family ran. The clean-door Anthropic reviewer was available but not run. The internal lenses ran as subagents on the authoring session's model (Opus 5.5): round 1 as three paired subagents (security + adversarial, scalability + integration, decision-completeness + lessons-aware), round 2 as two (safety lenses, system lenses), rounds 3 to 6 as one all-lens reviewer that also read the draft code.

## ELI10 Overview

Echo's Work Board is a list of cards, one for each thing the agent needs from Justin. It worked but was always empty, because nothing ever made a card: sessions asked in Telegram, and the Chief of Staff, which already knew seven projects were waiting on Justin, kept that in its own note. This spec makes cards appear. The Chief of Staff opens one card per waiting project, with what the check saw, the goal and checklist, a recommendation and why it needs Justin, and closes it by itself when the wait clears. Sessions are told to write a card instead of a chat question, and every card the agent writes must say what it recommends and why it needs Justin.

Two rules change. A card that only asks Justin to do something no longer waits for an Approve tap, because there is no agent work for an approval to cover. To keep the guarantee that Approve used to give (Justin sees every agent card before it finishes), the agent can no longer finish such a card itself: only Justin's Confirm done does, except the Chief of Staff's own wait cards, which close on a recorded check. And each need now shows once: when a card is about an item already in "Needs you" (a waiting project, a plan or a pull request), that item stays in its own words with its own button and simply links to the card.

The trade-offs: the "write a card instead of asking" part is an instruction, not something code can force; passwords, permissions, money, health and promises can never be covered by a card; and a machine on an older version shows the new cards more cautiously until it updates.

## Original vs Converged

- **Hiding things.** The first draft let a card fold any Needs-you item under itself, replacing the source's words with the agent's. Now only plans, pull requests and the Chief of Staff's own waits can be covered, the source row always stays with its own words and button, and a card that asks for Approve, an answer or a Confirm done never hides behind another row.
- **Closing an ask nobody saw.** Removing the Approve tap first let the agent open and close an ask on its own. Now an agent's claim on a card Justin carries always needs his Confirm done (only the Chief of Staff's mirror cards are exempt).
- **Two machines at once.** The first draft compared wall-clock times to stop a stale machine writing. Now each card remembers the exact Chief of Staff record it reflects and compares clocks of the same kind; closes are keyed so a retry writes the same records; a racing second "created" can no longer scramble a card's history; and a card closed on a clearing record cannot be reopened by a machine that has not seen that record.
- **Getting the wait right.** The card now shows when the wait actually started (not the latest check), carries a wait id so two waits never look identical, ignores a re-delivered pause button, treats a park as closing the wait and an unpark as able to reopen it, and does not rewrite a card Justin finished while the same wait continues.
- **Server-owned.** Sessions and edits cannot change the Chief of Staff's cards; only Justin's taps and the Chief of Staff itself can.
- **Limits and brakes.** The card text fits the board's own limits by shortening the checklist (and saying so), a refused create waits for the next check instead of retrying every 15 minutes, and the card's conversation is re-checked every sync.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex, security+adversarial, scale+integration, decisions+lessons; gate 4 flags | 13 | 9 | cover allowlist, source row kept, owner-confirms, server-owned, fence, created race, need churn, ceiling, graduation |
| 2 | codex, safety, system; gate 4 flags | 7 | 6 | HLC fence on mirror, created-first fold, claim rule in fold, person edits refused, linkable cards only, closed bindings |
| 3 | codex, all-lens; gate 6 flags | 4 | 4 | wait id, retry brake, session duplicates, close moves mirror, plan key alias |
| 4 | codex, all-lens; gate 4 flags | 5 | 3 | wait start, effective pauses, close after reopen, mirror to newest, need within limits, conversation healed |
| 5 | codex, all-lens; gate 3 flags | 5 | 2 | park/unpark boundary, finished-while-waiting, repair path, breaker, scoped sessions, item shortening disclosed |
| 6 | codex (2 design, left behind); all-lens: no DESIGN findings; gate 4 flags | 2 (accepted at cap) | 5 | two one-line precision fixes in passing (close-evidence lower bound, transient refusals retry next tick) |

Standards-Conformance Gate: ran every round (rounds 1 to 6: 4, 4, 6, 4, 3, 4 flags; never degraded). The repeating flags are listed under Left behind with a reason.

## Proportion

Tier 2; spec about 230 lines; code about 14 files. Six rounds used of the cap of six. ⚠ Every round still found design-class edge cases in the Chief of Staff mirror's state machine (multi-machine ordering, episode boundaries); the residue at the cap is about stale-but-self-correcting display, not safety, security or data loss.

## Left behind

- **Structure beats Willpower (gate, rounds 1 to 6):** "write a card instead of asking" is an awareness instruction. The structural half shipped (the Chief of Staff, the largest source of asks, writes its cards itself). A structural nudge on outbound decision asks belongs in the outbound tone gate as its own change; it goes to the feedback queue.
- **Cross-Machine Coherence, lease epoch (gate, rounds 2 to 6):** no lease epoch exists to fence board writes on. The mirror fence makes a stale holder write nothing it has seen superseded, and a doubly-stale holder's one write is corrected by the next up-to-date sync. Accepted: the worst case is a card briefly showing an older state; nothing is approved, sent or lost.
- **Judgment Within Floors, ceilings (gate):** `maxAgentCardsPerDay` and `softOpenCards` are the board's existing owner-set limits (work-board-asks Fixed limits), not new here; a capped wait still shows as the Chief of Staff's own row.
- **Judgment Within Floors, cover allowlist (gate):** promises are excluded by decision 6 of the front-doors spec and because their row keys carry no source prefix; widening it is a later, separate decision.
- **Never Silently Cut (gate):** the 500-character note is the Chief of Staff store's existing limit; the 200-character checklist items and the need cut are disclosed on the card with where the full text is.
- **Late intermediate record (codex r6):** a clearing record that replicates after a later waiting check is noticed on the next Chief of Staff record, not at once. Accepted: self-correcting display.
- **Verdict ordering around a handoff (internal r6):** the folded latest verdict sorts checks by wall clock while the card's sources sort by HLC; with clock skew around a lease handoff a card can show a stale verdict for up to one check cadence. Accepted: bounded, self-correcting.
- **Answer in the card's chat (codex r6):** a person who replies in a wait card's own chat reaches that card's session, not the project's. The recommendation says to reply in the project conversation; routing card chat to the project belongs to slice 3 (the card actions and embedded conversation), which is being built in parallel and is told.

## Full Findings Catalog

Round 1 (13 design): covers could bury security rows and replace source text; positional keys; agent self-closing owner-carried cards; sessions editing wait cards; soft-cap slice; fixed-id create skipped the ceiling; repeat count from history; need churn per check; parked/breaker double rows; reopen-after-owner-reopen; graduation metrics skew; archived card never reopens (frontloaded); lease-race recreate and flip-flop; rollback honesty; older builds. Resolved as listed in Original vs Converged.
Round 2 (7 design): person-written cards finishing on agent claims; earliest-created rule not buildable; card tucked behind a row; person edits of server cards; HLC vs wall-clock fence; closed bindings read as absent; derivePickupCauses ordering. Resolved.
Round 3 (4 design): same-minute episodes; session card duplicating a wait card (awareness); claims-done linkable; close did not move the fence. Resolved.
Round 4 (5 design): conversation crash recovery; need over the limit; wait start from the newest record; mirror after close; redelivered pause. Resolved.
Round 5 (5 design): competing create after close (repair path); scoped sessions; breaker transition; park/unpark reopen; finished-while-waiting rewrites. Resolved.
Round 6: the internal all-lens reviewer found no DESIGN findings (three precision items: two fixed in passing, one, verdict ordering by wall clock vs HLC around a handoff, left behind as a bounded one-cadence display lag). Two codex findings left behind above.

## After convergence: the build's second-pass review

The /instar-dev second-pass reviewer raised two concerns, both resolved in the spec before approval: an agent session's card covering a plan or pull request could make its own ask less visible (now only the Chief of Staff's server-owned wait cards drop their own row; a session's card keeps its row and the covered row links to it), and the mixed-version behavior of server ownership and the claim rule was unstated (now in Multi-machine posture with its bound). A Maturation plan section was added for the tag writer.

## Convergence verdict

Converged at the round cap (6). The remaining findings are about briefly stale card display that corrects itself, or belong to the parallel slice 3; none concerns safety, security or data loss, so they are recorded as accepted risks above. Ready for approval under the standing rule (no constitution file touched).
