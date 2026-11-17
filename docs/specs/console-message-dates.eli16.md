# Console message dates: show the full date for older messages (ELI16)

## What this changes

On the web dashboard's Conversations page, every message bubble shows a small time stamp. Until now, a message sent today showed its time ("09:14 AM"), but a message from any other day showed only the month and day, like "Nov 16". There was no year and no time, so an old message from last year looked the same as one from last week, and you could not tell what time anything earlier than today was sent.

Justin asked for messages that are not from today to show the day, month and year. The iPhone and Android apps were already changed to do exactly that. This change makes the web dashboard match them: a message from today still shows only its time, and a message from any other day now shows something like "Nov 16, 2026, 9:01 PM". The same applies to the "Pinned by ..." line in the list of pinned messages.

## What stays the same

The list of conversations on the left keeps its short stamp ("Nov 16" or a time), because that list needs to stay narrow and only has to show roughly how recent each conversation is. The language and format follow the browser's own settings, as before. Nothing on the server changes, and nothing is stored.

## Safeguards

This is display only: nothing is blocked, filtered or sent differently. If the change looked wrong, undoing the one commit puts the old stamps back, with no data to repair. Tests check today, a message sent one minute before midnight seen just after midnight, a message from a previous year, and the real page rendering those stamps.

## What you need to decide

Nothing. This carries out Justin's request directly.
