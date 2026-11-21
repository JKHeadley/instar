# Design mistakes become rules, and screens are checked before they ship: Plain-English Overview

> The one-line version: when you point out a design flaw, it becomes a tracked card that closes only once the flaw has a written diagnosis, a rule, a fix that has been seen working on every app, and a check that catches it next time; and every change to a screen is pictured and checked against the rules by our own machines before it merges or ships.

> **Not approved yet.** This is the design after the fourth round of review. Your decisions are listed at the end.

## What this is and why

On November twenty-first you compared the Mac app's accounts screen with the web dashboard's, saw the Mac one was clearly worse, and asked that when you point out a bad design, we "officially diagnose what went wrong ... and then update our required UI/UX design standards (that should be infrastructurally enforced for ALL development that we do) such that we no longer make those mistakes," with the goal of "better and better results in our designs that align with our goal to delight the user."

That screen had fifteen problems, most with no rule at all. There is now one Design Standard for all six apps, but nothing enforces it, and turning feedback into a rule depends on memory. This design makes all three automatic.

## What changes for you

Almost nothing. You point out a design problem in the conversation, the server notices it, the session confirms it, and a card opens. Your own message counts as the approval, so the card never waits for your tap and never drifts into your waiting list while a fix is pending. That way of approving comes from another change not merged yet, and this part is built after it lands.

The card closes by itself once the server has checked the diagnosis, the rule changes, the fix and the new check; the fix counts only when pictures of the fixed screen pass on every app the feedback was about. Then you are shown before and after pictures. If it still looks wrong, say so and the entry continues.

You are asked for something in only two cases: waiving or loosening a rule your feedback created, and approving the new constitution wording. Even a waiver reaches you only when the session that wrote the change asks for one with a written reason; otherwise it simply fixes the change. The gate's own fix list is kept internally and never asks you anything.

## What changes for every development session

Our own machines already run every test before a change may merge. Now, when a change touches a screen, they also draw it before and after the merge, at the standard laptop, phone, tablet and monitor sizes, in dark, light and zoomed in, with invented data passed through the real code.

If the pictures differ, or an automatic check finds a serious problem even though the pictures look the same, the machine starts a fresh reviewer that did not write the change, which sees before and after side by side. Where a screen also exists in the apps, it also sees the latest shipped app picture. A change may not add problems but need not clear old ones; old problems on your rules go onto the fix list. A change that claims to fix your feedback must leave that problem gone, and one that breaks a working screen is refused. Automatic checks only report until the weekly review finds each one proven.

The decision is part of the pass mark every merge already needs, so no shortcut skips it, including a change that only edits the design rules themselves. The reviewer gets a private one-time key in its own surroundings, never in its instructions, so the author cannot answer for it. If another of our machines takes over, it checks again, and your approval carries over.

## The safeguards

- **The gate makes the pictures itself**, using the checks already on main, so a change cannot weaken its own judge.
- **Private evidence stays private.** Pictures never enter the public code.
- **A broken tool never stops merges for long.** A failed drawing is recorded by name. A daily sweep also draws every change that actually landed against the version just before it, since that can differ from what was checked. If it falls behind it speeds up; you hear only if it is two days behind. If the older version cannot be built, the change waits for retries first.
- **The off switch cannot quietly bypass you.** Turning the checks off is recorded, you are told why, and it turns itself back on within a day; your rules still need your tap meanwhile.
- **Your earned rules need you.** A rule your feedback created is waived or loosened only by tapping Approve on a card on your phone, with Face ID, for that exact change; any new commit cancels it, but a recheck on another machine does not ask you again. The dashboard PIN does not count, because I can read it.
- **Only your real words count.** The server checks that you wrote the message yourself.

## How the accounts screen runs through it

It goes first. Usage limits keep a fixed order, a limit that has already reset gets no colour and stops counting as the tightest, and colour follows the rounded number shown, so ninety percent is red everywhere. One shared test proves the web and the server agree, and the app sessions are told how to draw it.

The native apps have no pull requests, so the check runs in each app's release script, each app on its own. From the first release after the step is added, every changed screen needs pictures at the standard sizes and an independent reviewer's answers, kept privately. Until each app has its own picture tool, the pictures come from the app's debug capture mode, which also records the app build, the test data version, and the screen and text size of each picture, so a picture from an older build is refused. Where a rule says two apps must match, the reviewer sees both apps side by side. Those tools are tracked work with a named owner.

## Out of scope

Other agents' projects, the public website and message wording (tracked for later), deciding what good design is, and the native side of the accounts fix.

## What you are being asked to decide

1. **Scope is Instar's own development, for now.** *Recommended*, because holding other agents' projects would restrict them.
2. **Who can let a change through with a rule failing.** For a rule your feedback earned, only you, by a Face ID tap, and only when asked. For any other rule, an independent reviewer with a recorded reason, listed weekly. *Recommended*; the alternative is that you approve every waiver.
3. **You are never asked to approve or close a design-feedback card.** *Recommended*. The alternative is a confirming tap on every card.
4. **Loosening an earned rule needs you**: removing an app, downgrading, retiring, or making its check report-only. Adding and tightening is mine. I wrote the sentence in the standard that says so; your approval here makes it your rule. *Recommended*.
5. **One constitution article, in both rule books.** Approving this design approves both wordings; the registry change also needs your approval on GitHub, sent as a link for your phone.
