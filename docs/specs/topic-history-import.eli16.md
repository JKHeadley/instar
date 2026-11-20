# Topic history import, in plain words

## What happened

When the Mac Studio was rebuilt, the agent lost part of its memory of past
conversations. The agent keeps every Telegram and app message in a running
log, and it builds a searchable index from that log. The rebuild left the
Studio's log missing about 14,000 older messages across 167 conversations.
Copies of those messages still existed on the other machines. A recovery pass
gathered them into one clean file, with no duplicates and none that the
Studio already had.

## Why we can't just paste them back in

There was no proper way to put them back. The one existing tool, "rebuild",
wipes the search index and rebuilds it from the live log, and the live log is
exactly what is missing the messages. Pasting the old messages onto the end
of the live log causes three problems:

- The agent would treat an August message as the newest thing said in that
  conversation, because the index orders messages by when they were added.
- Several background helpers read the end of the live log to see what just
  happened. They would treat old messages as new ones and might act on them
  again, for example by spotting the same promise twice.
- If a real message arrived while the file was being edited, it could be lost.

## What this change adds

A new, supported "import history" action on the agent's own server. You give
it the recovered file, and it does five things:

1. It checks every message against the same rules the agent uses for its own
   messages. Anything malformed is refused and counted, never guessed at,
   such as a test message with a made-up id. Messages typed in the Instar app
   are also left out on purpose: the app keeps its own copy of them, and that
   copy was checked and is still complete on the Studio.
2. It skips any message the agent already has, so running it twice does
   nothing the second time.
3. It slots each recovered message into its conversation at the right point in
   time. Messages the agent already had keep their exact order. The newest
   real messages stay the newest.
4. It updates the search index, so searching a conversation finds the
   recovered words.
5. It keeps the recovered messages in a separate file next to the live log,
   never in the live log itself. The background helpers never see them, and a
   future rebuild puts them back in the right order. It also writes an audit
   line saying when the import ran, from which file, and how many messages it
   added to each conversation.

## Safeguards

- Only the agent's own key can run it. A phone paired by a team member cannot.
- A recovered message can never count as a fresh instruction from the owner.
  Each one is labelled "recovered", and its source is marked as not certain.
  The parts of the agent that look for the owner's approval, or for the
  owner's own protected words, skip messages labelled that way.
- A dry-run mode shows what would be imported without changing anything.
- It is machine-local: it only changes the machine you run it on.

## Undoing it

Deleting the separate import file and running the existing rebuild removes
the imported messages completely. The live log is never touched.

## What a reader needs to decide

Nothing new needs deciding. This is a restore tool for history that was lost
in an outage. It adds no new rule about what the agent may do.
