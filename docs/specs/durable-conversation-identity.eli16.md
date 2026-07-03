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

## Round-8 hardening (the duplicate-guard's own fine print)

Round 7's blockers all sat in one place: the guard that stops a reminder from
posting twice when a delivery receipt gets lost. Three seams, each now closed:

- **A lost receipt can no longer mute a promise's reminders.** By the old letter of
  the rules, one lost delivery receipt made the guard swallow not just the repeat of
  THAT reminder but every future reminder for that promise — silently — for up to a
  week. Now a swallowed repeat counts as "handled": the reminder counter moves
  forward, and the next reminder goes out on schedule. Worst case really is one
  skipped beat, never a muted week (the round-7 section's claim above is now
  mechanically guaranteed, not just intended).
- **Notices identified only by their text get a short repeat-window, not a week.**
  Reminders carry a "promise number," but plain notices (attention alerts, "your
  session was restarted") are identified by their text alone. One successful send
  used to suppress the same text to that conversation for 7 days — so a legitimate
  identical notice a day later was silently swallowed. Text-identified notices now
  use a 15-minute repeat window (the same window Telegram already uses), so honest
  repeats always deliver.
- **The restart bookkeeping now files "I was about to send this" notes under
  conversation + text, not text alone.** Two different conversations receiving the
  same text could otherwise cancel each other's notes across a restart — one
  direction risks a double-post, the other a wrongly-skipped send. The note-keying
  now matches the guard's own keying exactly.

Plus honesty fixes elsewhere: an over-strong sentence about two machines never
picking different workspaces at first boot is retracted (the real containment —
divergence is loud, and nothing is shared until a workspace is pinned in config —
was already in place); the "old ungated sessions age out in one generation" claim
now names its real bound and adds a visible alert for stragglers instead of
assuming; and a corrupted line in the middle of the recovery journal now stops
recovery loudly (preserving everything for inspection) instead of silently
skipping a committed record.

## Round-9 hardening (the last crash-path corner, and dead weight removed)

Round 8 found one real blocker plus polish; all closed:

- **A crashed one-off notice now retries instead of being silently dropped.** The
  round-7 "I'm about to send this" note resolves at restart by WHO sent it. For a
  reminder, "it may have posted" safely skips one beat — the next reminder comes on
  schedule. But a one-off notice ("your session was restarted") has no next beat:
  treating its unknown outcome as "may have posted" made the suppression permanent,
  and the notice could be lost with paperwork that looks like a delivery. The note
  now records which kind of sender wrote it, and at restart a one-off notice's
  unresolved note resolves toward RETRY. The honest trade: if the crashed send had
  actually posted, you may see the same notice twice (visible, bounded) — never a
  notice silently lost.
- **A journal line from a newer version no longer looks like corruption.** After a
  rollback, the recovery journal can hold a record type the older code doesn't
  know. That's version skew, not damage: recovery now skips applying it, keeps the
  line untouched for the future re-upgrade, and says so once — instead of tripping
  the loud corruption alarm on every rotated file.
- **A write-only "checkpoint" record was deleted.** Rotation used to write an
  anchor record that nothing ever read — dead weight that could only cause the
  false-corruption problem above. Recovery reads its position from the snapshot
  itself; the anchor is gone.
- **Small print pinned:** the reminder-key format is now spelled out at both places
  that mention it (one canonical encoding, so two implementations can't drift); a
  future sender wanting its own "promise number" must also define when its entries
  retire, or it belongs on the short-window lane; re-enabling the feature after a
  rollback needs no special path (the normal startup pass absorbs whatever is on
  disk); and the 14-day grace clock for old ungated sessions now names the file
  that anchors it.

## Round-10 hardening (making the preservation promise actually keep)

Round 9's one real blocker was in round 9's own repair: we promised that a journal
line from a newer version survives a rollback and gets applied after re-upgrading —
but the recovery bookmark could quietly step past it, so the line survived as bytes
and never as behavior. Fixed: while any such line remains unapplied, the bookmark is
held just below it. Re-applying the records above the held bookmark is harmless
(recovery is re-runnable by design), and the honest cost — the journal grows a bit
for as long as the rollback lasts — is named and alerted, not hidden.

Also closed: a bookkeeping line missing its new "who sent this" field now retries
instead of guessing (worst case one visible duplicate, never a silent loss); the
14-day grace clock's anchor file now rides the backup (a disaster restore no longer
resets the clock); restart-time repair notes are written only after recovery
finishes reading (never into the file being read); one recovery test that still
asserted the old pre-round-9 behavior was restated; and three history entries got
"this changed in round 9" markers so old resolutions can't be mistaken for current
rules.

## Round-11 hardening (the rollback corner, finished properly)

Round 10's blocker was in round 10's own repair, one level deeper: holding the recovery
bookmark below a newer-version journal line wasn't enough, because the state file we
keep writing alongside it still baked in the effects of everything AFTER that line — so
when the newer version came back, it would apply its line against a world that already
contained the line's own future. The round-11 fix is simpler, not cleverer: while any
newer-version line sits unapplied, we stop writing the state file entirely. The last
good pre-rollback state file stays put; every restart rebuilds from it plus the full
journal in order; and when the newer version returns, it replays everything in true
order with its line in its rightful place. Costs (a staler cache, a longer journal, a
slower boot — only for as long as the rollback lasts) are named and alerted.

Also pinned: the restart-time repair notes are flushed to disk before the system starts
serving (so implementations can't differ on that boundary); a bookkeeping line whose
"who sent this" field is garbled (not just absent) gets the same retry treatment; and
the tests now also check the alert's CONTENT and the case of two different
newer-version lines resolving at different times.

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

## Build status

Increment 1 (the address book itself, its crash-proof journal, and the eager
"write the conversation down on first contact" step) is built and shipping;
the delivery funnel exists but stays switched off by default (dry-run first on
development agents), exactly as the rollout section prescribes. Later
increments wire the consumers (promises/reminders first) onto it.
