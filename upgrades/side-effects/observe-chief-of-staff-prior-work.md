# Observe prior work after a verified Chief of Staff delivery

Tier 2 first build slice of the reviewed work-start and dispatch specification. The existing verified-owner Telegram poller plain-text ingress invokes a public-only observation after a successful injection into an existing local session. A separate, explicitly enabled development flag controls it. It returns no evidence to the session and changes no action or ownership decision.

## Decision points and interactions

The existing owner/topic check is reused, with the current switch and sender checked again around the public read. No part of message text is authority. A distinctive literal is a retrieval hint and one observation runs at a time. Overload and source failures can be recorded as unavailable or busy. The audit sink receives an outcome enum only. The public provider instance is shared with the HTTP pull request route and the private Work search, and its existing query-independent network refresh never sends the owner's text or extracted literal.

The hook follows the existing successful local injection and stall tracking. It schedules the read as background work. It does not alter delivery receipt order, use a new queue, or enter queue drain, Mesh RPC acceptance, bootstrap, respawn or older forward fallback. Lifeline inputs, media transcripts/captions, sender-unverified input and platform-forwarded copies do not carry the required direct poller text proof. Receipt and sender scope on the other transports stay under their existing handlers.

## Over-block and under-block

The opt-in skips uncertain owner events, replays, agent/mobile-authored inputs, and prose without a recognized literal. This can miss known work. The literal can also match unrelated PRs. Neither outcome blocks delivery or establishes absence. Failure of a report callback cannot surface a replacement message.

## Authority, external surfaces and rollout

The observer is strictly advisory and never supplies prompt context, invokes an outbound action or modifies results. The only new I/O is a bounded refresh through the already approved public GitHub provider and a content-free local outcome. That provider refuses an unverified repository visibility. The CLI boot and ordinary route share their cache without creating another inventory. A warm cache may be rebuilt independently on another machine. Observer process state is disposable, and no durable proof is transferred or re-used across machine handoff.

Rollback disables the development flag or removes the observer hook. There is no state migration or new operator action. Real queued/forwarded shadow behavior and unprompted owner-channel answer, replay and assignment proofs are outside this initial slice.

## Verification

Type checking and diff checks passed. Focused unit tests passed 39 cases across the observer, real Telegram poller provenance and public provider. Focused integration tests passed 14 cases across actual local Telegram routing and the public PR HTTP route. The same local routing test rejects a production-shaped forwarded voice transcript whose callback carries an empty media array and no explicit forward metadata. Six production AgentServer lifecycle cases passed, including a shadow lookup followed by the ordinary HTTP route without another GraphQL refresh. Tests use controlled external boundaries. Independent second-pass review concurred after rejecting non-poller and media inputs and correcting the shared provider binding. Real owner-channel proof remains pending.
