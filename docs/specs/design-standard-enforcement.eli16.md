# Design mistakes become rules, and screens are checked before they ship: Plain-English Overview

> The one-line version: when you point out a design flaw, the system itself opens a tracked card that cannot be closed until the flaw has a written diagnosis, a rule and a fix; and no change to any screen can merge or ship until it shows that screen at the standard sizes, checked against the rules.

> **Not approved yet.** This is the design. It goes through review first, and then it comes to you for the decisions listed at the end.

## The problem in one breath

On November 21 you compared the accounts screen in the Mac app with the same screen on the web dashboard and saw that the Mac one was clearly worse. When I diagnosed it, I found fifteen separate problems. For twelve of them we had no rule at all. For the others we had a rule that only applied to the web. I have since written one Design Standard with 65 rules for all six of our apps. But a written standard is still only a document. Nothing forces a session to look at a screen before it ships, and nothing makes sure your feedback turns into a rule instead of a reply in a chat.

## What already exists

- **The Design Standard.** Sixty-five rules, each with a permanent name, a good and a bad example, and a note saying whether a machine or a reviewer checks it. It also lists the screen sizes every screen must be looked at.
- **The first diagnosis.** Your accounts-screen feedback, written up problem by problem, with the rule each problem broke or the rule it caused me to add.
- **The merge check on our own machines.** Before any change to Instar merges, our own machines run the full test suite and record the result. A change cannot merge without that record. This is the strongest gate we have, and it does not depend on GitHub's busy servers.
- **The Work Board.** Cards with a checklist of "done when" items. A card cannot be marked done until every item has evidence, and only a person can tap to approve or confirm.
- **An older check that asks pull requests to describe their effect on users.** I looked at it closely. It watches a folder that does not exist, so it has never covered the dashboard, and it only applies to your own changes, not mine.

## What this adds

- **A clear answer to "is this a screen change?"** A written list of which folders and files are screens in each of our code bases, plus a list of every screen and the files that shape it. That second list matters: one cause of the accounts problem was in a server file that no folder rule would have flagged.
- **Proof that travels with the change.** Any change to a screen must include a small folder holding screenshots at the standard sizes, taken with awkward real-looking data (a very long name, a value of 100%, a zero, a missing value), and a checklist with one line for every rule that applies. When the same screen exists in another app, the folder also holds that app's version, side by side.
- **A script that checks the proof instead of trusting it.** It confirms the screenshots were taken from the exact version being merged, that each image really is the size it claims, and that no rule was skipped without a reason.
- **Automatic checks in a real browser.** For the web dashboard, the machine itself loads each screen at each size and measures: does the page scroll sideways, is any text cut off, does a number like "100%" wrap onto two lines, is the contrast high enough on the actual background, is every button big enough to tap, does every control have a name.
- **A tracked card for every piece of your design feedback.** When you point out a design flaw, the system recognises it and opens a card by itself. The card has five items: the written diagnosis, the rule changes, the fix on every app that shows the screen, a check so it cannot happen again, and your own look at the result.
- **A consistency check on the standard itself.** A script makes sure every rule that came from your feedback points to the diagnosis that caused it, every diagnosis points back to its rules, the change history is complete, and no rule name is ever reused or silently removed.

## What changes for you

**You point something out once.** You do not need to ask for a diagnosis or a rule. A card appears for the feedback. You can watch it on the Work Board. I cannot mark it done until the diagnosis is merged, the standard cites it, and the fixed screen passes the rules it broke.

**You confirm the fix with one tap.** The last item on each card is yours: you look at the before and after pictures and tap to confirm. If I opened a card for something that was not really design feedback, one tap closes it and I learn from the reason.

**You are the only one who can make an exception.** If a change truly needs to ship with a rule failing, I must ask you with a card that names the exact change and the exact rules. I cannot approve it myself, and editing the change afterwards cancels your approval.

**You should stop seeing the same kind of mistake twice.** That is the number I will report: how often you point out something a rule already covered. The goal is zero.

## What changes for every development session

- A session that changes a screen runs one command that takes the screenshots, runs the automatic checks and writes the checklist. A separate reviewer that did not write the change answers the questions a machine cannot, such as "can you tell in five seconds which accounts have room?".
- If the session skips this, the merge is refused with a message that says what is missing and how to produce it.
- A session that says "this is only a tidy-up, nothing visible changed" is not taken at its word. The machine renders the screen before and after the change and compares the two pictures.
- For the phone and desktop apps, which live in a separate code base with no automatic merge checks at all, the gate sits in the scripts that build and upload a release. A release that contains an unchecked screen change stops. A daily check also looks for anything that went around the gate and opens a card for it.

## The safeguards

**It will not freeze all work on day one.** Screens that already break a rule are recorded as a starting count. A change may not add a new violation, and the count can only go down. The one exception: if you are changing a screen, any mistake on it that you have already pointed out must be fixed in that change.

