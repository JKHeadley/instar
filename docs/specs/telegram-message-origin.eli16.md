# Know which agent instance sent every Telegram message

Every message from an Instar agent should tell you which machine, harness and model it came from, without making you ask. A normal reply would end with:

**Echo · Mac Studio · Codex · gpt-6-astra**

The important part lives behind that line. Instar saves the message's origin every time. You can hide the line or individual fields, but that changes only what appears in Telegram. The audit record remains available. Everything starts visible, including on existing agents after the update.

## The requirement

This applies to every agent's Telegram messages, including bot replies and sends through your logged-in browser account. Machine, harness and model are the minimum. Recording is compulsory; display is optional. These are your September 5 requirements in topic 69507.

## What needs to be built

The earlier signature helps distinguish agent-written messages from messages you typed through the same account. The new metadata complements that authorship protection. Neither one gives an agent permission to act in your name.

Identity must come from the submitting session. If the Mac Studio writes a reply and the Mac Mini relays it, the message still identifies the Mac Studio. A topic's preferred model is not proof of the model that answered. Unknown evidence must say unknown; a configured model must be labeled configured if the current turn cannot be observed. Server notices identify automation rather than borrowing the conversation's model.

## Proposed engineering choices

- Agent-wide display preferences with conversation overrides and individual field switches. A shared Telegram message looks the same to every reader.
- Original metadata survives retries and machine moves. Edits add editor identity without erasing the first sender.
- Text and captions carry the footer. Captionless content needs a linked attribution message when display is enabled.
- The existing operator-account authorship marker is preserved. Hiding the cosmetic footer does not remove that protection.
- Agent-controlled Telegram browser profiles move behind a managed sender; agents still browse/read them, but sends go through the recorded operation. Your own separate personal browser is unaffected.
- Messages sent through your account must carry their authorship proof in the same text or caption. A format that cannot do that is refused before sending and needs an explicit signable representation. Sending an unsigned attachment first and its proof later would briefly make the attachment look like something you sent personally.
- Save intent before sending, then save the outcome. If the main origin store fails, try a separate durable local record and then a compatible peer. Delivery still needs its single execution queue to admit the operation safely. If Telegram may already have accepted it, do not blindly send a duplicate.
- Keep audit history available to the operator across machines: 30 days readily indexed, older metadata archived but searchable, retained unless you explicitly change retention. Temporary retry payloads have a separate bounded lifetime. Display settings change neither policy.

## What completion means

This must be enforced in transport code, including the browser execution path. An instruction to remember a footer is insufficient. Tests must exercise bot sends, browser sends, relays, retries, media, automated notices and hidden-display logging, with controls that fail when enforcement is removed.

Justin approved this design for implementation. **Runtime enforcement is not deployed yet.**

If recording fails everywhere, hold the message and notify you, as you requested. A fixed notice for your existing alert hub is recorded in advance while storage is healthy, so an outage notice does not break the recording rule. One notice covers an outage across conversations; it does not spam every chat or notify third-party recipients. It still works if the held browser message was going to a chat the bot cannot access. The dashboard also shows the hold. Telegram delivery of the notice can still fail if the network is down or the process restarted without a usable pre-recorded notice; the system must report that honestly. Final review covers this behavior before implementation.
