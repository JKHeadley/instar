# Login Flow Restart Recovery — ELI16

A sign-in flow has two parts: a saved card describing it, and a live program
waiting for the code. The card already survived a server restart, but the live
program died. That made the dashboard look ready even though there was nowhere
safe to send the code.

Now Instar rebuilds the live part of every unfinished sign-in during startup and
puts the fresh public link or code back onto the saved card. If someone submits
an old code after the live window disappeared, Instar refuses to type it,
creates a fresh sign-in when the account still needs one, and says clearly that
the old flow expired and the replacement is ready.

This matters for safety as well as clarity. Typing a stale authentication code
into a dead program could put the code into an ordinary shell prompt instead.
The new flow checks the live window first and treats its absence as a lifecycle
event, not as permission to keep trying delivery. If a replacement cannot be
created honestly, the dashboard says the sign-in expired and offers the normal
fresh-start action. It never turns that case into a vague server error or claims
that a replacement exists when it does not.
