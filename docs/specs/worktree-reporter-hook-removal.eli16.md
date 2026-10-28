# Claude Code's working-copy feature works again in Instar sessions — plain-English overview

## What this change is

Claude Code can make a separate working copy of a project (a "worktree") so a task can be done without touching the main copy. Some of its helpers use this automatically.

Instar attaches a small reporting script to a list of Claude Code events so it can keep a record of what each session did. Two of those events are "a working copy is being created" and "a working copy is being removed". It turns out that for those two events Claude Code doesn't just notify a script: it hands the whole job to the script, and expects the script to make the copy and say where it put it. Instar's reporting script does neither, so whenever Claude Code tried to make a working copy in an Instar session, it failed.

I confirmed this by trying it: with the reporting script attached, making a working copy failed with Claude Code's own error; with it removed, it worked.

This change stops attaching the reporter to those two events, for new agents and, through the normal update step, for existing ones.

## Safeguards

- Only Instar's own reporter is removed; if an operator attached their own script to those events, it stays.
- Nothing in Instar used those two events: they had always been recorded as "Unknown".
- Running the update twice changes nothing the second time.

## What a reader needs to decide

Nothing; it removes a misconfiguration that broke a Claude Code feature.
