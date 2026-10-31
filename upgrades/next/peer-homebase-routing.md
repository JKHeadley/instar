## What Changed

- **A paired agent's messages meant for the user now land in that agent's own topic.** Each paired agent already had a `"🤝 <peer>"` Telegram topic, but nothing routed anything to it: a message went wherever its conversation started, or wherever the session handling it chose to post. Now the server itself posts a peer's user-visible message into the peer's topic, with a notification: with the default salience rule that is the first message of each conversation, and the session handling later messages is told which topic to use. Peers are recognised by fingerprint, never by the name they give, so an unknown agent cannot post into a paired agent's topic. A message the server does not post still reaches the Threadline hub as before. This covers replies to conversations started from another topic (the reply still reaches the session that asked; only the post the user sees moves) and messages on conversations with no topic. A conversation the operator tied to a topic himself still goes there. Agent-to-agent back-and-forth the user does not need keeps its existing routing.
- **Both sides of an invite pairing get their topic when the pairing completes.** Before, the side that received the invite got its topic only when the first message arrived, a minute too late for that message.
- **A session spawned for a peer conversation is told which topic to use for the user.**
- `threadline.peerHomebase.enabled: false` turns all of this off and restores the previous routing exactly.

## What to Tell Your User

When one of your paired agents sends something meant for you, it now shows up in that agent's own topic (named "🤝" and the agent's name) and buzzes you, instead of landing in whatever conversation it happened to start in. If you tied a conversation to a topic yourself, it still goes there.

## Evidence

- Unit tests cover the destination rule on both sides of each boundary (operator binding wins; origin-inherited and unknown-provenance bindings do not; no homebase keeps existing routing; the off switch; a throwing store), the relay (first message posted, agent-internal follow-up not posted, classifier-driven follow-up posted, operator-bound and no-homebase left alone, per-topic cap, send failure reported), the topic-linked reply surface (live-injected reply also posted to the homebase; unchanged without a redirect; operator-bound stays; failed hand-off surfaced in the homebase; agent-internal not posted), and the spawn-prompt topic hint.
- An integration test drives `/messages/relay-agent` and checks the message is posted to the homebase, not for an operator-bound conversation, and not for a peer without a homebase.
- An e2e wiring test checks the boot source wires the resolver to every delivery point and both pairing sides, and runs the real relay end to end.

## Summary of New Capabilities

- User-meant peer messages are posted by the server into the peer's homebase topic, with a notification.
- Homebase topics are created on both sides of an invite pairing at completion.
