# Dated learned preferences — the plain-English overview

## What this is

When you correct the agent the same way on different days, it saves a short preference, such as "lead with the short answer". Those preferences are loaded at the start of every conversation. The dashboard has a page called "What I have learned about you" that lists them.

Until now, that page could only read the same block of text the agent loads at the start of a conversation. That block has no dates, so the page could not say when something was learned, and it could not tell you which of your machines learned it.

## What changes

The agent server gets one new read-only address that hands the page a proper list: for each preference, the words, when it was last seen, how many times it came up, how sure the agent is, and which machine learned it. The page now shows "last seen Oct 25" on each card, puts a small "New this week" mark on anything learned in the last seven days, and counts the new ones at the top. When you have more than one machine, it also names the machine, using the name you gave it. If the machine cannot be named, it says nothing rather than showing a code.

## What already existed, and what stays the same

The new list reads from exactly the same places, in the same order and behind the same on/off switch, as the block that is loaded at the start of a conversation, so the page and the agent always agree. Nothing is written. The private matching rules some preferences carry are never sent, and any text that looks like a password or key is hidden before it leaves the server, using the same cleaner the agent already uses for that.

## Safeguards

Only the owner can read it, with the same key as the rest of the dashboard. A session inside a private conversation cannot read it. If you open the page against an older server that does not have the new list yet, the page quietly uses the old way, so nothing breaks while machines update.

## What you need to decide

Nothing. This is a small, read-only addition that a revert fully undoes.

## Update order fix

When an existing agent updates, a step adds the new preferences line to its instructions file. That step used to run before the step that adds the Preferences section the line belongs in. So the first update added the section, and only the second update added the line. The step now runs right after the section is added, so one update does everything and a second update changes nothing.
