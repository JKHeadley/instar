# Delivery Reliability Recovery Hardening — Plain-English Overview

> The one-line version: if a reply or an autonomous run falls between the cracks, Instar must notice, recover safely, and remain responsive while it does so.

## The problem in one breath

Echo’s Mini had 33 replies sitting in a durable queue, including one meant for the operator five days earlier. The database query knew those replies were ready, but the general recovery worker was never started because it was still behind an old default-off switch. During the same morning, a still-active autonomous run had no live session for an hour, but the liveness watcher recorded nothing because an old pause on a different recovery queue suppressed detection. Separately, creating an alert could hang the web request while Telegram was slow.

All three failures have the same shape: the system recorded enough truth to recover, but lifecycle wiring prevented the truth from advancing.

## What already exists

- **A durable reply queue** — failed replies are saved in SQLite so a hard restart does not have to lose them.
- **A safe reply recovery state machine** — it claims one row, verifies the agent identity, applies the tone rules again, retries with backoff, and uses a delivery id to prevent duplicates.
- **An autonomous liveness watcher** — it compares active run files with live sessions, debounces a possible orphan, and can resume it under strict ownership, lease, quota, and loop-brake rules.
- **A shared Attention topic and dashboard queue** — internal problems can be surfaced once without creating a wall of Telegram topics.

The missing pieces are ownership and ordering: the ordinary reply worker was optional, the liveness watcher let an actuation pause erase detection, and the attention queue wrote to disk after the network call instead of before it.

## What this adds

The ordinary reply monitor now starts by default. A missing retry time means “ready now,” exactly as the database already says. The monitor still respects an explicit emergency switch that disables redelivery, but the switch cannot disable queue health checks or hide a growing backlog.

Replies younger than 24 hours are recovered normally. Replies older than 24 hours are not sent weeks late and are not deleted. They are marked as a terminal stale failure, kept for audit, and summarized in one alert that says how many messages were affected and how old the backlog is. The alert never quotes message text or exposes delivery identifiers. The one entry Echo already marked “resent directly” is outside the claimable states and remains untouched.

The queue also gets a real health alarm. Instar first tries its existing bounded self-heal. If depth and age do not improve after three checks, or the oldest reply reaches 15 minutes, it raises one deduplicated Attention item while recovery continues. This makes a silent 33-message accumulation structurally visible.

## The liveness correction

Pausing the resume queue should stop automated respawns; it should not make the watcher blind. The liveness watcher will now continue to identify and debounce a dead-but-active run while that queue is paused.

In dry-run mode it records, “I would have resumed this run, but the resume queue is paused,” and exposes a real would-respawn counter. In live mode it keeps the observation and reports a blocked condition, but it does not spawn until the pause is lifted. Operator stops, ownership, leases, moves, and all existing safety gates remain authoritative.

The regression test reproduces the real timeline: the run began on July 23, its session was reaped at 14:36Z on July 24 with three hours left, no session existed for an hour, and one appeared again at 15:36Z. The watcher must see that gap even with the old `autonomous stop-all` pause present.

## The attention correction

An accepted alert is written locally before Telegram is contacted. The web endpoint can therefore return promptly even if Telegram never answers. The item is immediately visible through the Attention API and dashboard; Telegram delivery continues in a bounded, single-flight background attempt. A repeated request with the same id does not create duplicates and can retry an item that still has no delivered topic.

Existing internal callers that truly need to wait for a topic id keep their current awaited method. The HTTP route and the new delivery alarms use the fast persist-first method.

## The safeguards

**No surprise late messages.** The 24-hour boundary separates recovery from historical escalation. Old conversational text is never replayed as if it were current.

**No duplicate sends.** SQLite compare-and-swap claims, leases, the existing delivery-id dedupe, per-topic rate limits, and single-flight attention routing remain in force.

**No alert flood.** Stale rows become one summary, queue trouble becomes one episode item, and both route to the existing Attention hub.

**No hidden emergency override.** A paused resume queue still blocks real liveness action. The change restores observation, not authority to ignore the pause.

**No secret amplification.** Alerts contain counts and timestamps only. They never include queued message bodies, errors, tokens, or raw delivery ids.

## What ships when

This lands as one reliability change with three pushed stopping points: reply recovery and alarms first, the liveness regression second, and persist-first attention acceptance third. The full test suite and independent security, integration, and correctness reviews run before merge. After deployment, Echo’s real queue and liveness/attention surfaces are verified before the tracked commitments are called delivered.

## What you actually need to decide

The operator already decided this lane in the July 24 directive: activate safe ordinary recovery by default, hold rather than replay replies older than 24 hours, keep liveness detection awake during actuation pauses, and make Attention accept locally before waiting on Telegram.

