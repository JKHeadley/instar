# What this PR does — in plain English

## The problem

When you install instar into a project directory (like running
`npx instar setup --framework codex-cli` inside a folder), instar
sprinkles files around: a `.instar/` config folder, a `.claude/` or
`.codex/` folder full of hooks and skills, an `.mcp.json`, sometimes
a top-level `CLAUDE.md` or `AGENTS.md`, plus things you can't see —
a background server in tmux, an auto-start entry that brings the
server back at login, an entry in the global agent registry, and a
secret backup.

If you want to test installing instar a few different ways in a
row — install, uninstall, install again — there's no clean "undo
install" command. You have to remember every place instar wrote
something and `rm -rf` it manually. Easy to miss something. Easy
to leave a tmux session running. Easy to leave the launchd plist
in place so the server respawns later.

## The fix

A new flag on the existing `nuke` command:

```
instar nuke --here
```

Run it inside a project directory and it removes the whole install
— files on disk, tmux session, auto-start, registry entry, all in
one shot. The standalone form (`instar nuke <name>`) still works
exactly the same; this just adds a project-local mode.

## What about pre-existing CLAUDE.md / AGENTS.md?

Good question — these are the only files where instar might step on
something you already had. The rule:

- Tracked by git and unchanged → was yours before the install, kept.
- Tracked by git but modified → instar edited it, restored to your
  committed version.
- Not tracked by git → instar created it, deleted.

So if you `git clone` a repo that already has a `CLAUDE.md`, then
install instar, then nuke — your `CLAUDE.md` comes back. If you
`git clone` an empty repo (like instar-codey today), nothing was
there before, so everything instar wrote gets cleaned up.

## What it won't do

- Won't run inside the instar source repo (the place where instar
  itself is developed). The command checks `package.json` and refuses
  if it looks like the source.
- Won't run if there's no `.instar/config.json` — nothing to nuke.
- Won't run without confirmation unless you pass `--yes`.

## Why now

Justin is testing install/uninstall/reinstall on a fresh clone of
`instar-codey` to verify the Codex-only install path. Without this
command, every cycle requires a manual multi-path teardown and risks
leaving a tmux server running. With this command, the loop is one
line each direction.

## What it doesn't change

Standalone form, all its flags, and all its behavior — untouched.
This is purely additive. If you've never used `--here`, nothing in
your existing workflow changes.
