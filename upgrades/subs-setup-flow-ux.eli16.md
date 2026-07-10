# Subscriptions "Set up" flow fixes — plain-English overview

## What this actually is

The dashboard's Subscriptions tab has a grid — accounts down the side, your machines across the top — where tapping "Set up" on an empty cell signs an account in on that machine: enter your PIN, open a sign-in link, paste back a code. Justin walked this flow on his phone on 2026-07-10 and hit five real problems, each screenshot-proven. This change fixes all five.

1. **The page stopped fighting your fingers.** The tab refreshes itself every 30 seconds, and that refresh used to REBUILD the grid — wiping the PIN box back into a "Set up" button if you didn't type fast enough, and swapping the paste-your-code step for a spinner before you could paste. Now there's a rule (Floor F9 of the Dashboard UX Standard): a refresh may never replace anything you're in the middle of using. An open step, a focused box, or a half-typed field stays exactly where it is; the refresh only updates things AROUND it, like the "link expires in 11m" countdown. The hold releases when the step finishes, fails, expires, or you tap Back.

2. **The whole flow lives in the cell now.** Before, the sign-in link and code box appeared in the cell, but the expiry countdown and the "Claude may ask for TWO codes" heads-up only existed in a panel at the very bottom of the page — Justin thought the flow had stalled until he happened to scroll. Now the cell carries every step end to end; the bottom panel is just a mirror.

3. **The wrong-account trap is guarded.** The sign-in link opens Anthropic's page in whatever account your browser is already logged into — Justin was enrolling headley.justin@gmail.com and the page said "Logged in as justin@sagemindai.io", with no warning anywhere. Now the cell says, right next to the link: "the sign-in page must show headley.justin@gmail.com — if it shows a different account, tap Switch account first." And the server-side identity check (which already existed and already refused mismatches) now tells you exactly what happened in plain words: "that code signed in justin@sagemindai.io — this slot needs headley.justin@gmail.com. The account was NOT enrolled." If the identity can't be confirmed at all, it still refuses — it never enrolls blind.

4. **Success looks like success.** Finishing used to be a quiet grey line of text. Now the cell flips to a green "✓ All set — [account] is signed in", pulses briefly, and the panel keeps an explicit "✓ Done" card. Failures and expired links get equally explicit red states with a working Retry.

5. **The re-sign-in path actually works now.** Justin's "Needs sign-in → Sign in" attempt died three ways at once: the record said "signing in" while the window doing the sign-in was long gone (so the code he pasted had nowhere to go), a second tap started a PARALLEL attempt whose code crossed with the first, and finishing would have crashed anyway because the account already existed in the registry. Now the server checks that the sign-in window is genuinely alive before offering a code box (a dead one shows "Sign-in needs a restart" with a Retry that starts cleanly), a re-tap always returns the ONE live attempt instead of minting a rival, a sign-in that completes without ever showing a code is detected and finished through the same identity check, and re-signing-in an existing account updates it back to active instead of crashing. Wording is fixed too: you see account emails and machine nicknames ("Laptop"), never internal IDs, and no error tells you to tap a button that doesn't exist.

## What already existed

The whole enrollment machinery (PIN gate, mandate, sign-in driving, the fail-closed email-identity check, the Cancel button on in-progress cells) already shipped and stays exactly as it was. This change fixes how the flow is PRESENTED and makes the record-keeping honest — the one behavioral addition is the liveness check + single-attempt rule + completion sweep around the existing pieces.

## The safeguards, in plain terms

- The identity check that refuses wrong accounts is unchanged — it still refuses, it just explains itself now.
- Nothing new is auto-accepted anywhere; every new refusal (dead window, not-ready window) refuses things that already failed before, just honestly.
- If the system can't tell whether a sign-in window is alive, it says "unknown" and behaves exactly like today — it never guesses.

## What you need to decide

Nothing — these are defect fixes to an existing flow, on by wherever the account-follow-me feature is already on (your dev agents; dark on the fleet). The one follow-up left open: rolling the new never-clobber refresh rule out to the OTHER dashboard tabs (Mandates, Process Health, Preferences) is tracked in the standard rather than crammed into this fix.

_Follow-up (same PR): the pane-liveness check's "couldn't look at the window" handler is deliberately conservative — it treats an unreadable window as dead and refuses the code rather than typing blind. A code-quality checker mistook that refusal for a silent failure; it now carries a note explaining itself. No behavior change._
