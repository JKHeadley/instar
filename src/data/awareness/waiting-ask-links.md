---
title: Every reference to a waiting ask carries the ask
---
Whenever I mention something I am waiting on my person for (a question, approval, decision or reply), in any message and not only the first one, the message carries two things: a link to where the ask lives, and one plain line restating the ask with the exact reply that settles it, so they can answer from that message alone. "Still waiting on you for the screen-lock question I sent at 2:46" with no link and no restatement is a defect.

- **The link.** A link to the original message, or to the Work Board card that holds the ask, ideally both. Where the channel has no link to a single message, the card link stands in, or failing that the link to the conversation. Only when no link can be built at all does the restatement carry it alone, and then I say so plainly.
- **Where the link comes from. Never write one by hand.** When I send a message, the send output ends with the message's own link (`Sent N chars to topic T (message M) link: <url>`; Slack prints `(ts T) link: <url>`). I keep that link for the ask. Later, I get one from ids I hold:

```
curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/messages/link?platform=telegram&topicId=N&messageId=M"
curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/messages/link?platform=slack&channel=C…&ts=T"
curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/messages/link?platform=card&cardId=wc_…"
curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/messages/link?platform=app&conversationKey=<uuid>"
```

- **Reading the answer.** For Telegram it returns `verified` and, when found, `matched` (who sent that message and its text): I read `matched` to check the link points at the ask I mean. `verified: "not-in-local-history"` means this machine's log does not hold that message (another machine may have served the topic, or it is older than the kept log): unconfirmed, not wrong, and I say so if I use it. A `409 not-linkable` names why; `retryable: true` means try again shortly. `localOnly: true` means the link opens only on this machine, not on a phone.
- **Finding an old ask.** `GET /telegram/search?q=…&topicId=N` rows now carry `messageLink`. `GET /attribution/trace?q=…` finds a message by meaning across my machines. If I cannot find the original, I open a Work Board card holding the ask (putting any link I have in the card's links) and link the card.
- **The check.** Where it is switched on (development agents first; `toneGate.waitingAskLinks.enabled`), the outbound reviewer hands a reply back with `B26_WAITING_ASK_UNLINKED` when it refers to an earlier ask my person still owes and lacks the link or the restatement. It judges by meaning, not by phrases. It is a nudge like any other: fix it and resend with `--tone-complied B26_WAITING_ASK_UNLINKED`, or, when no link can exist, resend unchanged with `--tone-ack B26_WAITING_ASK_UNLINKED --tone-reason "<why>"` (flags go before the topic id). A first ask is not a reference to an earlier one; it follows "Every ask carries its links".
