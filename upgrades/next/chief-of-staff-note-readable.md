## What Changed
- **The Chief of Staff note is readable.** Projects that look finished are grouped under one headline with the count ("4 projects look finished and need your OK"). Each gets a short block: a short name (the initiative title or conversation name, else the goal's lead, never cut mid-word), how many automatic checks passed, the judgment item(s) it waits on quoted from its done list, and a link to that project. The repeated "every automatic check passes. Confirm it's done?" line is gone.
- **Buttons name their project.** "Done: <project>" and "Unpark: <project>" instead of four identical "Confirm done" buttons. The button ids are unchanged. In the owner's private chat, three or more buttons now get one row each; a two-button pair (Approve / Decline) keeps its single row.
- **Links open on a phone.** The note links to the console's Chief of Staff page through the public tunnel (`/dashboard/console/#/work/chats`, and `?c=<conversation>` per project). With no public link, the note carries no link instead of a localhost one.
- **Footers name the machine.** A machine with no pool nickname now shows its own name (from pairing or its identity) in message footers instead of "Machine m_xxxxxx"; the raw id appears only when the machine has no name at all.

## What to Tell Your User
My daily Chief of Staff note is now much easier to read: each finished-looking project gets its own short block saying what passed and what I need you to judge, with a link you can open on your phone, and each button says which project it confirms.

## Summary of New Capabilities
- Grouped "looks finished" blocks in the Chief of Staff note, with per-project buttons and phone links.
- Machine names instead of raw machine ids in message footers.

## Evidence
- `tests/unit/chief-of-staff-note-layout.test.ts`: word-boundary cuts, short titles, button labels, grouped blocks, the no-link fallback, footer machine names.
- `tests/unit/ChiefOfStaffLoop.test.ts`: the four-project send path end to end through the loop (text, buttons in order, ids within 64 bytes, phone links), no tunnel, a real title, more projects than the cap.
