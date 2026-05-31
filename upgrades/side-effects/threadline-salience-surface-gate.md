# Side-effects — Threadline salience surface gate

## 1. What files/state does this touch at runtime?
`TopicLinkageHandler.ts`, the `shouldSurface` decision in `tryRouteReplyToTopic` only. No new files,
no config, no schema, no persisted state. The salience verdict (already computed) is now consulted
for the dormant-session surface decision.

## 2. Does it change any functional behavior?
One case changes: a reply to a DORMANT topic session classified `agent-internal` (low-salience) no
longer fires a Telegram post — it stays quiet and is recorded in the ConversationStore (the browsable
Threadline hub) on the inbound path. It is NOT pushed to the topic and NOT auto-replayed on resume;
recovery is via the hub (the desired "low-salience → silent hub" behavior, not a loss). Unchanged:
live-inject never surfaces; failure-visible always surfaces; resume-pending + user-visible surfaces.

## 3. What happens on failure / weird config?
The salience classifier already never throws (SalienceGate.evaluate falls back deterministically:
first-reply → user-visible, else → agent-internal). So a classifier outage means a genuine first
contact still surfaces (user-visible fallback), and subsequent chatter is quiet — the intended
behavior. A genuine delivery failure → failure-visible → always surfaces (untouched safety valve).

## 4. Migration parity — do existing agents get it?
Yes, via the normal release — code-only, compiled into `dist`. No agent-installed file / config /
template change, so no `PostUpdateMigrator` pass is needed.

## 5. Could it spam / flood / burn resources?
The opposite — it REDUCES surfaces (suppresses low-salience dormant posts). No new timers, I/O, or
network calls; the salience classification already ran. The existing per-thread + per-topic rate
limits remain as additional anti-flood backstops.

## 6. Rollback / off-switch?
Revert the one `shouldSurface` block (restore the OR-clause) and the 3 tests. No data, no migration,
no flag.

## 7. Concurrency / ordering?
None new. The change is a pure boolean refinement of an existing synchronous decision; it consults a
value that was already computed earlier in the same function.

## Blast radius
Small + surgical: one boolean expression in `TopicLinkageHandler.tryRouteReplyToTopic`. Only the
relay-reply Telegram-surface decision for the dormant (resume-pending) + low-salience case is
affected. Live-inject, failure-visible, salient, and all rate-limiting behavior are unchanged; the
full threadline regression suite stays green.
