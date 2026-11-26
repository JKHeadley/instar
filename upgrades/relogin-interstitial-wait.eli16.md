# Automatic sign-in repair: wait out the bot check

## What this is, in plain English

When one of an agent's Claude sign-ins expires, Instar can repair it by opening Claude's sign-in page in the account's own browser window and approving the sign-in there. Claude's sign-in page is protected by Cloudflare, so the first thing a browser often sees is a "Just a moment… checking you're not a bot" screen. For a normal browser window that screen clears by itself, usually in half a minute to a minute and a half, with nothing to click.

## What was wrong

The repair didn't know what that screen was. It filed it under "page I don't recognize", and for unrecognized pages it waits under a second and looks again, up to twenty times. That's about 15 seconds in total. Then it gives up and calls the attempt a temporary failure. So every attempt walked away just before the door opened. On September 23rd a real repair did exactly this three times in a row and then stopped for good.

## What changes

The repair now recognizes the bot-check screen by its title and wording. When it sees it, it waits patiently, checking every three seconds, for up to a minute and a half, and only then gives up. Those waiting checks don't count against its normal limit of steps, and they don't involve the supervising model at all, since the only sensible thing to do is wait.

## What stays the same (the safeguards)

- A real CAPTCHA that needs a human to solve is still treated as a human-only stop. The bot-check hold is a different, separately recognized screen.
- The wait is capped. After a minute and a half the attempt still ends as a temporary failure, and all the existing limits (three attempts, ten minutes per repair, the circuit breaker) apply unchanged.
- It clicks nothing and types nothing on that screen. It only waits.

## What you need to decide

Nothing. There are no new settings. You should see repairs that used to fail in 15 seconds now get through to the actual sign-in.
