# A calm "Needs you" line, and no more "Name not available yet"

## What this is

On 20 November Justin looked at the Instar app on his iPhone and wrote that the "Needs you" block is "messy, confusing, hard to digest, takes up too much space", and that the "Name not available yet" bug is unacceptable. This change fixes both on the server and the dashboard. The iPhone app's own rebuild session is changing the app to the same design, built from the same shared model.

## "Needs you": one calm line, opened on demand

Before, the block was a tall card: two full items, a "12 more" line, two sentences about places that could not be checked, and a "14+" badge, all above the conversation list. Now it is a single line: a colored dot (red if anything is urgent, orange otherwise), "Needs you · 14+", and the first item's title trimmed to fit, with an arrow. Tap or click it and the full list opens, with paging. The "could not check" sentences now appear only at the bottom of the open list. "Hide" closes it again. The dashboard remembers open or closed while you move between pages. While the list is loading, the line says "Checking what needs you…". If nothing was found but some places could not be checked, it reads a quiet "Needs you · ?". The "+" after the number means "at least this many", replacing the odd "+?".

## Conversations always have a name

Telegram has no way to look up a conversation's name. When the Studio was rebuilt, the names of about sixty recent conversations were lost on every machine, so the app showed "Name not available yet" for them. Every conversation that belongs to a project already has a title Justin recognises: the Chief of Staff's project title. The server now uses that title whenever a conversation has no stored name. This covers the app's conversation list (`GET /mobile/conversations`), conversation search, and the dashboard (through the topic list every page reads, sent separately from confirmed names). A stored name always wins, and the project title is never saved as the conversation's real name. When the real name comes back (for example, the next time the agent writes in that conversation), it takes over.

## What is not affected

What needs you, who can see what, and every action in the list are unchanged. Only the layout and the names shown change. Checked on screen at phone and laptop size before committing.

## What you need to decide

Nothing. A revert restores the old layout and wording.
