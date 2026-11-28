# ELI16: secrets stop appearing in the list of running programs (SEC-155)

When the agent saves a secret to the Mac's keychain, such as a login for Claude or the key that unlocks its private vault, it runs a small built-in program called `security`. It used to hand that program the secret as part of the command itself.

On a Mac, anyone with an account on the same computer can see every program that is running and the exact command it was started with. So for the moment the save was running, another person logged in to that Mac could have read the secret.

Now the agent types the command into the program through a private channel, its input, which other accounts cannot see. The secret is also written as a string of hex digits. The keychain stores exactly the same thing as before, and if a save fails, the agent notices just as it did before.

One bookkeeping step: the new helper is listed, with a reason, in the record of code that a separate delivery check watches. It has nothing to do with delivering messages.