**New checks start by reporting, not blocking.** The requirement to include screenshots and a checklist blocks from the first day, because it is simple and reliable. Each automatic browser check first only reports. It starts blocking after it has run on ten real changes and every false alarm has been traced and fixed.

**A check that cannot run does not pass.** If a machine has no browser to run the checks in, the result is a clear failure that says so. It is never a silent pass.

**Your rules cannot be quietly weakened.** A rule that came from your feedback can be made stricter by me. It can only be loosened or retired with your tap.

**It does not slow your messages.** Recognising design feedback happens in the background and can never delay or drop a message.

## What it does not do yet

- **Phone and desktop apps get fewer automatic checks at first.** For the web, the machine measures the screen itself. For the iPhone, Mac, Android, Windows and Linux apps, the first version checks that screenshots exist, are the right size and are fresh, and scans the code for a few simple mistakes. Real measured checks come in stages: Apple first, then Android, then Windows and Linux.
- **For those apps, the screenshots are trusted as taken.** Until the measured checks arrive, the gate cannot prove that a native screenshot truly shows the current code. It can only prove the picture is the right size and was recorded against the current version of the files.
- **The reviewer's answers are not proven by a machine.** Questions like "is this clear at a glance?" are answered by a second model, and its answer is recorded. Your own look at each fix you asked for is the real check on it.
- **A determined session could still go around the gate** by merging with special permissions or building an app by hand. The daily check finds this within a day and opens a card.
- **It covers Instar's own screens only.** Other agents' own projects are not gated in this version.
- **It does not cover the public website or the wording of messages.** Message wording keeps the checks it has today.

## What ships when

1. **The accounts fix on the server and the web.** The server sends each account's limits in one fixed order, with a properly capitalised name and a colour state for each, so every app shows the same thing. The web list gets a tie-break by name. One shared test makes sure the server and the web agree on where amber and red begin. The Apple session's Mac fix reads these.
2. **The screen list, the proof folder, the checking script and the consistency check.**
3. **The automatic browser checks and the merge gate for Instar's own code.**
4. **The design-feedback card and the step in every development session's process.**
5. **The gate for the phone and desktop apps:** the release scripts, the daily check, and the simple code scans.
6. **Measured checks for the Apple apps.**
7. **Measured checks for Android.**
8. **Measured checks for Windows and Linux.**
9. **The new rule in the constitution.**

Each step is proven first on a throwaway agent and a throwaway copy of the code, then runs on Echo with your real feedback and real screen changes.

## Two things I found while reading the code

- **The web and the apps can disagree about one colour.** At 89.6%, both show "90%". The web paints it amber, because it decides the colour before rounding. The server tells the apps red, because it decides after rounding. Step 1 makes both decide from the number you actually see.
- **The web and the apps order accounts differently in one case.** The apps list an account that needs a sign-in first. The web does not. Neither of your screenshots showed that case, so nobody has decided which is right. Step 1 leaves it alone and records it on the accounts diagnosis as an open point.

## What you actually need to decide

Approve the spec. Saying yes includes these choices. If you would choose differently on any of them, tell me which and I will change that one.

1. **It covers Instar's own six apps only,** not other agents' projects.
2. **The screenshot set.** For the web: desktop and phone in dark mode, desktop in light mode, and a wide screenshot only when the layout itself changes. For each app: standard size, smallest size and large text in dark mode, plus standard size in light mode.
3. **Screenshots are stored in the code repository itself,** capped at 300 KB each, with old ones cleared out monthly unless a diagnosis cites them. This makes them checkable by a script. The cost is that the repository grows.
4. **Day one: missing proof blocks; browser checks only report** until each has proven itself on ten real changes.
5. **Only you can make an exception,** by tapping a card.
6. **Changing a screen means fixing the mistakes on it that you already pointed out,** even when other old problems on it are allowed to wait.
7. **You confirm each fix with one tap.** The alternative is that I close the card myself and simply tell you.
8. **Your design feedback is recognised automatically.** The alternative is that cards open only when a session remembers, which is what you asked me to avoid.
9. **I may add and tighten rules without asking you.** Loosening or retiring a rule that came from your feedback needs your tap.
10. **The phone and desktop apps' gate does not use GitHub's own protections,** because that code base's GitHub plan does not offer them. The alternative is paying for a plan that does.
11. **The order of measured checks for the apps:** Apple, then Android, then Windows and Linux.
12. **Two new development tools** are added to run the browser checks: one to drive the Chrome browser already on our machines, and one that measures contrast and button sizes.
13. **A second model answers the judgment questions** on every screen change, and its name is recorded.
14. **One new constitution rule:** "Design Mistakes Become Rules; Screens Are Shown Against the Rules Before They Merge." The constitution file is one of the few things only you can approve on GitHub, so that single change will need your review there.
15. **The public website and message wording are left out.**
16. **The two findings above:** colour is decided from the rounded number, and the sign-in ordering difference is recorded but not changed yet.
17. **The older user-impact check gets its broken folder name corrected,** and is otherwise left as it is.
