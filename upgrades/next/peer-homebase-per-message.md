## What Changed

- **Every message a paired agent sends that is meant for the user now lands in that agent's topic, not only the first one of a conversation.** Each peer message is judged on its own: delivery receipts are recognised by their type and never posted; everything else is asked "is this meant for the person?" by meaning (Jev first when this agent has a Jev key, then a fast Codex model, then the agent's own model, so a Claude-only agent works too). A peer writing "tell Justin…" or "for your person…" counts. When no answer can be had, the message is posted anyway (a duplicate beats a missed notice). This applies to messages on conversations with no topic and to replies redirected to the peer's topic from a conversation started elsewhere.
- **The session handling a peer conversation is told, only when it is true, that the server already posts these messages,** so it does not post them a second time.
- Bounded: 300 model calls a day, 30 judged messages per peer per hour (past either, it falls back to posting only the first message of a conversation), and the existing three-posts-a-minute limit per topic (a held message is retried, not dropped). The scrubbed message text is sent to Jev (TypeSafe) or whichever model answers. A content-free record of each decision is kept in `logs/peer-user-meant.jsonl`; calls are metered under `peer-user-meant` on `/metrics/features`.
- `threadline.peerHomebase.perMessageClassification: false` (read live) restores the first-message-only behaviour.

## What to Tell Your User

When one of your paired agents sends you something during a longer conversation, every message meant for you now shows up in that agent's own topic, not just the first one. Back-and-forth between the agents that you don't need stays out of your way.

## Evidence

- Unit tests cover protocol exclusion, Jev confident and unsure, the referee chain on a single provider, no verdict posting, the daily cap surviving a restart, the per-peer limit, the deadline, secret scrubbing, content-free audit rows and the switch; the relay posting a second user-meant message inside a minute and not posting an agent-internal one; the redirected topic-linked reply; and the spawn prompt's "do not repost" line appearing only when true.
- An integration test drives `/messages/relay-agent`: the second user-meant message on one conversation is posted to the homebase, an agent-internal one is not.
- An e2e test checks the boot wiring and runs the production factory end to end.

## Summary of New Capabilities

- Per-message "meant for the user?" judging for paired agents' messages, with a live off switch.
