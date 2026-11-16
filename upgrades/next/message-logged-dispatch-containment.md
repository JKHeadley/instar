# A failed memory write no longer destroys the Slack message it came with

## What Changed

`onMessageLogged` is the seam every logged message reaches, and in production its subscriber
writes the searchable TopicMemory copy (`writeSlackLogRow` → `TopicRowWriter.writeRow` →
`TopicMemory.insertKeyedMessage` → SQLite). Read on `d76d018c0`, nothing on that chain
catches, and three of the adapter dispatch sites had no guard of their own — so a SQLite write
failure (read-only store, disk full, lock) escaped into the inbound handler. On the two Slack
inbound paths (`SlackAdapter._handleMessage`, `_handleFileShared`) it escaped *before* the
acknowledging reaction and before the message was routed to its handler: the whole inbound
message was lost, with no reply and nothing on any surface saying why.

Those three sites (`SlackAdapter.ts:1992`, `:2198`, `IMessageAdapter.ts:833`) now contain the
subscriber's failure the way their four already-guarded siblings do — both Telegram sites, the
shared `MessageLogger`, and `SlackAdapter.logMessage`. The two Slack call sites share one new
private method that prints the failure and files a degradation report under the same
`TopicMemory.dualWrite` feature name Telegram already uses for it, so one failure is one name
on the dashboard. A fourth site differed in kind: the Slack agent-reply route
(`routes.ts:23524`) dispatched *after* the reply had already been sent, inside the route's own
error handler, so a failed memory write answered `500` for a reply that WAS delivered — and
skipped the promise tracking below it. It now contains that failure locally.

The iMessage guard is hardening rather than a live fix, and is labelled as such: nothing
subscribes to that adapter's seam today.

## What to Tell Your User

Nothing changes in normal use. If the searchable message store ever fails mid-write, the
message itself now still gets its reaction, its handler and its reply — only the searchable
copy is missing, and that loss is reported instead of silent. A Slack reply that was delivered
is no longer reported back as a server error.

## Summary of New Capabilities

- Subscriber failures at every `onMessageLogged` dispatch site are contained and reported,
  never destructive to the message.
- A new ratchet test walks the whole source tree and fails if any dispatch site is left
  uncaught, or is caught only by a handler that answers the caller with a 5xx.

## Evidence

9 new tests (4 behavioural on the real inbound Slack paths, each with its positive control in
the same test; 5 in the population ratchet, including three positive controls proving the
detector can say BARE and can say WRONG-ALTITUDE). Founding-case controls run in both
directions: with the source reverted, the ratchet fails and names exactly the three bare
sites; with only the route reverted, it names the 5xx-altitude one. Mutation sweep 7/7 killed,
source restored byte-identically after each. `tsc --noEmit` exit 0; all 54 lint steps pass.
Unit-lane neighbours green (`topic-row-writer` 27/27, `MessageLogger` 18/18,
`no-silent-fallbacks` 5/5, `slack-message-dedup` 3/3, `slack-file-shared` 6/6).
Measured on instar upstream `d76d018c0`; from PROP-1289, whose remaining question — who owns a
row write that *fails* — is deliberately NOT in this change.
