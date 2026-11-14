# Slack history could not be replayed, and a rebuild erased it — plain-English overview

## The one-sentence version

Instar's conversational memory cannot read a single line of its own Slack
message log, so Slack history can never be restored — and the one command whose
job is to restore history deletes all of it first. This change teaches the
importer to read Slack entries using the key rule the live writer already uses,
makes a restore read every log rather than one, and stops a restore that has
nothing to restore from.

## What already exists

Every message an agent sees is written twice: once to an append-only log file on
disk, and once to a small database the agent actually reads from. The log is the
source of truth; the database is a fast copy that can be rebuilt from it.
Telegram messages go to one log, Slack messages to another.

A recent change fixed how Slack messages are written as they arrive. Each one
now gets its own number, derived from Slack's own timestamp, so a channel's
messages stop overwriting each other. That change deliberately stopped at the
live writer. It did not touch the importer, which is the part that reads a log
back.

## The problem in one breath

The importer decides whether to keep a line by looking for a field called
`topicId`. Telegram writes that field; Slack does not, because a Slack
conversation is a channel, so Slack writes `channelId`. Every Slack line
therefore fails that test and is counted as "missing fields" and thrown away.
Not some lines. Every line, since Slack support shipped.

Two things follow from that one gap, and both were measured rather than guessed:

**Slack history cannot be recovered.** The log is intact, with real Slack
timestamps. Two agents on this machine are holding 671 Slack messages in their
logs that their databases have never contained. They have been sitting there,
readable, and nothing could load them.

**The rebuild command destroys Slack history.** It empties the database, then
imports from the Telegram log alone. Slack rows are deleted and never put back.
On an agent that has no Telegram log at all, it empties the database, restores
nothing, and reports success.

## What this adds

**The importer now reads Slack entries, using the shipped key rule rather than
its own copy of it.** It calls the same function the live writer calls. That
matters for an unglamorous case: a file posted with no message, which Slack gives
no timestamp. The rule puts those in a separate number range; a hand-written
"timestamp times a million" would agree with the rule on ordinary messages and
disagree on exactly that one, and a recovered message under the wrong number is
a message in the wrong place. Each channel also becomes the same conversation
number the live writer uses, so recovered messages land beside the messages
already there instead of starting a second, parallel copy of each channel. That
was checked against a real store: the five conversation numbers already in it
are exactly the ones this code computes, and importing created no sixth.

**A clash is counted, never dropped quietly.** Slack rows go in one at a time
through the store's checked insert, so a message already there is recognised as a
replay and a number genuinely held by a different message is reported. The bulk
path the Telegram log uses cannot tell those two apart, and silence is what hid
the original bug for months.

**A rebuild now reads every log, not just the one it was handed.** Deleting rows
you have no source for is not a rebuild. It reads the Slack log too, so Slack
rows are deleted and then put back.

**A rebuild refuses to delete when nothing could restore what is there.** If no
log exists, or the logs that exist hold nothing it can read, it changes nothing
and says why. The silent wipe is gone.

**Recovery happens by itself.** The non-destructive import that adds only what is
missing now runs at startup, so an agent recovers its lost Slack history the next
time it starts, with nobody having to run a command. Running it again adds
nothing. An on-demand button for the same thing is left to the people who
maintain this project: adding one is a decision about what the project offers,
and that is theirs rather than part of fixing this.

## The safeguards

**A message the key rule cannot key is refused and counted, not stored under
zero.** Zero is the value that caused the original loss — every Slack message
shared it, and the database kept only one row per shared number. If the rule
returns an error, the entry is skipped and the count is reported, so a recovery
can never quietly recreate the collision it exists to undo.

**The decision about what a line is gets made in one place.** The check that
decides whether it is safe to delete, and the import that does the writing, ask
the same function. Two copies of that judgement would let the check promise a
restore the import does not perform.

**Loss that is genuinely unavoidable is now a number, not a silence.** A message
older than its log's retention window is in no log, so a rebuild still loses it.
That was always true for Telegram and is equally true for Slack. The difference
is that the command now reports how many rows it deleted and how many it put
back, so a shortfall is visible to whoever ran it.

## What is deliberately not changed

The rebuild command is still destructive when it has a source — that is what it
is for, and callers invoke it on purpose. Telegram's import path is untouched,
including the fact that it sets no channel id. Lines carrying no message text at
all are still skipped, exactly as before; there are 29 of them across the two
logs on this machine, and admitting them would change behaviour for Telegram too,
which is a separate decision from this one.

One thing a reader should know rather than discover. On an agent that ran before
the live writer was fixed, the single surviving message per channel is still
stored under the old number zero. The import brings the same message back under
its real number without removing the old row, so that message can appear twice.
Measured on a real store: two such rows out of 263 recovered. Clearing the old
zero-numbered rows is a deletion against live data and is left to the
maintainers, not folded in here.
