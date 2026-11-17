# Choosing the AI account, and Always available (ELI16)

## The problem

When you create an agent in the Instar Mac app, you pick which AI it uses: Claude or ChatGPT. You may already be signed in to one or more of those accounts on your Mac, perhaps because other agents use them. Today the installer just takes whichever account it finds in the usual place and never asks. If you wanted the agent on your work account rather than your personal one, you couldn't choose.

Separately, an agent only runs while you're logged in and the Mac is awake. For an agent that's supposed to be there for you all the time, that's a gap: after a power cut and restart, it waits until someone logs in, and the Mac can fall asleep while the agent is working.

## What changes

**Choosing the account.** After you pick Claude or ChatGPT, setup looks for accounts of that kind already signed in on this Mac and shows each one by its email, including the ones your other agents use. You tap one to use it, or choose to sign in to a different account. An existing account is shared with the new agent, not copied. A new sign-in gets its own space that belongs to the new agent. Setup only reads who each account belongs to; it never reads a password or a key.

**Always available.** The confirm step gets one switch, off unless you turn it on. When it's on:
- the agent starts when the Mac starts, even before anyone logs in;
- the Mac stays awake while it's plugged in (the screen can still turn off).

These two settings need your Mac's password once, because macOS requires it for both. Instar keeps a record of exactly what it changed, so switching it off later puts everything back.

**One catch.** Before anyone logs in, macOS keeps the usual Claude sign-in locked away. So turning on Always available also sets up a second Claude sign-in that works before login. ChatGPT doesn't have this problem.

## What stays the same

If you don't make an account choice, setup works exactly as it does now. Always available is off unless you turn it on.
