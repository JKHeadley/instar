# Interaction family review — "Every reference to a waiting ask carries the ask" (2026-11-18)

## What changed in the Interaction family

One article, one added paragraph: *Agent Proposes, Operator Approves* gains a second named clause, placed right after the existing named clause "Every ask carries its links":

- **"Every reference to a waiting ask carries the ask."** Whenever a message mentions something the agent is waiting on the person for, in any message and not only the first one, it links the original ask (or the Work Board card that holds it, ideally both) and restates the ask plainly with the exact reply that settles it. A reference missing either one is a defect. Where a channel has no link to a single message the card link stands in, or failing that the conversation link; when no link can be built at all, the restatement carries it alone and the agent says so. A link is never written by hand. The clause does not license a reminder: whether a waiting ask is mentioned again at all stays with *The Agent Carries the Loop* and *Near-Silent Notifications*.

No article is added, removed, renamed or re-parented. No other family's text changes.

## Why

Justin, Telegram topic 141385, message 145323, 2026-11-18 16:23 PST, with a screenshot of an agent message ending "Still waiting on you: the screen-lock question I sent at 2:46.": "We should have a required standard that whenever the agent references something they are waiting on the user for they link the original message where the request was or a card that's been created. That has the details or ideally both". He approved the drafted standard in the same topic, message 145385, 17:33 PST: "standard yes". The existing clause covers the first ask only.

## Review

Round 1, author (echo:claude-code): wrote the clause from the approved draft, whose two requirements (link; plain restatement with the exact settling reply) are carried word for meaning. The design behind the clause's "Applied through" went through six rounds of spec review (`docs/specs/reports/waiting-on-you-links-convergence.md`).

Round 2, independent verifier (a separate read-only reviewer session given the diff and the family, not the author's conclusion): re-read every article of the Interaction family with the clause in place; checked each "Applied through" claim against the code (`B26_WAITING_ASK_UNLINKED` present and advisory, `src/core/messageLinks.ts`, `GET /messages/link`, `messageLink` on the Telegram and Slack reply responses, both reply scripts print it, the awareness entry, the development-agents-first switch); confirmed both quoted messages exist in the message log with the stated ids, times and wording. Verdict: accepted, no design finding.

### Findings and disposition

1. **The once-only rule was not stated.** "In any message and not only the first one" could be read as normalising repeat reminders against *The Agent Carries the Loop* ("surfaced ONCE, never nagged"). Resolved: the clause now says it does not license a reminder and names the two standards that govern whether one is sent.
2. **The second quote had no message id.** Resolved: message 145323 is named.
3. **Only one reply script was named.** Resolved: both `telegram-reply.sh` and `slack-reply.sh` are named; both print the link.

No unresolved design question. The operator's part is made by his code-owner review of the pull request: the clause changes the constitution.

## What this review does not establish

That the outbound rule judges every real message correctly: that is measured during the development-agent period described in the spec, and the rule is an advisory nudge. That reminders built by code (not written by a session) follow the clause: they are outside the rule's reach and tracked as feedback item fb-e3a446af-c59, which the clause itself says.

## Verdict

Interaction: accepted.
