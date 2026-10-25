# Agent-Signed Inbound Messages Are Labelled — Plain-English Overview

> The one-line version: when I sign a message and send it through your Telegram account, the session that receives it is now told "this is the agent, signed, via Justin's account", and that message can never make you the operator of that topic.

## The problem in one breath

I can already sign a message and send it through your logged-in Telegram, and the infrastructure can already prove I wrote it. But that proof only landed in an audit ledger. The session on the receiving end was still told the message came from you, and the automatic "who is the operator of this topic" binding still treated my message as evidence that you were present and in charge. That is exactly the identity mix-up the constitution forbids: a session acting on a name it did not verify.

## What already exists

- **Agent-signature provenance** — I can sign a message with my own key; every inbound message is checked, and a verdict (human, agent-verified, rejected) is written to a ledger. The ledger stores a hash, never the body.
- **The injection tag** — every inbound message reaches a session prefixed with a tag naming the topic and the sender. It was built from the Telegram sender only.
- **Topic-operator auto-bind** — the first authorised sender in a topic is recorded as that topic's verified operator, from the authenticated sender id.
- **Thread history on session start** — a fresh session reads the recent history of its topic, one line per message, labelled by sender.

## What this adds

The routing path now reads the classifier's own verdict for each message, at the one place both ways a message can arrive converge. When the verdict is "agent-verified", three things follow. The tag the session sees names the signing agent and the account that carried the message. The thread-history line says the same. And the operator auto-bind is refused, because the account holder did not author the message.

Secondary changes: the classifier remembers its verdicts by message id in a bounded in-memory map, because a signed message can only be verified once (the nonce is single-use, so a second check would call the genuine message a replay). The read-time history join now exposes the signing agent's id, but only on a verified verdict. The CLAUDE.md awareness section gains one bullet, and existing agents receive it through the migration.

## The new pieces

- **A small shared helper module** — resolves the platform message id from either ingress, asks the classifier for its verdict, decides whether auto-bind is permitted, and renders the history label. It reads in-process state only, never message content, so a body that merely claims to be signed cannot mint the label. It never throws; on any doubt the message is delivered unlabelled, exactly as today.

## The safeguards

**Prevents a forged label.** The label comes from the classifier's cryptographic verdict, keyed by message id. Nothing parses the message text for a signature at routing time.

**Prevents identity bleed.** An agent-signed message can no longer seat the carrying account's owner as a topic's verified operator. Everything a human actually types keeps today's behaviour, byte for byte.

**Prevents a delivery regression.** Every helper fails toward delivering the message unlabelled. A missing classifier, a missing id, or a thrown error means "unsigned", never "dropped".

**Does not grant anything.** The label says who wrote the message. It carries no permission, role, or trust; treating "signed by the agent" as authorisation remains a defect.

## What ships when

One change, one pull request. It is live the moment the server restarts on the new version. No configuration, no state migration; the awareness bullet reaches existing agents through the normal CLAUDE.md migration.

## What you need to decide

Nothing. This is the structural half of the sister-topic review loop you approved: it makes the receiving Codex session see my review requests as a peer's requests, not as your instructions.
