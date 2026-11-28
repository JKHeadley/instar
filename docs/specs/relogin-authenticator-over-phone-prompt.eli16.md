# Sign-in repair: use the saved authenticator code instead of waiting for a phone tap

## What this is about

When one of the agent's subscription accounts gets signed out on a machine, Instar can sign it back in by itself. It opens that account's own Chrome profile, types the saved password, enters the second step, and checks that the right account came back.

For many Google accounts, the second step Google shows first is a phone prompt: "Check your phone", a tap in the Gmail app, or a number to tap. Google also offers other ways under a link called "Try another way". One of those is a six-digit code from an authenticator app. For several of our accounts that authenticator secret is already saved in the agent's vault, so the repair can make that code itself.

Today the repair does not do that. Its instructions say to choose "Try another way" only on a passkey screen. On any phone prompt they say to stop and ask a person to tap their phone. So an account that could be repaired fully by itself waits for a human. On November 26 this stopped account B's repair on Mama PC, and on November 25 it stopped one account's repair on the Laptop.

## What changes

- When an account signs in with a password plus an authenticator, and its authenticator secret is saved, the repair is now told: at Google's two-step phone prompt, choose "Try another way", pick the Google Authenticator option, and enter the code. It asks for a phone tap only if Google lists no authenticator option.
- It starts in a watch-only mode on development agents (this agent's own machines). At a phone prompt, the repair only reads and records the page heading, then asks for the phone tap as today. Once a few of those records check out against the browser's own output, it is turned on machine by machine. Even then, Instar lets each machine use it only once at a time for the first three uses: the next use waits until the previous one has been reviewed, and one bad review switches it off on that machine for good, at any time. A repair can only be reviewed after it has finished. When Google asks for the authenticator code directly, nothing changes from today. Everyone else keeps today's behaviour until the records show it works. One setting turns it back to watch-only, or off, on any machine.
- The sign-in guide gains one line telling the repair to follow its instructions for this page. The by-hand steps and the safety table are unchanged.
- The step is allowed on one kind of page only: a Google page whose heading says "2-Step Verification". The repair has to ask Instar before it starts and again before each code, and Instar says yes only for that heading and for at most two codes. If both codes fail, it stops and does not try again on its own later, because repeated wrong codes can make Google suspicious of the account. A warning about unusual activity always wins, even on that page.
- Before acting, the repair reads the page's heading text from the page itself, and Instar checks that text. Each try records what happened (the code was accepted, the code was rejected, or Google offered no authenticator option) and whether the heading really was "2-Step Verification". A use on any other heading is treated as a reason to undo this change. A weekly review reads those records on every machine and compares them with the month before.

## What stays exactly the same

- Google's real safety checks are still never worked around. These are a "Verify it's you" or unusual-activity page, a code sent by text message, or a CAPTCHA. The repair still stops and hands those to a person, and the new text says so in plain words.
- An account without a saved authenticator sees exactly the same instructions as before, word for word.
- Single-use backup codes stay out of unattended repairs.
- The repair still only counts as working when Instar itself confirms the right account is signed in and makes a real call with it.

## Why this is safe

Choosing the authenticator code on Google's own list of second steps is the same choice a person makes when their phone is not handy. The account owner set that method up. It does not bypass a check: Google is asking which second step to use, and the code is one of its own answers. The line that matters, never getting around a "Verify it's you" or CAPTCHA check, is kept and spelled out next to the new step.

## What is not in this change

The other repair path, which drives the browser from fixed page rules rather than a helper session, still stops at a phone page. Teaching it to pick from Google's list needs a new kind of page and a new allowed click, so it gets its own reviewed change.

## What a reader needs to decide

The real decision is the one above: the repair may now finish Google's second step with nobody present, on accounts that have an authenticator saved. A person reading this should weigh one remaining risk. The repair could mistake a "Verify it's you" check for the normal two-step page, because both can say "Check your phone". The safeguards are the page-heading test, the rule that an unclear page counts as a risk check, and the two-code limit. The records cannot catch a mistake of that kind if Google then accepts the code, and the spec says so plainly.

The operator does not need to approve anything. The change adds one setting (watch-only, on or off, per machine) and one way for the reviewing agent to record each review, and no new permission. Switching the setting off, or reverting the change, restores the old instructions on the next restart. The one guide line that stays behind just says to follow the repair's instructions, so it does no harm.
