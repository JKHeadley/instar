# ELI16 — the Feedback Drain page now opens on what needs you

## The problem

The Feedback Drain page in the dashboard is where reports from people using Instar get turned
into fixes. Only two or three things on it are ever the operator's job: approving which model
sorts the reports, approving which model decides what gets fixed, and giving the fix worker a
one-time OK when it could otherwise approve its own fixes.

Before this change, the page opened on the drain's internal counters: "collecting 0; ready 3;
queued 1; retryable 0; held 2; dead-lettered 0", a "state: reason" code line, and byte and
generation lag numbers. The approval cards sat further down, and the first one only appeared
after an extra file finished loading. The operator opened it twice in one night and said he
could not tell what he was looking at or what he was supposed to do.

## What changes

The page now opens with one box. It holds one short sentence that says whether anything needs
the operator, one line saying why, and at most one button. If something needs him, the box has a
yellow edge and the button says "Review and approve" (or "Review and decide", "Review it", or
"Open the fix" for a fix waiting on GitHub). Pressing it opens the approval card, scrolls to it,
and puts the cursor in the PIN box. If nothing needs him, the box has a green edge, says
"Nothing here needs you.", and has no button.

Everything else moved into two closed drawers below: "Approvals and settings" holds the same
approval cards as before, unchanged, and "More detail" holds the counters.

This copies the Process Health page, which already opens with a plain headline and keeps its
numbers in a "More detail" drawer.

## What does not change

No approval, permission, route or PIN rule changes. The approval cards are the same code. The
button never approves anything by itself: it only shows the card. For the fix worker's one-time
OK, it also presses that card's own "Let it run anyway…" step, which only shows the server's
wording; the final confirmation still needs the operator's PIN.

## What the reader needs to decide

Nothing. This is a presentation change, and rolling it back is reverting one commit.
