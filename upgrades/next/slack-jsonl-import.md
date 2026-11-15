<!-- bump: patch -->

## What Changed

Your agent can now recover its Slack history, and the rebuild action can no
longer erase it. These were two faces of one gap.

Every message is written twice: to an append-only log on disk, and to a small
database the agent reads from. The importer that refills the database from a log
decides whether to keep a line by looking for a field named `topicId`. Telegram
writes that field; Slack does not, because a Slack conversation is a channel, so
Slack writes `channelId`. Every Slack line therefore failed that test and was
counted as "missing fields" and thrown away — not some lines, every line, since
Slack support shipped.

The previous update fixed how Slack messages are written as they arrive. It
deliberately stopped at the live writer and left the importer alone, which is
where these two consequences lived, both measured on real agents:

**Slack history could not be recovered.** The log was intact the whole time, with
real Slack timestamps. Two agents on one machine were holding 671 Slack messages
in their logs that their databases had never contained.

**The rebuild action destroyed Slack history.** It empties the database and then
imports from the Telegram log alone, so Slack rows were deleted and none put
back. On an agent with no Telegram log it emptied the database, restored nothing,
and reported success.

Three fixes, shipped together because any one alone is incomplete. The importer
now reads Slack entries, and it derives each one's identity by calling the same
key rule the live writer uses rather than keeping its own copy — which matters
for a file posted with no message, a case the rule handles specially and a
hand-written copy would get wrong. Each channel maps to the same conversation the
live writer uses, checked against a real store where the five conversations
already present are exactly the ones this code computes. The rebuild action now
reads every message log beside the one it was handed, so what it deletes it can
restore. And it refuses to delete at all when nothing it can read could restore
what is there, which removes the silent wipe.

A clash is now counted rather than dropped quietly, too: Slack rows go in through
the store's checked insert, so a message already there is reported as a replay
and a number genuinely held by a different message is reported as a refusal.

## What to Tell Your User

If your agent uses Slack, the Slack history it has been logging but never storing
will be loaded into its memory the next time it starts. Nothing is deleted to
make that happen, and starting again later changes nothing further. On the two
agents measured here that is 671 messages coming back, with their real send
times, filed in the conversations they belong to.

The caution from the previous update is lifted: the rebuild action is now safe for
an agent whose Slack history you care about. It reloads Slack messages along with
Telegram ones, and if it finds nothing it could reload, it leaves your memory
alone and tells you what it looked for instead of emptying it and reporting
success. It also now tells you how many messages it removed and how many it put
back, so a shortfall is something you can see.

Three honest limits. A message older than its log's retention window, roughly
ninety days, is in no log at all, so a rebuild still cannot bring that one back.
A logged message with no text at all, such as a file posted with no comment, is
still skipped, exactly as before. And on an agent that was running before the
live writer was fixed, the one message per channel that survived back then is
still stored under the old placeholder number; recovery brings the same message
back under its real number without removing the old copy, so that single message
per channel can appear twice. On the agent measured here that was two messages.
Clearing those old rows means deleting from your live memory, so it is left for a
maintainer to decide rather than done automatically.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Slack history is replayed into topic memory | automatic at startup |
| Rebuild restores Slack messages instead of discarding them | automatic for the existing rebuild action |
| Rebuild refuses to empty your memory when it has nothing to restore from | automatic; it reports the reason |
| Rebuild reports what it deleted and what it put back | in the rebuild action's response |
| A key clash on import is counted and reported, not dropped | in the rebuild action's response |

## Evidence

19 new assertions run against the real memory store, not a mock, using a fixture
with the exact field set a real Slack log carries: a two-channel log where every
message survives, two messages inside the same second, a 25-message channel that
keeps all 25, send-order keys, a file share with no timestamp, a second import
that adds nothing, a rebuild that restores every Slack row and is unchanged by
running twice, both refusal causes, and summaries surviving a rebuild. Two of
them are controls: one reproduces the old admission test and asserts it reads
none of the Slack fixture while still reading both Telegram rows, and one asserts
the thread-aware key really is a different number before pinning the channel-only
one. Two more were asked for by the project's maintainer and are the sharpest in
the suite: a store whose rows were written by the live path takes zero rows from
an import of the same log, and a file share with no timestamp gets the identical
identity on import as on the live write.

A 9-mutation sweep was killed 9 for 9, each by a distinct test, including the two
mistakes this fix exists to avoid: using the raw channel id as the conversation
number, and re-deriving the key locally instead of calling the shipped rule.

Measured on copies of two real stores, never the live ones: 263 recovered rows
land under the five conversation numbers already in the first store, with no
sixth conversation created, and a second import added nothing. The second store
took 408 rows across nine channels, and three entries were reported as repeats
that the old import path could not have told apart from new messages. 260 tests
pass across the 11 related suites, 24 more in the route integration suite, and
the type check passes with no output.
