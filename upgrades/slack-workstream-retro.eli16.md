# Slack workstream retrospective and WS5 scope — plain-English overview

This change records what Instar-codey and Echo learned while bringing a dedicated demo Slack app from provisioning through a real end-to-end conversation path. It does not turn on any new Slack behavior. The retrospective captures the successful pieces—distinct app identity, verified permissions and channel membership, live inbound events, thread routing, and the source-bound reply relay shipped in PR #1518—and it names the failures that made those contracts necessary.

The most important lesson is that several green-looking signals are narrower than they appear. A connected Socket Mode WebSocket does not prove that Slack event subscriptions survived an app update. A manifest write does not prove a bot token gained the intended scopes. A plausible credential file does not replace a signed or owner-issued identity attestation. And a spawned session does not need arbitrary channel coordinates; it needs a narrowly bound way to answer the conversation that created it.

The document also scopes the next Slack increment without building it. Today the demo adapter observes and records decisions but does not autonomously speak. WS5 would prove a real authorized human can direct the agent in a demo channel and receive one useful, thread-correct response. That observe-to-respond transition is a genuine authority change. Tests and reviewers can show readiness, but only the operator may enable it. The proposed matrix covers authorized and unauthorized senders, ambient traffic, duplicates, recovery, cross-machine owner-dark behavior, one-voice delivery, rollback, migration parity, and cleanup.

The decision this document enables is simple: whether to authorize a future build of WS5 under those boundaries. This PR itself makes no configuration change, touches no Slack workspace, and grants no speaking authority.

Readers should treat the proposed matrix as a future acceptance contract, never as evidence that respond mode is already ready or enabled.
