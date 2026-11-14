# The worktree command works from a normal instar checkout again — plain-English overview

## What this change is

`instar worktree create` makes a separate working copy of the instar code for one piece of work, with its own branch, so several changes can be in progress at once without stepping on each other. It refused to work from this machine's normal copy of instar, for two separate reasons.

First, it only accepted copies of the code whose source address was `instar-ai/instar`. The code actually lives at `JKHeadley/instar`, and `instar-ai/instar` doesn't exist any more, so unless someone had added the right address to a settings file, the command refused every real copy. It now accepts the real address too.

Second, once past that, it tried to switch on the commit safety check in the new copy before giving the new copy access to the installed tools, including the one that switches the check on. So it always failed with "husky: not found". It now gives access to the tools first, then switches the check on. It still refuses to hand back a copy whose commit check isn't working.

## Safeguards

- The command still only accepts the instar repository, by its exact address.
- A new copy is still never returned without its commit check switched on.
- A new test reproduces the real failure: it fails without the fix and passes with it.

## What a reader needs to decide

Nothing; it makes the standard command usable again.
