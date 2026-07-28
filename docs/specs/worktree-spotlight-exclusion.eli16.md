# ELI16 — Worktree Spotlight exclusion

## What this is, in plain English

When instar does parallel development, it makes "worktrees" — extra full copies of
the project's source code sitting in a folder on disk. Over time these pile up; on
the dev machine there were over 120 of them.

macOS has a search feature, Spotlight, plus a media-scanning helper called
mediaanalysisd. They constantly crawl new files on disk to make them searchable.
To them, 120 copies of a big source tree look like 120 big piles of new stuff to
scan — over and over. On the machine we measured, that scanning was the single
biggest CPU hog on the whole computer, far bigger than anything the AI agents
themselves were doing. So the computer felt slow for a reason that had nothing to
do with the actual work.

## What already exists

macOS has a built-in, no-special-permission way to say "don't index this folder":
you drop an empty file named `.metadata_never_index` into it. Lots of developer
tools do this to keep Spotlight off their build folders.

## What's new

instar now drops that one little marker file at the top of the worktrees folder.
Spotlight then skips that whole folder and everything inside it. It happens
automatically:
- Every new worktree is covered the moment it's created.
- Agents that already piled up worktrees before this existed get the marker added
  for them automatically when they update.

## The safeguards, in plain terms

- The marker sits at the container folder, not inside each worktree copy, so it
  doesn't show up as a stray file in anyone's source code.
- It's completely safe and reversible — it's just an empty hint file. Delete it
  and indexing comes back.
- On non-Mac machines it does nothing (no harm).
- If for some reason the file can't be written, instar just shrugs and carries on
  exactly as before — it never blocks creating a worktree.

## What you actually need to decide

Nothing. This is automatic, safe, and reversible. On a Mac you should simply notice
lower idle CPU after the update — especially if you've built up a lot of worktrees.
It's the first piece of the broader "use resources responsibly" effort, aimed
specifically at the macOS-caused load.
