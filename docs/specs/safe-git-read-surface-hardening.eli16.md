# Making "read-only" git commands really read-only — Plain-English Overview

> The one-line version: Instar's git safety funnel has a door for commands that only read, but several commands that go through that door can still write files or start other programs; this change makes the read door admit only the reading forms it knows, fixes a dispatcher that looked at the wrong word, and removes a lease-sharing step that has silently never run and could not safely be switched on.

## The problem in one breath

Every git command Instar runs goes through one safety funnel. The funnel has one table saying which commands only read. But the table judged mostly by the command's name, and several "reading" commands have options that write: save output to a file, add a remote, set a config value, create git objects or refs, rewrite a file in place, write patch files. Several, including the search and remote-listing commands, can start any program you name, a few open an editor or a help viewer, and reviewers found sneaky ways to do it: a hidden alias, a shortened option name, and hiding the option behind a "--" that git reads as a value. Separately, the helper that picks the right door looked at the first word of the command, so "turn off signing, then commit" went to the wrong door and was silently refused. That is why one step of taking over as the main machine has never happened, while the screen said it had.

## What already exists

- **The funnel**, with a door for writes and a door for reads, one table, and one function that classifies every command.
- **Argument checks** for seven commands that have both a reading and a writing form. Some looked at too little of the command line.
- **An opt-out** that lets a few reading commands run on Instar's own source folder. It went by command name only, so a writing form of one of those commands could slip past the source-folder protection.
- **A hardening list** the feedback-fixing pipeline puts in front of its git commands.
- **The server's lease code**, which pulls the latest shared state, checks nobody got there first, and only then commits and pushes.

## What this changes

- **The read door admits only reading forms it knows.** For each risky command there is a short list of options known to only read. Anything else, including shortened names, bundled short flags and unknown future options, is treated as a write or refused. This is the change that defeats all three sneaky tricks at once.
- **Writing forms are writes.** They are refused at the read door and still allowed at the write door, which has the source-folder protection.
- **Program-starting forms are refused everywhere.** Nothing in Instar uses them.
- **The source-folder opt-out is for reads only** (and the one data-download command it was written for).
- **Settings and environment variables passed with a read are limited.** Settings must be one of the hardening list's "switch this off" values. Environment variables a caller adds or changes must be on a short list (language and prompt settings, plus two harmless git switches); anything else, such as one that points git at a different config file or names a program, is refused.
- **The door-picker reads the real command word.**
- **One dead call is removed**, an old one-time script is deleted, and the shell-script check learns the writing commands it was missing.

## The lease step

When you force a machine to become the main one, Instar records the takeover in the machine registry on that machine. The old code also tried to commit and push it straight away, but because of the door-picker bug that never once ran. Reviewers checked what would happen if it ran now, and found it would commit on top of stale data, and that even routing it through the server's careful lease code can leave the registry file broken in exactly the race it exists for. So it is removed rather than switched on, and nothing changes in practice.

The screen now says what really happens next, instead of the false "pushed". If this agent keeps its lease in git, the server here shares the claim when it starts. If it does not, or if this machine is set only to watch the lease, the screen says plainly that the other machine is not told, and suggests the normal handover while the other machine is reachable. If the check itself fails, the screen says it could not tell, rather than guessing. Reviewers also found two older weaknesses in how the server shares a forced claim; those are reported to be fixed separately.

## What it deliberately does not cover

The promise is exact: nothing Instar passes with a read (arguments, settings, environment) names a program for git to run, apart from two harmless fixed ones (`false` and `cat`) and the helper programs git picks for unusual web addresses, or makes git write anything. git's own refresh of its file-status cache is not counted. Three things are outside it, each written down with the reason: a repository's own settings file, which can name programs and which Instar must never trust from a stranger; the server's own environment, which is the machine's; and the helper programs git uses for unusual web addresses, which are installed on the machine. A test also watches for new git versions adding options to the reading commands, and fails with the name of the option to review.

## The safeguards

- **Nothing Instar uses today becomes refused.** Every caller of the affected commands was checked by the author and three reviewers.
- **Every gap was measured before the fix**, and the new tests are run against the current code first to show they fail there.
- **The lease change is tested** against a real repository with a real remote: the claim is saved, nothing is committed or pushed, and the screen no longer says "pushed".
- **Easy to undo.** No stored data, no setting, no migration. Undoing it is reverting one commit.

## What ships when

Everything ships together in one release, with no switch. The development agent watches its audit log for the first week for any refusal that came from code that only meant to read.
