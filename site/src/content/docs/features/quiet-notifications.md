---
title: Quiet by Default notifications
description: Keep automated housekeeping in a readable feed, preserve conversations, and choose which categories may push.
---

Routine jobs, monitors and maintenance reports belong in **Notifications**.
When Quiet by Default enforcement is enabled, they are recorded there instead
of posting to Telegram. An urgent label alone does not grant a push. Real
conversation replies still arrive, including late replies. Command responses,
conversation-availability notices and delivery-loss notices retain narrowly
bound exceptions for the incoming message they serve.

Text and media you send from an authenticated mobile conversation still copy
to Telegram. These copies preserve the waiting reply; they do not count as an
agent answer. Automated media follows the same quiet policy as automated text.

## Historical delivery records

The background reply-delivery scan updates durable **Attention** records without
posting interruption notices to old conversations or the Attention hub. This
record-only behavior also applies to background recovery retries and reporting
on a machine that holds the delivery credential. It remains quiet when the
general notification gate is disabled or observing.

An original send made by a live local session keeps its existing failure-notice
path. Original replies keep their existing recovery and ambiguity safeguards.
When Telegram confirms an original reply, its delivery record closes locally;
the record does not claim that a separate explanation was sent.

## Read and choose

Open the dashboard **Notifications** page to see unread notices. Select **Mark
read** after reviewing a notice; the record remains in the feed. Related
repeated notices coalesce into one row with an occurrence count. A short,
quoted summary of relevant unread notices is available when a conversation
next starts a session.

Category switches let you choose which automated reports may push. Changing a
switch requires your dashboard PIN. A recent confirmation from the verified
operator in the conversation can also authorize a category change. A plain API
request claiming to be confirmed does not suffice. Preferences are audited and
queued durably for other machines. Unreachable machines are shown as unknown
or pending, rather than counted as synchronized.

Confirmed security, data-loss and agent-unavailable incidents have separate
bounded exceptions. A single failed login or limited account does not establish
a whole-agent outage. The switches control routine reports.

Opted-in reports have category and overall push limits. Overflow can produce
one count summary per window. The optional daily digest contains counts and
category names, without copied message bodies. A promoted release announcement
retains its existing user-audience and maturity rules; an explicit category
disable and the normal push limits still apply.

Overseers keep routine findings and repairs in handoffs. A Bugs-hub escalation
must state the unresolved impact and one action that only the operator can
take. The agent owns its bounded investigation and recovery before asking for
help.

## Status and rollout

Authenticated endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /notifications/selectivity` | This-machine mode, decision counters, conservative soak evidence and pending preference peers |
| `GET /notifications/quiet` | Quiet feed; use `scope=pool` to include reachable peers |
| `PATCH /notifications/quiet/:id` | Mark a row read, routed to its owning machine |
| `POST /notifications/categories/:category/push` | Confirmed category choice |

The feed supports `unread`, `category`, `topicId`, `limit` and paging cursors.
Pool responses explicitly name unavailable machines. Status and soak evidence
are per machine, and do not assert that the whole pool was observed.

Other agents retain the staged rollout: development agents observe by default;
fleet agents stay dark until explicitly enabled, and enforcement requires the
operator flip. Echo follows its separately authorized enforcement directive
once. Subsequent deliberate rollback remains effective. Set
`notifications.selectivity.dryRun` to `true` to observe without holding
messages, or disable `notifications.selectivity.enabled`. This does not erase
retained quiet records. No automatic fleet flip is inferred from local tests.

## Delivery and storage contracts

`NotificationSelectivityGate` applies the structural policy at final delivery,
including signed origin, browser and mesh recovery. Source-bound producer
stamps distinguish automation from trusted replies; a request body cannot mint
reply authority. The lifeline delegates automated classification to the server
writer. If that writer is unavailable, the existing durable outbox retains the
notice while inbound-bound recovery replies remain available.

`QuietNotificationStore` writes the first occurrence immediately and batches
repeat-count updates. Default retention is 30 days with at most 20,000 indexed
rows; retention can be configured within bounded limits. Acknowledgments are
append-only. A torn final line is fenced before subsequent writes. A recorded
receipt has a quiet id and no Telegram message id: it does not clear a waiting
reply, increment a delivered counter, or generate a mobile push. Reap/spend
recovery records `quiet-recorded` separately from actual delivery.

`NotificationPreferences` is the sole writer for confirmed local category
choices and authenticated same-agent replication. Desired changes and their
peer queue are saved before applying them. Delivery attempts stop after eight
failures; only an observed offline-to-online transition rearms them. Exhausted
or backed-off entries cannot starve newer eligible changes.

Old queued delivery-interruption notices are withheld from replay after an upgrade.
Actual replies retain their existing recovery path, and uncertain delivery evidence is preserved.
