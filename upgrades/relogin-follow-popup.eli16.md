# Automatic sign-in repair: follow the sign-in window

## What this is, in plain English

When an agent's Claude sign-in expires, Instar repairs it by opening Claude's sign-in page in the account's own browser window and clicking through. Claude's page offers "Continue with Google", and when you choose it, Google opens its own separate window for the sign-in. A person naturally looks at the new window, signs in there, and then turns back to the first window when the Google one closes.

## What was wrong

The repair was wired to exactly one browser tab from the moment it started: the Claude page. It had no idea a second window had opened. So after clicking "Continue with Google", it kept looking at the Claude page, saw the same button still there, clicked it again, and repeated that until its time ran out, while Google's window sat open waiting. On September 23rd a real repair did this three times in a row and gave up.

## What changes

Before every step, the repair now checks which browser windows are open. If a new window has appeared since it started, it switches its attention to that window and works there. When that window closes, it switches back to the original one. Nothing else about how it fills in forms or clicks buttons changes.

## What stays the same (the safeguards)

- Every page it reads still has to be on an approved sign-in address. A window on an unexpected site is refused exactly as before.
- Only windows that opened after the repair began count as candidates. The browser's own blank starting tab is never mistaken for one.
- Navigating to a new page and clearing browsing data still happen on the original window only.
- The passkey version of the browser gets the same "newest window" behavior, and its stricter origin rules are untouched.

## What you need to decide

Nothing. There are no new settings. Repairs that stalled right after "Continue with Google" should now carry on into Google's window and finish.
