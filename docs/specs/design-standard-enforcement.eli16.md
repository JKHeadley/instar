# Design mistakes become rules, and screens are checked before they ship: Plain-English Overview

> The one-line version: when you point out a design flaw, it becomes a tracked card that closes only once the flaw has a written diagnosis, a rule, a fix that has been seen working on every app, and a check that catches it next time; and every change to a screen is pictured and checked against the rules by our own machines before it merges or ships.

> **Not approved yet.** This is the design after the third round of review. Your decisions are listed at the end.

## What this is and why

On November twenty-first you compared the Mac app's accounts screen with the web dashboard's, saw the Mac one was clearly worse, and asked that when you point out a bad design, we "officially diagnose what went wrong ... and then update our required UI/UX design standards (that should be infrastructurally enforced for ALL development that we do) such that we no longer make those mistakes," with the goal of "better and better results in our designs that align with our goal to delight the user."

That screen had fifteen problems, most with no rule at all. There is now one Design Standard for all six apps, but it is only a document: nothing makes anyone look at a screen or runs the checks, and turning feedback into a rule depends on memory. This design makes all three automatic.

## What changes for you

Almost nothing. You point out a design problem in the conversation, the server notices it, the session confirms it, and a card opens. Your own message counts as the approval, so the card never waits for your tap and never drifts into your waiting list while a fix is pending. That way of approving comes from another change that is built but not merged yet, and this part is built only after it lands.

The card closes by itself once the server has checked the diagnosis, the rule changes, the fix and the new check; the fix counts only when pictures of the fixed screen pass on every app the feedback was about. Then you are shown before and after pictures. If it still looks wrong, say so and the entry continues.

You are asked for something in only three cases: waiving or loosening a rule your feedback created, approving the new constitution wording, and, under your current board setting, one tap to approve the single standing card where the gate keeps its own fix list.

## What changes for every development session

Our own machines already run every test before a change may merge. Now, when a change touches a screen, they also draw it before and after the merge, at the standard laptop, phone, tablet and monitor sizes, in dark, light and zoomed in, with invented data passed through the real code. Each side is drawn twice; differing drawings mark the screen unreliable.

If the pictures differ, the machine starts a fresh reviewer that did not write the change, which sees before and after side by side. A change may not add problems but need not clear old ones; old problems on your rules go onto the fix list. A change that claims to fix your feedback must leave that problem gone, and one that breaks a working screen is refused. Automatic checks start by only reporting until the weekly review finds each one proven.

The decision is part of the pass mark every merge already needs, so no shortcut skips it, including a merge made while only the backup checks are running. Only the reviewer the machine started can answer, so the author cannot mark its own work.

## The safeguards

- **The gate makes the pictures itself**, using the checks already on main, so a change cannot weaken its own judge.
- **Private evidence stays private.** Pictures and your screenshots never enter the public code.
- **A broken tool never stops merges for long.** A failed drawing is recorded by name and a daily sweep draws that change again, even on a day with no merges. If the older version cannot be built at all, the change waits and is retried first. You hear about it only if the retries keep failing.
- **The off switch cannot quietly bypass you.** Turning the checks off is recorded, you are told why, and it turns itself back on within a day; your rules still need your tap meanwhile.
- **Your earned rules need you.** A rule your feedback created is waived or loosened only by tapping Approve on a card on your phone, with Face ID, for that exact change; any new commit cancels it. The dashboard PIN does not count, because I can read it.
- **Only your real words count.** The server checks that you wrote the message yourself.

## How the accounts screen runs through it

It goes first. Usage limits keep a fixed order, a limit that has already reset gets no colour and stops counting as the tightest, and colour follows the rounded number shown, so ninety percent is red everywhere. The server sends each limit's name and colour, one shared test proves the web and the server agree, and the app sessions are told how to draw it.

The native apps have no pull requests, so the check runs in each app's release script, each app on its own. From the first release after the step is added, every changed screen needs pictures at the standard sizes and an independent reviewer's answers, kept privately. The first release starts from the last build known to have shipped, or checks every screen if that is unknown. Until each app has its own picture tool, the pictures come from the app's debug capture mode, which also records the screen size and text size each picture was taken at. Where a rule says two apps must match, the reviewer sees both apps side by side. Those tools, and automatic checks for the apps, are tracked work with a named owner.

## Out of scope

Other agents' projects, the public website and message wording, all tracked for later; deciding what good design is; and the native side of the accounts fix, which the Apple app session is building.

## What you are being asked to decide

1. **Scope is Instar's own development, for now.** *Recommended*, because holding other agents' projects would restrict them.
2. **Who can let a change through with a rule failing.** For a rule your feedback earned, only you, by a Face ID tap. For any other rule, an independent reviewer with a recorded reason, listed weekly. *Recommended*. The alternative is that you approve every waiver.
3. **You are never asked to approve or close a design-feedback card.** *Recommended*. The alternative is a confirming tap on every card.
4. **Loosening an earned rule needs you**: removing an app from it, downgrading it, retiring it, or making its check report-only again. Adding and tightening is mine. I wrote the sentence in the standard that says so; your approval here makes it your rule. *Recommended*.
5. **One constitution article, in both rule books.** Approving this design approves both wordings; the registry change also needs your approval on GitHub, sent as a link for your phone.
