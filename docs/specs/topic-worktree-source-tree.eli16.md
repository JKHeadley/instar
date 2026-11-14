# Topic sessions on an agent whose home is the Instar code — plain-English overview

## What was wrong

When a conversation (a Telegram topic) asks for its own working session, Instar first makes a private working copy of the project for that conversation, so two conversations never edit the same files at once. It does this with git: it makes a new branch named after the topic, then a "worktree" (a second folder that checks out that branch).

The agent that develops Instar itself lives in a folder that IS a copy of the Instar code. Instar has a safety guard that refuses risky git operations on the Instar code, because a test once wiped most of the repository by running git against the wrong folder. Making the branch was a separate step, and the guard (correctly) refused it. So every conversation-bound session on that agent failed to start, and its replies could not be sent back to the conversation.

## What changes

When the project is the Instar code, the branch and the working copy are now made in a single git command ("worktree add" with a new-branch option). The guard already has a narrow, reviewed allowance for exactly that command, used by the existing worktree tools. New branches start from the latest shared version of the code (origin/main) instead of whatever branch the home folder happens to be on. If the topic's branch already exists, it is reused.

Two read-only checks on the same path (is there already a working copy here, and where do the commit hooks live) now use the same allowance, so new working copies also get the commit and push checks.

## What does not change

The guard itself is untouched. A plain "make a branch" command against the Instar code is still refused, and the new test checks that. Agents whose project is not the Instar code behave exactly as before.

## What to decide

Nothing. This is a bug fix; reverting the one commit restores the old behavior.
