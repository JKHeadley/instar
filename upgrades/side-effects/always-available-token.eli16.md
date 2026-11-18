# Always available, part 2: Claude before anyone logs in (ELI16)

## What was wrong

An agent started before anyone logs in to the Mac can't use the Claude sign-in that's kept in the Mac's login keychain, because that keychain stays locked until someone logs in. So it needs its own Claude sign-in code, the kind Claude's own setup-token page gives you.

## What changed

The Mac app can now hand Instar that code. Instar first asks Claude which account the code belongs to, and refuses it if that isn't the account you chose for this agent, so you can't end up on the wrong account by accident. Then it saves the code where the agent's Claude sign-in lives, and remembers what was there before. When you turn Always available off, the earlier sign-in comes back, unless you changed it yourself in the meantime.

The code is never typed on a command line, and the remembered note doesn't contain it.
