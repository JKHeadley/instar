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

## How we made the multi-machine math airtight (round-6 hardening)

Because the agent can run on several machines at once, two machines can hand out a
number for the same conversation at the same time. The spec's answer is a fixed set
of tie-break rules that every machine applies identically, so they always end up
agreeing without talking to each other. Six review rounds hammered on those rules,
and the latest round closed the last known holes:

- **A forwarding note can never argue with an owner.** When two conversations fight
  over a number, the loser gets a little "see the new number" forwarding note. We
  found a rare timing where a forwarding note could point at a number that a THIRD
  conversation legitimately owns — two answers for one number. Now ownership always
  wins: a forwarding note is only created for a number nobody owns, and if an owner
  shows up later, the stale note is deleted in the same breath. Promises made under
  the old number still arrive in the right thread, because every promise also
  carries its own "which thread was this made in" note.
- **Flood-proofing at two zoom levels.** A vandal shipping fake records could
  previously spread them across neighboring number ranges to crowd a victim's
  parking spots without tripping the per-range limit. There is now also an overall
  density limit per stretch of numbers, so no amount of spreading can crowd a real
  conversation out.
- **The promise's thread-note is sanity-checked before use.** If that note is ever
  corrupted (a bug, a bad migration), delivery STOPS with one visible alert and the
  usual retry/escalation — never a silent redirect into the wrong thread. (Round 7
  tightened this: an earlier draft "fell back to the normal lookup" on corruption,
  but the normal lookup can itself point at the wrong thread in exactly the
  situation the note exists for — so a detected-corrupt note now refuses to deliver
  at all.)
- **No double-posting even if the server dies mid-bookkeeping.** Finishing a send
  updates two separate files; we pinned the order so that a crash between the two
  can only leave a harmless expiring leftover, never a repeated message.
- **One unambiguous tie-breaker.** When the same conversation has several records
  floating around, the rules now say exactly which record's timestamp represents it
  — so no machine can order things differently just because records arrived in a
  different order.

None of this changes what users see; it changes what can silently go wrong (now:
nothing we know of).

## Round-7 hardening (crash windows and one identity rule)

Round 6 was the first review with zero critical findings; what remained were four
narrow seams, each now closed:

- **A note-to-self before every send.** If the server died in the split second
  between a message actually posting and the bookkeeping that records it, a repeat
  post was possible. The sender now writes a durable "I'm about to send this" note
  first; on restart, an unresolved note is treated as "it may have posted" — worst
  case is one skipped heartbeat (the next one comes on schedule), never a
  double-post.
- **One name authority.** Each shared record carried both a structured identity and
  a display name, and a crafted record could make the two disagree — with two rules
  reading different fields. The structured identity is now the only authority; the
  display name is recomputed from it, and a record whose name disagrees is refused
  everywhere, identically.
- **Restart bookkeeping can't resurrect a deleted forwarding note.** The
  round-6 "ownership beats forwarding note" rule deletes stale notes — but a
  restart replaying old bookkeeping could have brought one back. The restart path
  now re-applies the same ownership-wins rule after replaying, and the reading
  position for records from other machines is saved together with the state it
  produced, so nothing is lost or resurrected across a crash.
- **Corrupt promise-notes refuse instead of guessing** (the bullet updated above).

Plus small honesty notes: the anti-flood limits are per-machine (a vandal actively
flooding can make machines briefly disagree about the vandal's own records — loud,
bounded, self-healing, and real conversations are unaffected); and a crash at the
exact wrong moment can leave one harmless permanently-parked delivery pin (a
cleanup sweep is the named follow-up).

## Open questions

None. Earlier drafts had two, and both turned out to be items already tracked on
the roadmap (Slack delivery robustness, and how a later phase keys its
exactly-once inbox) — there is no decision left that needs the operator's call
before building.

## Rollback

The follow-through behavior rides a config flag (dark by default, dry-run first) —
flipping it off restores today's behavior entirely. The address book file itself is
inert data to old code: old versions never read it, so rolling back the code cannot
be hurt by its existence.
