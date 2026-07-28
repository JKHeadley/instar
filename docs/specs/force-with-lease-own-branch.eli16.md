# ELI16 — The safety guard now lets you safely update your own PR branch

## What this is, in plain English

Instar agents have a safety guard that watches the commands they run and blocks
dangerous ones. One thing it blocks is "force-pushing" to git — overwriting what's
on the server with what's on your machine. That's usually risky, because it can
erase someone else's work.

## The problem

There are actually two kinds of force-push:

- `git push --force` — the blunt one. It overwrites the server no matter what.
  This one IS risky and should stay blocked.
- `git push --force-with-lease` — the careful one. It checks first: "has the server
  changed since I last looked?" If yes, it refuses and warns you. If no, it safely
  updates. This is the normal, expected way to update your OWN pull-request branch
  after you've cleaned up your commits (a "rebase" or "amend").

The guard was checking for the text "git push --force" — and because
"--force-with-lease" literally *contains* "--force", the careful one got caught in
the same net as the blunt one. So an agent fixing up its own PR would get blocked
doing something completely safe. That actually happened to Codey mid-task.

## What's new

The guard now recognizes the careful form. If the command is
`--force-with-lease` AND it's not aimed at a protected branch (`main`, `master`,
`develop`, or a release branch), it's allowed. Everything else stays exactly as
strict as before:

- The blunt `git push --force` / `git push -f` → still blocked.
- `--force-with-lease` aimed at `main` (or another protected branch) → still blocked.
- All the other dangerous commands (wiping files, dropping database tables, hard
  resets) → still blocked.

## Why it's safe

Two reasons:

1. `--force-with-lease` cannot silently clobber someone else's work — it stops and
   warns if the server moved underneath you. That's its whole point.
2. We only allow it for feature/PR branches, never for shared branches like `main`.
   And even if someone tried the one weird edge case (force-pushing main without
   naming it), they're stopped twice over: agents always work in separate
   feature-branch folders (never directly on main), and the server itself rejects
   force-pushes to main.

It's a small, narrow loosening — it removes a false alarm without removing any
real protection. Proven with 10 tests covering both the allowed case and every
still-blocked case, and the existing guard tests all still pass.
