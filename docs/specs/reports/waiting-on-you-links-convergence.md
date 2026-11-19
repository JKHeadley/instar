# Convergence Report — Every reference to a waiting ask carries its ask

## Cross-model review: codex-cli:gpt-6-astra

A real outside-family review (GPT-tier, through the agent's own codex login) ran in all six rounds. The Anthropic clean-door second read (`claude-code:claude-fable-5-2`, not a cross-model opinion) also ran in all six. Gemini was not signed in on this machine (`gemini-not-authed`) and Grok is not enabled, so those two families did not run.

## ELI10 Overview

An agent told Justin "still waiting on you: the screen-lock question I sent at 2:46" and gave him nothing else. To answer, he would have had to scroll back and find that message. He asked for a required standard: any time an agent says it is waiting on the person, it links the original message or the card that holds the ask, ideally both.

This spec writes that standard into the constitution and builds the parts that make it real. First, the outbound message reviewer gets a new nudge: when an agent's reply points back at something the person still owes and it lacks the link or a plain restatement of the ask, the reply is handed back to the agent to fix before it sends. The reviewer judges by meaning, not by keywords. Second, agents get links they can actually use: every Telegram or Slack message they send now comes back with its own link, and a small tool builds a link to any message, card or app conversation from its number. Third, every agent is told the rule in its instructions.

The main trade-offs: the nudge starts on Echo only and reaches other agents after two weeks of evidence; it only checks messages written by a live agent session, because a scheduled notice built by fixed code cannot respond to a nudge and would simply lose its reminder (those are tracked as their own follow-up item); and it never blocks, the agent can always send with a written reason.

## Original vs Converged

The first draft was simpler and wrong in several ways that review caught:

- **It would have lost reminders.** The draft applied the nudge to scheduled and code-built messages too. Those senders cannot answer a nudge, so their reminder would have been dropped. Now only live-session replies from senders that can react are checked.
- **The agent would never have seen the link.** The draft added the link to the server's answer but the script agents use to send throws that answer away. Now both send scripts print the message number and link.
- **A made-up message number produced a confident link.** Now the link tool says whether this computer's message log actually holds that message and shows its text, and the reviewer is shown what each linked message says, so a link to an unrelated message does not count.
- **A word-match search was dropped.** The draft let agents search a topic by words inside the link tool. That would report a reworded ask as missing and only saw one computer's history, so it was removed; existing search tools now return links instead.
- **It started everywhere at once.** Now it starts on development agents and goes to the fleet on recorded evidence.
- **It named code that does not exist** (a link-origin helper) and would have handed out a localhost link after a long tunnel outage. Both fixed.
- **Topics in the separate Issues group would have got broken links.** Found in the last round; now those topics link into their own group.
- **Several fixed limits were challenged and changed**: a three-link cap and a 64 MB log cutoff were removed (the cutoff would have switched the feature off on Echo's own healthy log), and the two limits that remain (a size budget for linked evidence, and a 750 ms allowance to gather it) are disclosed in the prompt and can never cause a nudge on their own.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security+adversarial, scalability+integration, decisions+lessons, codex, clean-door, constitution check | 13 distinct | 12 | Whole design section rewritten: reply-only gating, script prints link, `verified`, link kinds, dev-gate, real origin resolver, search dropped |
| 2 | all three internal pairs, codex, clean-door, constitution check | 8 | 9 | Prompt-id suffix `-b26`, link only on the delivered answer, Slack script, search rows carry links, linked-message facts, fallback rule channel-independent, graduation hand-grades |
| 3 | all three internal pairs, codex, clean-door, constitution check | 6 | 6 | Log lookup redesigned (one async pass), 3-link cap removed, workspace pending vs unsupported, unfindable original → card |
| 4 | scalability+integration, decisions+lessons, clean-door, constitution check (codex: none) | 3 | 7 | 64 MB cutoff removed, full linked text with a stated positive use, fallback ladder aligned with the standard |
| 5 | security+adversarial, codex, clean-door, constitution check (two internal pairs: none) | 4 | 6 | Evidence budget, capability facts, card facts, 750 ms allowance, "evidence for B26 only" |
| 6 | scalability+integration, codex, clean-door (two internal pairs: none) | 1 fixed + 4 accepted at the cap | 8 | Issues-group topics; whole-block budget; abort on timeout; limit bases restated |

Standards-Conformance Gate: ran every round (round 1: 5 flags; 2: 2; 3: 2; 4: 2; 5: 1; 6: 1), never degraded.

Per-round model disclosure: the internal reviewers ran as subagents of the authoring session (claude-fable-5-2); the three reviewer sessions each carried two lenses (security + adversarial; scalability + integration; decision-completeness + lessons-aware) and were continued across rounds so each re-read knew what it had raised. All six lenses ran every round.

Round count: 6 of the Tier-2 cap of 6, plus one verification read (not a review round) by the integration reviewer after the round-6 Issues-group fix, which confirmed the fix against the code and reported no remaining design finding.

## Proportion

Tier 2. About 430 lines of source across 11 files plus one new 190-line module, 5 test files, a 170-line spec. Six rounds, the cap. That is a lot of review for the size, and most of it was spent on one late addition (showing the reviewer what a link points at), which brought three rounds of limit and cost findings with it. Worth saying plainly: the rule and the link builder converged by round 2.

## Left behind

Accepted at the cap (design-class, not safety, security or data loss), each with its reason:

- **Capability vs. one ask (codex, round 6).** The reviewer is told what the channel can link, which is not the same as whether this particular ask can be found. Addressed in the rule text (a plain "the original could not be found" passes), not with a new fact. Risk: a false "could not be found" passes. It is an advisory rule and the hand-graded sample reads passed replies.
- **Slack links get no "what does it point at" facts (codex, clean-door).** Only Telegram links are checked against the local log. Slack links are judged on their shape and the message text. Reason: the Slack log lookup would be a second mechanism for a channel with no live evidence yet; the fleet review looks for Slack citations before the flip.
- **Untrusted linked text sits in a prompt that also serves blocking rules (clean-door, round 6).** It is JSON-quoted inside a per-call boundary, capped at 16,384 characters, and labelled as evidence for B26 only. A structural fence (a separate model call) was not added: it would double the review cost for every reply with a link. A unit test pins that injected text stays inside the quoted block; the live cases include no successful steer.
- **The evidence budget is a chosen default, not derived from model capacity (constitution check, rounds 5 and 6).** Stated as such in the spec, disclosed in the prompt, never a ground to fire, and revisited if hand-grading shows a miss caused by it.
- **The development-agent nudge is live before fleet-scale evidence (constitution check, Judgment Within Floors).** The test-agent stage records real-model verdicts on the boundary cases first; the nudge is the operator's approved shape and never final.

Precision items not iterated on:

- Console links carry the answering machine's tunnel address; with a rotating quick tunnel an old card link stops opening. True of every console link the agent sends today.
- A backwards log scan could stop early because Telegram ids rise over time; not done, the 750 ms allowance bounds it.
- No per-message anchor in the app console; app asks link to the conversation or a card.
- GovSlack workspaces are refused (`workspace-unsupported`).
- The graduation numbers (10 citations, 80 percent, 18 of 20) are a judgment call for one agent on Telegram; the fleet review says so.
- Local terms ("lease holder", "redrive", "development agent") are not defined for an outside reader.
- The parent-principle fit reads "weak" to the constitution check: the clause sits under *Agent Proposes, Operator Approves* because its sibling clause does, and the independent family re-read accepted the placement.
- Whether the screenshot message was written by a session or by code is not established; a code-built one falls to feedback item fb-e3a446af-c59.

## Experience fit

- **Source.** Justin, topic 141385, message 145323: link the original message or the card, ideally both, whenever the agent says it is waiting on him; approved as drafted in message 145385. The draft also requires the restatement.
- **Ordinary journey.** He reads a reminder, sees the ask restated with the reply that settles it, and can answer right there; one tap opens the original if he wants the context.
- **Contrasting cases.** The same reminder in other words is caught (judged by meaning). A first ask passes (it is not a reference). An app ask links to the conversation or a card, not the single message. A code-built reminder is not checked (tracked). A session that never saw the original link gets it from the card, from search rows, or opens a card.
- **Evidence limits.** The graduation evidence measures the rule's precision and whether bare references still get through; it does not measure whether he answered faster. Unmeasured, not zero.
- **Disposition.** Delivers the stated outcome for session-written messages on Telegram and Slack; partial for the app; not for code-built reminders, which is said in the standard itself.

## Full Findings Catalog

Round 1
- Constitution check: word-match search inside the route (Recall by Meaning) → search removed. 1,000-row window → removed with the search. Machine-local recall → removed. Live before evidence → dev-agent gate and graduation. Ladder "not applicable" → real ladder entry.
- Security+adversarial: named origin helper does not exist and `tunnel-wait-exceeded` returns localhost (DESIGN, fixed); automated senders cannot react (DESIGN, fixed: reply-only); a made-up id yields a confident link (DESIGN, fixed: `verified` + `matched`); precision: id encoding, second success branch, `unknown` kind, signal wiring, B19 overlap.
- Scalability+integration: senders without `liveArtefactSignals` would lose messages (DESIGN, fixed); script hides the link (DESIGN, fixed); feature registry entry missing (DESIGN, fixed); B22 comparison wrong (DESIGN, fixed: B25 mechanics); link count proves nothing (DESIGN, fixed: link kinds); prompt id mixes two prompts (DESIGN, fixed: suffix).
- Decisions+lessons: script hides the link; scheduled senders; channel parity and live proof on both channels (DESIGN, fixed: Slack link + live plan); precision: evidence source, first-ask owner, chat id source, latency.
- Codex: a full restatement could bypass the link (DESIGN, fixed: both required); app links do not reach the message (DESIGN, fixed: stated weaker stand-in).
- Clean-door: nothing checks the link is real (fixed); native reply-to not considered (decision 14); capture at ask time is Telegram-only and not durable (fixed: Slack link, search rows, card).

Round 2
- Both scalability and adversarial: `+b26` breaks the label format (DESIGN, fixed: `-b26`); the `recorded` branch is a held message, not a forwarded send (DESIGN, fixed).
- Decisions+lessons: Slack script still hides the link (DESIGN, fixed).
- Codex: fallback differs between standard and rule (fixed); graduation measures half the rule (fixed).
- Clean-door: no durable link record (search rows, card `links` field); judge given shape not target (fixed: linked facts); localhost card link counts as a card (fixed: `localOnly`).
- Constitution check: live before evidence; 1,000-row verification window (fixed: exact-id lookup).

Round 3
- Adversarial: "found however long ago" is false, the log rotates (DESIGN, fixed).
- Scalability: whole-log synchronous read on the reply path (DESIGN, fixed: one async pass).
- Decisions+lessons: the 3-link cap is unjustified (DESIGN, fixed: removed).
- Codex: unbounded history reads; permanent rejection labelled retryable (fixed: two reasons).
- Clean-door: an ask that cannot be found has no path (fixed: open a card); reply-to for unlinkable chats (decision 14).
- Constitution check: 3-link limit and excerpts.

Round 4
- Scalability and decisions: the 64 MB cutoff trips on a healthy log; measured on Echo's own log at about 833 bytes a line (DESIGN, fixed: removed).
- Clean-door: linked facts have no stated positive use (fixed); fallback ladder contradicts the standard for private chats (fixed).
- Codex: no design finding. Precision: `other`-link exception (removed), B19 validation, "no data is written" wording.
- Constitution check: excerpt sizes not derived (fixed: full text); 64 MB cutoff.

Round 5
- Security+adversarial: full linked text is unbounded in the prompt and could turn an advisory rule into a hold (DESIGN, fixed: budget).
- Codex: the judge has no capability facts for a "no link can be built" claim (fixed: `canLink`); evidence collection unbounded (fixed: allowance).
- Clean-door: `fixed-limits: none` lets the rule cause a hold (fixed); card links unverified (fixed: card facts).
- Constitution check: an unconfirmed link counted as confirmation (fixed: UNCONFIRMED wording, under-fire default).
- Scalability+integration and decisions+lessons: no design finding.

Round 6
- Scalability+integration: Issues-group topics would get broken links (DESIGN, fixed and verified).
- Codex: capability vs recoverability; Slack capability absent (fixed: channel-neutral `message`); evidence limit bounded text only (fixed: whole block; abort signal).
- Clean-door: conversation context unspecified (fixed: stated; the review receives recent messages); untrusted text in a shared prompt (accepted, see Left behind).
- Constitution check: budget not derived from capacity (accepted, see Left behind).
- Security+adversarial and decisions+lessons: no design finding; limit bases restated per their precision notes.

## Convergence verdict

Converged at the Tier-2 cap (round 6), with one verification read after the last fix. The final internal reads found nothing that changes what gets built; five design-class items are accepted with reasons above and eight precision items are left behind. Decision-Completeness, final round: 19 frontloaded decisions, 1 cheap-to-change tag (the fleet-dark switch), 7 contested and cleared, 0 rejected, 0 open user decisions. The spec is approved by Justin's "standard yes" (message 145385); the constitution edit additionally needs his code-owner review on the pull request.
