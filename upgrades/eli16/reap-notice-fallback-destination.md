# ELI16 — A notice about interrupted work should not need a Telegram topic

## The one-sentence version

The layer whose whole job is to tell you "your work was interrupted" could only
speak into a Telegram topic, so on an agent that talks on Slack it recorded every
such notice as undeliverable and threw it away — quietly, every time.

## What this layer is for

When Instar shuts a session down on its own — resource pressure, quota, an age
limit — it tells the affected conversation. Notices that belong to no particular
conversation (a session that was not bound to one, or an index across several)
go to the agent's always-on system topic instead.

That system topic is a Telegram idea. The code asked for it, got nothing on an
agent with no Telegram at all, wrote down "no topic configured", and moved on.

## What that looked like

The indra agent on the laptop talks on Slack and has no Telegram. Its own records
show that outcome repeating: notice created, nowhere to send it, dropped. So the
one mechanism designed to stop silence was itself silent — and that is part of why
nobody knew its sessions were being interrupted.

## What changed

Three honest outcomes instead of one:

- If there is a system topic, it is used exactly as before.
- If there is not, the notice goes through the agent's general notification
  gateway, which already knows which platforms that agent actually has — a Slack
  channel included. The record says it was sent, and how.
- If there is genuinely nowhere to send it, that fact is now reported: one flag
  raised and a loud line in the log. A notice that cannot be delivered is still
  news; the absence of a destination is the thing to fix, and it can only be
  fixed if someone is told.

An agent with no fallback wired behaves exactly as it did before.

## Why the last case matters

An agent with no Telegram cannot raise a Telegram flag either — so the log line is
deliberately there as well. A dropped notice that leaves no trace anywhere is
precisely the failure this change exists to end, and it would be absurd to replace
it with a dropped report about a dropped notice.
