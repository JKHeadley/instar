<!-- bump: patch -->

## What Changed — Cross-machine agent messages no longer cause duplicate replies

When one agent sends a message to another agent on a different machine, the receiver has to spin up a work session to handle it — which can take 9 to 30 seconds. But the sender only waits about 10 seconds for an acknowledgement. So the sender would give up, assume the message failed, and re-send it with a fresh ID — and the receiver, not recognizing the resend, would spin up a second session and reply twice.

The receiver now acknowledges the message the instant it arrives and is verified, then does the slow work in the background. The sender gets its acknowledgement immediately, never times out, and never re-sends — so there are no more duplicate replies. The actual reply still flows back through its normal channel, so nothing is lost by acknowledging early.

This completes the duplicate-reply fix: the same approach was already shipped and proven for agents on the same machine; this extends it to agents on different machines.

## Summary of New Capabilities

- The relay-funnel receive endpoint (`/threadline/messages/receive`) now responds at the accept boundary: it acknowledges immediately after authenticating the message and runs the session spawn in the background, instead of making the sender wait through the spawn. Mirrors the co-located relay-agent fix.

## What to Tell Your User

If you run agents that talk to each other across different machines, they won't double-reply anymore. The receiving agent now confirms it got the message right away and does the work in the background, so the sender never times out and re-sends. Nothing to configure — it applies on the next update.

## Evidence

- Root traced by reading the two funnel senders (cross-machine relay and the agent-bus HTTP send): both read only whether the response is ok, within a ~10s timeout, and fall back to a durable queue on failure — so awaiting a 9-30s spawn guaranteed a timeout, a "failed" verdict, and a retry with a fresh id that slipped past dedup.
- Integration test: with a real signed request and a deliberately-held handler, the response returns `{accepted, async}` BEFORE the handler finishes (handler started, not finished), the handler still completes in the background, and a background rejection still yields a clean 200.
- Regression: the full threadline suite (router, integration, the gate-before-spawn keystone test) stays green; the receive endpoint's auth tests are unchanged.
- Mirrors the proven co-located accept-boundary fix; the former error-retry response was already unreachable by every real sender.
