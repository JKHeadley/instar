# Attention items that close themselves — the plain-English version

## What's wrong today

The agent has a "needs your attention" list. Right now that list has over a thousand open entries across Justin's machines, and he ignores all of them, because almost none of them need him. Three things cause this:

1. **Nothing ever closes an entry.** About 70 different parts of the agent can add an entry. Only 8 of them ever mark their own entry done. The rest leave it open until a human taps "done" — forever, if nobody does.
2. **The same problem gets a new entry every time it is noticed.** Many parts of the agent put a timestamp or an episode number in the entry's name. So "this account needs signing in again" becomes 27 entries for 7 real accounts, and "a reply is held on this machine" becomes 243 entries.
3. **Nothing ever ages out.** The list has no expiry at all. A notice from June about a machine that was briefly offline is still "open" in October.

Promises the agent made that are waiting on Justin (a yes/no, a password) have the same flaw: the agent's own promises expire after 21 days, but ones waiting on him wait forever. 47 are open, most untouched for two weeks or more.

## What this change does

Three rules, built into the list itself so no one has to remember them:

- **One entry per problem.** When the same problem is noticed again, the existing entry is updated (a counter goes up) instead of a new one being added. If the problem comes back after being closed, the old entry reopens — so it is never silently muted either.
- **Entries close when the problem is gone.** The nine noisiest sources (sign-in repair, held replies, machine-ownership checks, duplicate sessions, and so on) now tell the list "this cleared" the moment they can see it. Nobody has to tap done on a sign-in problem that was fixed last week.
- **Old automated notices expire.** A notice from an automated check that nobody touched for 14 days is closed, and its closing note says plainly "expired, never confirmed cleared" rather than pretending it was handled. Questions the agent asked Justin directly get 30 days. Anything Justin has already marked as acknowledged or in progress is left alone. **Security items never expire.** Every expiry is written to a log, and a wrongly closed entry can be reopened with one tap, or reopens by itself the next time the problem is seen (if it is never seen again, it stays closed — that is the point).
- **The first pass on each machine is a rehearsal.** Duplicates are merged and provably-cleared problems are closed straight away, but the expiry step only lists what it would close the first time, so there is a reviewable list on every machine before anything ages out.

Promises waiting on Justin get the same bound: 14 days untouched, then they expire with the label "waited 14 days for the operator; ask again if still needed".

## What happens to the current pile

After this ships, each machine runs a dry run that lists what it would close, then closes it. The list of what was closed is written up in one report. The one security item in the pile ("Rotate exposed GitHub access token") is checked by hand first and only closed if the token really was rotated.

## What does NOT change

- The look of the hub messages, the new console (a separate change owns it), and the set of status values.
- Nothing is deleted. Closed entries stay in the store with their label.
- It ships on, because the problem is live now. One setting turns the whole thing off and gives today's behaviour back exactly; others adjust the 14- and 30-day windows or put it in a log-only mode.

## Why it is built this way

The tempting fix is to patch all 70 sources one by one. That is weeks of work and the 71st source would have the same bug. Putting the rules in the one place every source goes through means a source written next year is covered too. The nine direct hooks are the few that account for most of the pile, so they get the precise "close now" treatment; everything else is bounded by the expiry rule.
