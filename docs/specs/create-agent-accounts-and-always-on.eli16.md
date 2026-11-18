# Choosing the AI account, and Always available (ELI16)

## The problem

When you create an agent in the Instar Mac app, you pick which AI it uses: Claude or ChatGPT. You may already be signed in to one or more of those accounts on your Mac, perhaps because other agents use them. Today the installer just takes whichever account it finds in the usual place and never asks. If you wanted the agent on your work account rather than your personal one, you couldn't choose.

Separately, an agent only runs while you're logged in and the Mac is awake. For an agent that's supposed to be there for you all the time, that's a gap: after a power cut and restart, it waits until someone logs in, and the Mac can fall asleep while the agent is working.

## What changes

**Choosing the account.** After you pick Claude or ChatGPT, setup looks for accounts of that kind already signed in on this Mac and shows each one by its email, including the ones your other agents use. You tap one to use it, or choose to sign in to a different account. An existing account is shared with the new agent, not copied. A new sign-in gets its own space that belongs to the new agent. Setup only reads who each account belongs to; it never reads a password or a key.

**Always available.** The confirm step gets one switch, off unless you turn it on. Turning it on asks for your Mac's password once, and turning it off asks again. When it's on:
- the Mac stays awake while it's plugged in and the lid is open (a closed laptop lid still sleeps);
- after a power cut, the Mac starts again by itself.

Instar keeps a protected record of exactly what it changed, so switching it off puts everything back.

**Starting before anyone logs in** depends on FileVault, the disk encryption that's on by default on new Macs. With FileVault on, a restarted Mac waits for someone to type the password before anything can run, so Instar doesn't promise more than that. With FileVault off, the agent can also start before anyone logs in. There's one more step in that case: before login, macOS keeps the usual Claude sign-in locked, so setup asks you to sign in to Claude once more and paste the code it shows. That code becomes this agent's Claude sign-in while the switch is on. It's readable only by you, checked against the account you chose, and removed when you turn the switch off. ChatGPT normally doesn't need this.

**Accounts used by other agents** can be shared, the way agents on one Mac already share the usual account. The card says plainly that the agents then share that account's usage limit and sign-in. For an agent that should run on its own, it suggests signing in to a different account instead.

## What stays the same

If you don't make an account choice, setup works exactly as it does now. Always available is off unless you turn it on.
