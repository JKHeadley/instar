# Design mistakes become rules, and screens are checked before they ship: Plain-English Overview

> The one-line version: when you point out a design flaw, it becomes a tracked card that closes only once the flaw has a written diagnosis, a rule, a fix that has been seen working on every app, and a check that catches it next time; and every change to a screen is pictured and checked against the rules by our own machines before it merges or ships.

> **Not approved yet.** This is the design after the second round of review. Your decisions are listed at the end.

## What this is and why

On November twenty-first you compared the Mac app's accounts screen with the web dashboard's, saw the Mac one was clearly worse, and asked that when you point out a bad design, we "officially diagnose what went wrong ... and then update our required UI/UX design standards (that should be infrastructurally enforced for ALL development that we do) such that we no longer make those mistakes," with the goal of "better and better results in our designs that align with our goal to delight the user."

That screen had fifteen problems, and for most of them we had no rule at all. There is now one Design Standard for all six apps, but it is only a document: nothing makes anyone look at a screen, nothing runs the checks, and turning your feedback into a rule depends on memory. This design makes all three automatic.

## What changes for you

Almost nothing. You point out a design problem in the conversation, the server notices it, the session confirms it, and a card opens. Your own message counts as the approval, so the card never waits for your tap. That way of approving comes from another change that is finished but not merged yet, and this part is built only after it lands.

The card closes by itself once the server has checked the diagnosis, the rule changes, the fix and the new check. The fix only counts when pictures of the fixed screen pass the rules on every app the feedback was about, the Mac included. Then you are shown before and after pictures. If it still looks wrong, just say so and the entry continues.

You are asked for something in only three cases: waiving or loosening a rule your feedback created, approving the new constitution wording, and, under your current board setting, one tap to approve the single standing card where the gate keeps its own fix list.

## What changes for every development session

Our own machines already run every test before a change may merge. Now, when a change touches a screen, they also draw it as it is now and exactly as it will be after the merge, at the standard sizes for laptop, phone, tablet and large monitor, in dark and light, and zoomed in, with invented data passed through the real code. Each side is drawn twice; if the two drawings differ, that screen is marked unreliable and fixed rather than trusted.

If the pictures differ, the machine starts a fresh reviewer that did not write the change. It sees before and after side by side, so it can tell a new problem from an old one. A change may not add problems but need not clear old ones; old problems on your rules go onto the fix list. A change that says it fixes your feedback must leave that problem gone. A change that breaks a screen which worked before is refused. Automatic checks start by only reporting, and the weekly review makes each one blocking once it has proven itself.

The decision is part of the pass mark every merge already needs, so no shortcut skips it.

## The safeguards

- **The gate makes the pictures itself**, using the checks already on main, so nothing is stale or staged and a change cannot weaken its own judge.
- **Private evidence stays private.** Pictures and your screenshots never enter the public code.
- **A broken tool never stops merges.** A failed drawing is recorded by name, one warning is raised, and a daily sweep draws those changes again.
- **The off switch cannot quietly bypass you.** Turning the checks off is recorded, you are told why, and it turns itself back on within a day. Meanwhile a change to a screen that breaks one of your rules still needs your tap.
- **Your earned rules need you.** A rule your feedback created is waived or loosened only by a Face ID tap on your phone for that exact change. The dashboard PIN does not count, because I can read it.
- **Only your real words count.** The server checks for itself that you wrote the message, and not a forward or a team member.

## How the accounts screen runs through it

It goes first. Usage limits appear in a fixed order instead of being re-sorted by fullness. A limit that has already reset gets no colour and stops counting as the account's tightest. Colour comes from the rounded number that is shown, so a number shown as ninety percent is red everywhere. The server sends each limit's name and colour, and one shared test proves the web and the server agree. The Apple and Windows app sessions are told how to draw it; the Android app shows only a one-line summary and needs no change.

The native apps have no pull requests, so the check runs in each app's release script, with the iPhone and Mac apps tracked separately because they ship separately. From the first release after the step is added, every changed screen needs pictures at the standard sizes and an independent reviewer's answers, kept in the private apps repository. Until each app has its own picture tool, the pictures come from the app's debug capture mode. Those tools, and automatic checks for the apps, are tracked work with a named owner.

## Out of scope

Other agents' projects, the public website, and the wording of messages, all tracked for later. Deciding what good design is, which the standard does. The native side of the accounts fix, which the Apple app session is building.

## What you are being asked to decide

1. **Scope is Instar's own development, for now.** *Recommended*, because holding other agents' projects would restrict them. Offering it to users is tracked separately.
2. **Who can let a change through with a rule failing.** For a rule your feedback earned, only you, by a Face ID tap. For any other rule, an independent reviewer with a recorded reason, listed weekly. *Recommended*. The alternative is that you approve every waiver.
3. **You are never asked to approve or close a design-feedback card.** Your message is the approval, and the card closes when everything is verified. *Recommended*. The alternative is a confirming tap on every card.
4. **Loosening an earned rule needs you**: removing an app from it, downgrading it, retiring it, or making its check report-only again. Adding and tightening is mine. I wrote the sentence in the standard that says so; your approval here makes it your rule. *Recommended*.
5. **One constitution article, in both rule books.** Approving this design approves both wordings; the registry change also needs your approval on GitHub, sent as a link for your phone.
