# Resolving the GitHub CLI — plain-English overview

## What this actually is

Our project tracker could not record that a piece of work had been finished. Not "was slow to" —
could not, at all, on this machine.

## Why

When you finish a piece of work in a project, you mark it merged. The tracker does not simply take
your word for that. It goes and checks the pull request itself, confirms it really was merged, and
confirms the merge commit is genuinely in the main line. That is good behaviour and we want to
keep it — an agent claiming its own work is done is precisely the kind of self-report this whole
week has taught us not to trust.

To perform that check it runs the GitHub command-line tool. The server starts automatically at
boot, and programs started that way get a much shorter list of places to look for tools than you
get in a terminal. The GitHub tool was not in that shorter list. So the check could never run, and
every attempt failed with a cryptic "no such file" error.

The result: you could create a project, approve a round, do the work, ship it — and the record
could never be closed. Work went in one end and nothing ever came out the other.

## Why that matters more than it sounds

We found six projects created in a four-day burst in May, all archived in July, none of them ever
completed. That is exactly the shape you would expect from a system where work can be started but
finishing cannot be recorded: the list fills up, nobody can clear it, and eventually someone sweeps
the whole thing away. We have not proven that was the cause, but it is the most plausible
explanation we have.

## What changed

The server now looks for the GitHub tool in the places it is actually installed, rather than
assuming it will be handed the right list. If it genuinely cannot find it, the message now says so
in plain words and names the single setting that fixes it — instead of a raw error that tells you
nothing.

The verification itself is unchanged. If the tool cannot be found, the transition is still
refused. The system does not assume the merge happened just because it could not check.

## The safeguards

- This only finds a path. It has no power to approve or block anything; the existing check keeps
  that authority entirely.
- If it cannot find the tool, the answer is "no" rather than an error — the caller decides what
  that means.
- It follows the same approach we already use for another tool in this codebase, rather than
  inventing a new one.

## What you actually need to decide

Nothing. This restores something that was supposed to work. It reverts completely by undoing one
commit, and there is no stored data that depends on it.

One thing worth knowing: thirteen other places in the codebase call the same tool. Most run in
contexts that get the normal list of locations and are not known to be affected, so they are
deliberately left alone rather than changed blindly — assessing them is tracked separately.
