<!-- bump: patch -->

## What Changed

Slack conversations are kept in your agent's memory again. Until now, your agent
stored only the **first** message from each Slack channel and silently discarded
every message after it. Telegram gives every message a number, and the code that
saved Slack messages assumed Slack did too — but Slack identifies a message by a
timestamp string, so every Slack message was saved under the same id, `0`. The
memory store allows one message per id per conversation and quietly ignores
repeats (which is what makes restarts safe), so from the second Slack message
onward, each one was treated as a duplicate of the first and dropped.

Measured on two real agents before the fix: 7 Slack messages kept across 8
channels, and most of what survived was restart notices rather than anything
anyone said. So Slack topic search, Slack summaries and the Slack history handed
to a new session were all running on almost nothing.

Slack messages now get an id derived from their own timestamp, in microseconds.
That gives each message a distinct id, keeps them in send order (the summariser
asks for "messages newer than the last one I summarised", so order matters as
much as uniqueness), and stays exact so two messages can never land on the same
id.

## What to Tell Your User

If your agent uses Slack, it will start remembering your Slack conversations
from now on, and its Slack summaries and searches will start working properly.

Slack history from before this update was not saved and most of it is gone.
Some is recoverable: your agent's Slack message log still holds the inbound
Slack messages from roughly the last 90 days, and they can be replayed into
memory. Anything older than that log's retention window has no copy left. This
update does not do that replay — ask your agent if you want it done.

One caution worth knowing now that Slack history is actually being kept: the
topic-memory rebuild action clears stored messages and reloads them from the
Telegram message log only. It cannot reload Slack messages, so running a rebuild
will discard your Slack history with no way to bring it back. Avoid it on an
agent whose Slack history you care about until that gap is closed.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Slack channel history is retained in topic memory | automatic for every Slack channel |
| Slack topic summaries and search over real history | automatic; previously had ~1 message per channel to work with |

## Evidence

18 new assertions run against the real `TopicMemory` store, not a mock: two
messages in one channel both persist, two inside the same second both persist, a
25-message channel keeps all 25, re-inserting a message is still a no-op, and
the send-order read returns the right message. One is a positive control that
runs the replaced derivation over the same two messages and asserts only one
survives — without it the suite could pass against the bug it exists to catch.

A 7-mutation sweep over the new module (always return zero, drop the sub-second
digits, substitute a hash, loosen the exactness bound, drop each fallback) was
killed 7/7 by a failing test. Related suites re-run green together: topic-memory,
topic-memory-importer, topic-memory-privacy, topic-memory-forwarded-provenance,
topic-summarizer — 160 tests. The conversation-identity mint-idiom ratchet passes
with the new file in `src/` (39 tests with conversation-identity). All 51 lint
steps and `tsc --noEmit` pass.
