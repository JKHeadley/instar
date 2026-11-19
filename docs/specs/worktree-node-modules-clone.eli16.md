# New worktrees get their own copy-on-write dependencies — Plain-English Overview

> The one-line version: on a Mac, a new worktree gets its own instant, nearly free clone of the shared dependency folder instead of a link to it, so one session reinstalling can no longer break everyone else, and sessions stop needing their own 0.6 GB install.

## The problem in one breath

Every new working copy of the code ("worktree") needs the project's dependency folder, `node_modules`. Today it gets a link to one shared folder. We found that when a session runs a clean install (`npm ci`) inside a worktree whose folder is a link, npm empties the shared folder the link points to, breaking every other worktree using it. Sessions also avoid the shared folder and install their own copy (about 0.64 GB each). On the Mac Studio on 2026-11-17 that was 34 full installs in one day (about 22 GB), part of a disk that lost about 127 GB in 24 hours.

## What already exists

- **Worktree creation** (`instar worktree create`) — makes the checkout, sets the commit identity, links the shared `node_modules`, and turns on the commit hooks.
- **The opt-out** (`--no-share-node-modules`) — no shared folder at all.

## What this adds

On macOS, instead of a link, the worktree gets a copy-on-write clone of the shared folder (the Mac file system's built-in instant copy). The clone is a real folder owned by that worktree: it costs almost no disk until something in it changes, and a clean install there only empties the worktree's own folder. If cloning is not possible (an older or non-Apple file system), it falls back to the link exactly as today. Other systems keep the link.

## The new pieces

- **The clone step** — copies into a temporary folder beside the target and renames it into place only when the copy finished, so a failed copy never leaves a half folder; a leftover temporary folder is removed.
- **A mode setting** (`nodeModulesShareMode`: clone or symlink) — for tests and for anyone who wants the old behavior.

## The safeguards

**Never worse than today.** Any failure falls back to the existing link.

**No new authority.** Nothing is deleted except the temporary folder of a failed clone.

**Measured cost.** About 19 seconds for 16,000 files on a heavily loaded Mac Studio, no measurable disk use.

## What ships when

One change to worktree creation, a CLI message, and tests; it reaches every agent on the next release with no migration.

## What you actually need to decide

Nothing: a Tier-1 change that a revert fully undoes.
