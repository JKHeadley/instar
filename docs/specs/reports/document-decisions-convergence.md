# Convergence Report — Document decisions: Approve and Decline on documents that ask for one

## Cross-model review: codex-cli:gpt-6-astra

GPT-tier (codex-cli, gpt-6-astra) ran in all six rounds. A clean-door Claude read (claude-code) ran in rounds 1, 2 and 6 (booked separately, not as cross-model). Gemini was not authed (`gemini-not-authed`). The Standards-Conformance Gate ran in rounds 1 and 2 (100 standards, not degraded; its flags were fed into the reviews).

## ELI10 Overview

When Echo writes a document that needs a yes or no from Justin, the document now carries the question and shows Approve and Decline. Justin answers in the Instar app on his phone with Face ID. On a computer, the page has one button that sends the question to his phone. His phone then posts "Approved version 2 of …" into the document's own conversation as his own message, and the document is marked with the version he approved.

Why it matters: on 2026-11-17 Justin approved a document by typing "approved" in a different topic, and the session that owned the document only found it by luck. Now the answer lives on the document, is tied to the version he read, and reaches the right conversation.

The main trade-offs: decisions need the phone (a web page served by Echo cannot prove a human tapped it); an owner with no Telegram gets a labelled, weaker proof; and while one of Echo's machines has not updated, decisions wait so that machine is never confused by rows it cannot read.

## Original vs Converged

- **Who can press it.** Originally the owner's phone or linked computer could approve from the page. Review showed the page's code is served by the agent itself, so a browser key (or a page asking the app to sign) is not proof of a human. Now: only a native sheet in the phone app, with biometric Face ID, decides; browsers and Macs send the question to the phone.
- **Which phones count.** Originally an allow-list of approval kinds. Review showed a PIN-approved phone could approve a second phone and launder it. Now the accepting machine walks the approval chain to its root; a Telegram root decides, a PIN root only on an agent with no Telegram owner (labelled), never agent-introduced or local-install roots, and Echo's oldest phone (no recorded approval) correctly reads as Telegram.
- **Who sends the message.** Originally the server would speak "as the owner" into the conversation. Review showed that bypassed the chat route's checks (authority tokens, credential policy, rate limit, routing, signed origin). Now the app sends the owner's message through the existing chat route, with a request id derived from the decision row so a retry can never send twice, and the delivery receipt is written only after the chat route's own record says delivered (not intercepted or refused).
- **What the signature binds.** The question's hash is now signed with the answer; changing an answer names the one it replaces; crossed answers are detected from the rows and keep the owner asked; a replaced question never comes back.
- **Rolling out on several machines.** A new row kind stalls older machines. Now every build advertises that it reads the rows, and writes wait until every recently heard peer does.
- **Work Board, Needs-you, Approval-as-Data.** Needs-you lists documents waiting on the owner (derived, so it clears on Approve and returns after a Decline plus a new version). The Work Board is not used (a card is a unit of work, not a question about a text). The Approval ledger is deliberately not fed: an approve-only feed would show 100% agreement by construction.
- **Telling the session.** Besides the owner's message, any machine running the conversation's session gets one fixed system line when a decision row arrives, and the documents block shows the state.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security/adversarial, integration/scalability, decision-completeness+lessons, codex, clean-door | ~30 | 6 | full rewrite: phone-only native decision, app-sent message, root walk, reader-first rollout |
| 2 | security+integration, decision+lessons, codex, clean-door | ~20 | 5 | approval chain root, no-Telegram path, request ids, push variant, Mac excluded, peer window |
| 3 | fresh internal, codex | 9 | 4 | allow-list consistency, Needs-you derived, ledger dropped, concurrent asks |
| 4 | fresh internal, codex | 5 | 3 | delivered means delivered, replaced asks permanent, crash recovery, shared titles, crossed clearing |
| 5 | codex | 2 | 1 | moved document during delivery, crossed keeps owner asked |
| 6 (cap) | codex, clean-door | 3 | 3 | visibility follows the question, derived first request id, notice from the session's machine |

## Proportion

Tier 2 (security-sensitive owner authority). Spec ~190 lines. Six rounds used of the Tier-2 cap of 6. Design findings fell every round (≈30, 20, 9, 5, 2, 3). Round 6 was the cap: its three design findings were applied to the spec and the build without a seventh round.

## Left behind

- A glossary of the viewer spec's terms for readers without it (precision).
- The peer gate's worst case (up to 7 days for a peer that never updates) is shown only in the 409 and `/docs/health` (precision).
- Crossed answers need two phones on two machines; kept because cheap (precision).
- PIN-approved phones still write comments and Send (foundation defect, separate from this feature): to the feedback queue.
- Typed "approved" in a chat: handled in the agent's awareness (ask the owner to tap Approve), not enforced in code (precision).

## Full Findings Catalog

Round reviews are summarised above; each round's verbatim reviewer output is in the session scratchpad for this run and the spec's text records each resolution in place (§3.1–§8).

## Convergence verdict

Converged at the Tier-2 cap (round 6). Design findings fell every round; the cap round's three were applied. None left open concerns safety, security or data loss. Ready for approval and build.
