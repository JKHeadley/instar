# Setup never picks an AI account on its own

## What is going on

When you create a new Instar agent, you pick Claude or ChatGPT. Many people are already signed in to one or more of those accounts on their computer: a personal account, a work account, or the accounts their other agents use. Since 17 November, setup is supposed to show those accounts and ask which one the new agent should use, or offer to sign in to a different one.

That step had a back door. If setup was restarted while it was waiting for this answer, and no answer came with the restart, it assumed it was talking to an older app that didn't know the question. It then quietly used whichever account sat in the usual place. On 19 November Justin said plainly that setup must never just assume and claim an account.

## What changes

When setup is restarted at that step without an answer, it no longer picks an account. It shows the same list again and waits. Its message says that if no choice appears, the person should update the Instar app and try again. Once an answer arrives, setup carries on exactly as before. If there are no accounts on the computer at all, nothing changes: there is nothing to choose, so setup goes straight to signing in.

## Safeguards

Nothing is deleted or moved, and no settings change. The current Mac app always sends the answer, so it is not affected. Only an app from before 17 November would now stop and ask for an update instead of silently using an account.

## What needs deciding

Nothing.
