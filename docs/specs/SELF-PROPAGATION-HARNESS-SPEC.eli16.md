# ELI16 — Self-Propagation Harness + the "two listeners" fix

## The goal

You want to be able to put "me" onto a second machine and test that I work there — over real Telegram — without it being a fiddly, hand-done dance every time. Right now it IS hand-done, and that's exactly why the last live test left muddy evidence.

## The two things that bit us last time

1. **"Two things trying to listen at once."** Telegram only lets ONE program listen for a bot's messages at a time. I have two programs that *can* listen: the lightweight "lifeline" (the normal listener) and the main server. The server is supposed to stay quiet and let the lifeline listen — but the only thing making it stay quiet is *remembering* to start it with a special flag. Forget the flag, and both try to listen, and Telegram throws a "conflict" error. That's willpower, not structure.

2. **A crash we mislabeled.** We'd written it down as a deep low-level "mutex" crash. It wasn't — it was a plain out-of-memory blowout (a helper process ate all its memory and died). And the test agent's own server actually started up fine and was still alive after that crash. So the real story is different from our notes, and the evidence is fuzzy because the deploy was done by hand.

## The fix — two parts

**Part 1 — make the "two listeners" problem impossible (you picked this).** Instead of relying on a flag, the lifeline leaves a little "I've got the listening covered" note. The server checks for that note on startup; if it's there and current, the server automatically stays quiet. Now it doesn't matter how the server was started — it can't double-listen. (If there's no note, the server behaves exactly as today, so nothing else changes.)

**Part 2 — the one-button harness.** A single command, `instar test-as-self`, that does the whole deploy as clean, checked steps: set up a throwaway test agent, copy my current code (rebuilding the bits that are machine-specific), start it the right way, send a test message and confirm I reply, capture any crash properly, and tidy up afterward. Repeatable and safe to re-run — so next time we get clean evidence instead of sifting crash logs by hand.

This is also the thing that unblocks the cross-machine test we've been holding (the seamlessness work).

## What you'll notice

Nothing in day-to-day use. Under the hood: the "conflict" error class is gone for good, and deploying me onto another machine becomes one command instead of a careful manual ritual.

## Honest note

The out-of-memory crash is diagnosed but NOT yet fixed — I won't claim a fix until the harness reproduces it cleanly and I see the real cause. The harness is the tool that lets me do that properly.

## Risk

Low for Part 1 (the "note" check is additive and falls back to today's behavior if the note is missing). Part 2 is a new command that only touches a throwaway test agent — never you, never the real setup.
