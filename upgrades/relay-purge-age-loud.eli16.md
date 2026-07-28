# Outbound messages can no longer evaporate silently at server startup (and the purge window now survives restart churn)

When the agent can't deliver an outgoing Telegram message (server overloaded, mid-restart), the message goes into a durable queue, and a recovery engine delivers it when things settle. At every engine startup, a "restore-purge" deletes queued entries older than a threshold — the idea being that after a LONG outage, re-delivering genuinely ancient messages ("working on it!" from six hours ago) is worse than dropping them.

Two problems, both proven live today:

1. **The threshold was 5 minutes — tuned for a world where restarts are rare.** On a frequent-release day the server restarts every ~15 minutes, and the recovery engine restarts with it, running its purge at EVERY boot. Any message queued more than 5 minutes — which under restart churn is just a message that hasn't gotten a delivery window yet — was deleted. Echo's log shows five "restore-purged 1 stale rows" lines today; each was a real undelivered message, including a milestone report the user simply never received.

2. **The deletion was silent.** One generic log line with a count — no message identity, no topic, no content, and no signal to the agent that its outbound message evaporated. Every other loss path in the delivery stack is loud (the inbound drop path records the message, files a degradation report, AND tells the sender to resend); this was the last silent one. The agent went on believing the message delivered.

The fix: the default threshold rises from 5 to 60 minutes (still purging genuinely ancient messages after a real outage, but surviving restart churn; the existing config knob is unchanged for anyone who wants different). And the purge is now loud: before deleting, it lists every victim — message id, topic, queued-since, and a content preview — into the log, and files a degradation report naming them, so the agent learns the loss happened and can decide to resend instead of believing a ghost.

No state machine changes, no new config, no behavior change on the delivery/recovery mainline. Pinned by store tests covering both sides of the listing boundary and exact parity between what's listed and what's purged.
