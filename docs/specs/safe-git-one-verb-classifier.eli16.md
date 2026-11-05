# One list of git commands for the git safety funnel — Plain-English Overview

> The one-line version: the part of Instar that runs git commands keeps two separate lists of allowed commands, some commands are on neither, and each list then blames the other; this change replaces them with one list and one clear refusal.

## The problem in one breath

Instar code is only allowed to run git through one safety funnel. The funnel has a door for commands that change things and a door for commands that only read. Each door has its own list. A command on neither list is turned away at both doors, and each door says "use the other door". One such command, the one that asks "is this file ignored?", only reads. A test reached for it, was refused at both doors, and had to find another way.

## What already exists

- **The funnel.** Every git command from Instar code goes through it. It checks the command, protects Instar's own source folder, cleans the environment, and writes an audit line.
- **A list of commands that change things** (36 of them) and **a list of commands that only read** (37 of them). Six commands are on both lists because they have a reading form and a changing form, and the funnel looks at the arguments to tell which.
- **A check in the build** that fails if any code runs git without the funnel.

Git has about 170 commands. Most are on neither list, and most should stay refused.

## What this adds

One table that names every allowed command once and says whether it reads, changes things, or does either depending on its arguments. Both doors read that table. Nothing else decides.

- A command that is not in the table gets the same refusal at every door: "this command is not classified, and adding one is a reviewed change". It no longer points at another door.
- The "is this file ignored?" command is added as a read, including on Instar's own source folder when the caller asks for that. It writes nothing. Like `git status`, it can still trigger a program that a repository's own settings name, so it adds no new kind of risk, and that older risk is on the tracked list.
- The command that manages git's own history log was accepted by the changing door but mislabelled in the lists. It is now labelled correctly, so its non-reading forms go through the changing door everywhere. Nothing in Instar calls it.

## The new pieces

- **The table.** A fixed list in the code. It is not a setting and cannot be changed while Instar runs.
- **The classifier.** A small function that takes a command and its arguments and answers "reads", "changes things" or "not classified". All the doors call it.

## The safeguards

**Nothing that was refused for a good reason becomes allowed.** Only one command is added. Other read-looking commands were left out on purpose, because some can write a file through an option and some can run an outside program.

**The two lists cannot drift apart again.** The old lists still exist for the code that imports them, but they are now computed from the table. Tests check the classifier's answer for every command in the table and every other git command on the machine, compare the lists against a frozen copy of today's, and drive real commands through each door.

**The test was shown to fail first.** Before the fix, the new tests fail on the current code. That is recorded in the pull request, so a test that could never fail is not counted as proof.

**Easy to undo.** There is no stored data, no setting and no migration. Undoing it is reverting one commit.

## What ships when

One pull request: the table, the classifier, the tests and this write-up. A separate, already recorded item (EVO-029) covers five related problems in the same file that change which git commands actually run; those are not part of this. Review found that one of them is bigger than recorded: some commands the funnel calls "read" can really write, for example adding a remote when the arguments are arranged a certain way. That is true today, this change does not make it worse, and the EVO-029 record now names those cases.

## What the reader needs to decide

Nothing new. The proposal was already approved. The one judgment call worth knowing about is that only a single command was added, and the others wait for someone to ask for them.
