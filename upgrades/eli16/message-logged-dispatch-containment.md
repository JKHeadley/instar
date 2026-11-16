# A failed memory write no longer eats the Slack message — Plain-English Overview

## The problem in one breath

When someone writes to the agent on Slack, the adapter first saves the message to its log
file, then hands it to whoever is listening — and the listener's job is to write a copy
into the searchable memory database. On three of those hand-off points there was nothing
catching a failure, so if the memory write failed (a full disk, a read-only database, a
locked file), the error travelled back out and destroyed the rest of the work: the message
never got its acknowledging reaction and never reached the handler that would reply to it.
The person got silence, and nothing anywhere said why.

## What already exists

Four other hand-off points in the same role already contain exactly this failure — both
Telegram ones, the shared message logger, and one of the three Slack ones. They catch the
listener's error, report it, and carry on. So the right answer was already in the codebase;
it just had not been applied everywhere.

## What this adds

The same containment at the places that lacked it, measured on today's `main`
(`d76d018c0`):

1. **Slack, inbound message** and **Slack, inbound file** — the two hand-offs where the
   failure was actually destroying people's messages. Both now go through one small shared
   method, which catches the listener's error, prints it, and files a degradation report
   under the same name Telegram already uses for this (`TopicMemory.dualWrite`).
2. **iMessage** — the same shape, and honestly: nothing subscribes to that hand-off today,
   so this one is not fixing a live failure. It is there so the next person who wires a
   listener inherits the guard instead of re-discovering its absence.
3. **The Slack reply route** — a different and smaller problem at the same seam. There the
   hand-off happens *after* the agent's reply has already gone out to Slack, and it sat
   inside the route's own error handler, which answers "500, server error". So a failed
   memory write made a reply that WAS delivered look like a failed send — the exact
   ambiguity the same handler guards against four lines earlier, where it answers 408 on a
   send timeout "so a redrive never re-posts a message the API may have taken". It now
   contains that failure locally and leaves the delivered reply reported as delivered.

## The new pieces

Nothing new is switched on, and no behaviour changes when the listener succeeds. There is
one new private method on the Slack adapter (the shared hand-off), and two new test files:
one that drives the real inbound paths with a listener that throws, and one that walks
every hand-off point in the whole source tree and fails if any of them is left unguarded —
so the next one cannot be added bare, and a later refactor cannot quietly un-guard one.

## The safeguards

A contained failure is never a silent one: it prints, and on the Slack paths it also files
a degradation report that says what was lost (the searchable copy) and what was not (the
message itself). The already-guarded hand-off keeps its containment and now reports it too.
The one deliberate "do not notify" case (the reply route tells the adapter not to notify,
because the route notifies once itself) is unchanged and has a test holding it in place.

## What ships when

All of it together, on by default, no flag. A revert fully undoes it.

## What you actually need to decide

Nothing here. This is the containment half only. The larger question this came from — who
owns a row write that *fails*, which the measurement says belongs in
`insertKeyedMessage`'s return value rather than in a `try/catch` lower down — is NOT in
this change and still needs its own design pass.
