# A reminder that you owe an answer now carries the ask and a link to it

<!-- bump: minor -->

## What Changed

A new standard is in the constitution, next to "Every ask carries its links": whenever an agent mentions something it is waiting on its person for, the message links the original ask (or the Work Board card that holds it) and restates the ask in one plain line with the exact reply that settles it. Approved by Justin on 2026-11-18 ("standard yes", topic 141385, message 145385).

Three things make it real:

- **Agents can link a message.** Every message sent through the Telegram or Slack reply route now comes back with its own link, and both send scripts print it after the usual "Sent N chars" line. A new route, `GET /messages/link`, builds the link to a Telegram message, a Slack message, a Work Board card or an app conversation from its ids, and says whether this machine's message log holds that message. Telegram search results carry each message's link.
- **A check on development agents.** The outbound reviewer has a new advisory rule, `B26_WAITING_ASK_UNLINKED`. A reply that points back at an ask the person still owes, without the link or the restatement, is handed back to the agent before it sends. It judges by meaning, and the agent can always send unchanged with a written reason. It reviews only messages written by a live session. It is off on other agents until two weeks of evidence on the development agent.
- **Every agent is told the rule** in its instructions on the next update.

## What to Tell Your User

When I remind you that I am waiting on you for something, the reminder now says again what I need and what reply settles it, and links to where I first asked, so you can answer right there without scrolling back. If I ever send a bare "still waiting on you", that is a defect: tell me.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| The link to a message just sent | It is printed at the end of the send output, and returned as `messageLink` by the reply route |
| The link to an earlier message, a card or a conversation | `GET /messages/link?platform=telegram&topicId=N&messageId=M` (also `platform=slack`, `card`, `app`) |
| Find an old ask with its link | `GET /telegram/search` rows carry `messageLink` |
| Turn the check on or off | `toneGate.waitingAskLinks.enabled` (unset: on for development agents only) |

## Evidence

Spec `docs/specs/waiting-on-you-links.md` (six review rounds; report `docs/specs/reports/waiting-on-you-links-convergence.md`). Tests: `tests/unit/message-links.test.ts`, `tests/unit/messaging-tone-gate-b26.test.ts`, `tests/unit/telegram-find-logged-messages.test.ts`, `tests/integration/telegram-reply-b26-waiting-ask.test.ts`, and the script output cases in `tests/unit/telegram-reply-suppressed-duplicate.test.ts` and `tests/unit/slack-reply-delivery-id-script.test.ts`. Real-model verdicts on the boundary cases and the live Telegram run are recorded in `upgrades/side-effects/waiting-on-you-links.md`.
