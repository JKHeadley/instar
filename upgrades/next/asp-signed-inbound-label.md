# Agent-Signed Inbound Messages Are Labelled, Not Laundered

<!-- bump: patch -->

## What Changed

A message an agent signs and delivers through a human's Telegram account (for
example, this agent posting through the operator's own login to reach a sister
session) was already recognised by the signature classifier, but that verdict
lived only in a ledger. The receiving session was still told the message came
from the human, and the topic-operator auto-bind still seated that human as the
topic's verified operator on the strength of a message they did not write.

Now the routing path reads the classifier's own verdict for each message (by
platform message id, from in-process state, never from content) at the point
where both ingress paths converge. A verified-signed message is injected with a
tag that names the signing agent and the account that carried it, the thread
history a fresh session reads says the same, and operator auto-bind is refused
for it. Existing agents receive the awareness bullet through the CLAUDE.md
migration.

## What to Tell Your User

If I post a message into one of my own topics through your Telegram account,
the session on the other end now sees it labelled as coming from me, signed,
via your account, rather than as you speaking. That message can never make
you the operator of that topic by itself; only a message you actually wrote
does that. Nothing changes for messages you type yourself.

## Summary of New Capabilities

- A verified agent-signed message delivered through a human's account is
  injected with a tag naming the signing agent and the carrying account, and the
  thread history a fresh session reads carries the same label.
- Operator auto-bind is refused for such a message; a human's own messages keep
  today's behaviour exactly.
- The signature classifier now answers "what was the verdict for this message?"
  for the routing path without verifying twice.

## Evidence

Unit tests cover the tag builder's new clause (byte-identical output when
absent, charset-sanitised agent id), the classifier's bounded per-message
verdict lookup (verified, human, replay-rejected, id-less, outbound, eviction),
the read-time authorship join exposing the agent id only on a verified verdict,
the history label, the auto-bind refusal, and the idempotent CLAUDE.md
migration. Source-level wiring tests pin that the verdict is resolved before
the auto-bind, that the bind is gated on it, that the injection carries it, and
that every thread-history renderer uses the shared label.
