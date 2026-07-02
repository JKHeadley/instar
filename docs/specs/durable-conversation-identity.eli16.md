# Durable Conversation Identity — plain-English overview

## What this is

Today, the agent has a solid "memory address" for every Telegram conversation — a
topic number — and almost everything durable it does (promises it must keep,
reminders, attention items, "your session was restarted" notices) is filed under
that number. Slack conversations don't have one. Under the hood, a Slack channel or
thread is identified by a throwaway text label, and when some feature needs a number
anyway, three different pieces of code each improvise one by scrambling the label
into a number — each in a slightly different way, kept only in short-term memory,
and forgotten on every restart.

The consequence is simple and serious: **a promise made in Slack dies on the next
server restart.** There is nothing durable to attach it to. That one missing piece
is why the agent feels like a real employee on Telegram and like a goldfish on
Slack.

## What we're building

A small, permanent **address book for conversations**. The first time the agent
talks in any Slack channel or thread, the address book writes down that
conversation and assigns it a stable number (a negative one, so it can never be
confused with a real Telegram topic number, which is always positive). From then
on, that number IS that conversation — across restarts, across machines, forever.

Every existing feature that files things under a topic number can now file them
under a Slack conversation's number too, without being rewritten — the number looks
and behaves exactly like the numbers they already store. And one new "delivery
funnel" knows how to route a message for any number: positive goes out through
Telegram as always; negative is looked up in the address book and goes out to the
right Slack channel — and the right **thread** — through the existing Slack send
path.

## Clever part, honestly explained

The number we assign isn't random: it's the same number today's improvised
scrambling would have produced. That means everything already written down under
the old improvised numbers (conversation history, presence records) attaches
cleanly to the new registered identity — nothing is orphaned, and an old server and
a new server running side by side during an upgrade compute identical numbers with
no coordination. The registry's job is to catch the rare case where two different
conversations would scramble to the same number (today that would silently corrupt
state; now it's detected, given a fresh number, and logged) and to remember
everything durably so restarts stop erasing identity.

## What changes for the user

Nothing visible on day one — the foundation records identity without changing
behavior. Once the follow-through layer is switched on (carefully, dark-first,
logged before live), the visible change is the headline: **"I'll report back in 10
minutes" said in a Slack thread survives a server restart and the follow-up lands
back in that exact thread.** Later phases build on the same foundation: attention
items, restart notices, and cold-start "I couldn't start your session" fallbacks
all become possible on Slack.

## Main tradeoffs

- We deliberately did NOT rename or re-type the 168 files that assume a numeric
  topic id — that big-bang refactor was judged higher-risk than value for zero
  user-visible gain. The number's meaning widened instead.
- We deliberately kept the weak legacy scrambling function as the *starting
  suggestion* for new numbers (for compatibility), with the registry as the actual
  authority that catches its collisions. It is a transitional dependency, not a
  forever-blessing.
- Delivery robustness on Slack (retries, dedup, formatting) is NOT in this change —
  it's the next roadmap item and slots in underneath the funnel without touching
  its callers.

## Rollback

The follow-through behavior rides a config flag (dark by default, dry-run first) —
flipping it off restores today's behavior entirely. The address book file itself is
inert data to old code: old versions never read it, so rolling back the code cannot
be hurt by its existence.
