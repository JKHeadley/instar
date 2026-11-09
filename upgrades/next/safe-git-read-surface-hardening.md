## What Changed

Instar runs every git command through one safety funnel, with a door for commands that only read. Several "read" commands could still write a file or start another program through an option (saving output to a file, adding a remote, setting a config value, opening results in a named program, running a program while listing a remote). The read door now admits only the reading forms it knows for each of those commands; writing forms go to the write door, which has its own protection for Instar's source folder, and program-starting forms are refused everywhere. Settings and environment variables passed with a read are limited to a short list. The helper that picks a door now looks at the real command word, which fixes a hidden bug in `instar wakeup --force`: a commit and push that it claimed to do never ran. That step is removed (it could not be made safe), and the command now says what really happens to the claimed lease.

## What to Tell Your User

Nothing changes in day-to-day use. If you ever force one of your machines to take over as the main one, the message now tells you plainly whether the other machine will hear about it, instead of always saying it was shared.

## Summary of New Capabilities

No new capability. The git safety funnel's read path now refuses option forms that wrote files or ran programs, on new and existing agents.

## Evidence

- Spec: `docs/specs/safe-git-read-surface-hardening.md` (EVO-029), converged in 6 rounds with an external GPT-tier review each round.
- Real-git tests drive each previously-working write or program form through the read surfaces and check nothing was written or run.
