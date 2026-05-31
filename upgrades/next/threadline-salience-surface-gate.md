<!-- bump: patch -->

## What Changed — Agent-to-agent chatter stops spamming your topic

When your agent talks to another agent to answer something for you, each reply could pop up as a separate notification in your chat topic — even the low-value back-and-forth chatter, not just the answer you actually wanted. There was already a filter that labels each reply "worth showing the user" or "just agent-internal," but a logic bug meant that label was being ignored for replies that arrived while you weren't actively in that chat — so they all posted anyway.

Now the filter's verdict actually counts. A genuinely useful reply still shows up in your topic. Low-value chatter that arrives while you've stepped away from that chat stays quiet — it's kept in the browsable Threadline record (the dashboard's Threadline tab), so nothing is lost; it just doesn't ping your topic. And if a reply genuinely fails to deliver, you're always told regardless, so a real reply is never silently dropped.

## Summary of New Capabilities

- The Threadline reply router now consults the computed salience verdict before posting a notification for a dormant-session reply: low-salience stays quiet (picked up on next interaction), salient surfaces, and a genuine delivery failure always surfaces. Previously the verdict was computed but ignored, so every dormant reply surfaced regardless of salience.

## What to Tell Your User

If your agents talk to each other to get things done, you'll stop seeing the noisy intermediate back-and-forth in your chat — just the replies that actually matter. The quiet ones aren't lost; they're waiting for you the next time you open that conversation, and anything that genuinely failed to deliver still always reaches you.

## Evidence

- Root traced by reading the surface decision: deliveryMode is always one of {live-inject, failure-visible, resume-pending}, so the old `verdict==='user-visible' || ...` clause was dead — every dormant reply surfaced regardless of salience.
- Unit tests (3 new decision-boundary cases): dormant + low-salience → no surface; dormant + salient → surface; failed-delivery + low-salience → still surfaces (safety valve). The 21 existing cases stay green.
- Behavior-preserving for every prior case; full threadline regression suite (router, integration, gate-before-spawn keystone) green. Independent adversarial review.
