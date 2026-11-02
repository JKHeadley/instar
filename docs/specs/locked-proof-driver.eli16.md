# The scripts for the real-Mac proof of the locked-screen feature (ELI16)

## What this is

Instar can open a locked Mac remotely and is supposed to make sure the Mac always locks itself again afterwards, whatever goes wrong. The feature stays switched off until that promise has been tested on a real Mac: about 38 nasty situations, like crashing the server at the worst moment, pulling the connection, or pressing Stop a split second before or after the password goes in. This change adds the scripts that run those tests. It does not run them.

## What the scripts do

- A setup script creates a separate, empty test account on the Mac. It invents a random throwaway password, saves it in the agent's password vault first, then creates the account using that password without the password ever appearing on a command line or in a log. The account is set up so macOS does not demand a new password at first login.
- A staging script installs the special test build of Instar (from the previous change) inside that test account, with two small test agents, auto-update off.
- The driver runs the tests one by one. For each test it opens a remote-desktop session through the real web page, types the test account's password through it (the agent does the typing, so you do not have to type it about 30 times), does the nasty thing at the right moment, and records what happened: whether the Mac ended locked, what the relock record says, and whether any password was submitted after it should have stopped. It writes a pass or fail for each test with the reason.
- A cleanup script deletes the test account afterwards.

## What the person still does

Only what software cannot: in the test account, allow the helper's two macOS permissions (Screen Recording and Accessibility) once, and a few actions at the Mac itself during the run (unlock it locally a few times, switch to your own account and back once, log the test account back in once).

## Safeguards

- Nothing touches the Mac unless the script is run with `--execute`; otherwise it only prints its plan.
- The driver refuses to act on anything except the test account running the special test build.
- The password lives only in the vault (and Bitwarden) and in the driver's memory, never in output, results, logs or any command line. The setup refuses to run if the vault helper would put it on a command line.
- The driver only ever signals processes that belong to the test account, checks that right before each signal, and always resumes and relocks the test account after each test, even if the test itself crashes.
- A check the driver cannot measure yet counts as a failure, never as a pass.
- Resetting the daily try counter is refused while a relock is in progress, and every reset is logged.

## What you need to decide

Nothing now. The test sitting itself needs a time you pick.
