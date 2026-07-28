# Seed git hooks into fresh worktrees — Plain-English Overview

> The one-line version: when I make a fresh, isolated copy of the code to work in, that copy was silently skipping the commit/push safety checks — this makes those checks work from the very first commit.

## The problem in one breath

When an instar dev agent starts a task, it makes a private, isolated copy of the codebase to work in (a git "worktree" or "clone") so parallel work can't collide. Those copies were quietly missing one small generated folder that git needs in order to run the pre-commit and pre-push safety checks. Git didn't complain — it just ran no checks at all. So every fresh working copy was committing and pushing with the guardrails silently switched off, until someone happened to run `npm install` in it.

## What already exists

- **Worktree isolation** — every dev task gets its own private checkout so two tasks never overwrite each other. This is working and unchanged.
- **The instar-dev gates** — pre-commit and pre-push checks that refuse commits/pushes which didn't go through the proper process (trace file, side-effects review, passing tests). These are the guardrails that were being skipped.
- **Husky** — the tool that wires those checks into git. It stores its wiring in a folder called `.husky/_` that is *generated* (not stored in git) and only appears after `npm install`.
- **`fastCopyDeps`** — the existing step that copies `node_modules` into a fresh worktree so it doesn't have to run a slow install. It copies the dependencies but never regenerated husky's wiring — which is exactly how the wiring went missing.

## What this adds

One small, safe step that runs right after a fresh worktree/clone is created: it looks at where git expects to find its hooks, and if that folder is missing in the new copy but present in the source, it copies it across (and, for clones, also points git at it). That's it — the guardrails are now live from the first commit.

## The new pieces

- **`seedGitHooks`** — a helper that copies the hooks folder into a fresh checkout. What it is NOT allowed to do: it never blocks or slows down making a worktree. If anything is uncertain — no hooks configured, the path looks suspicious, nothing to copy — it quietly does nothing and moves on. It fails toward "let the worktree get created," never toward "stop."

## The safeguards

**Never breaks worktree creation.** Every failure path is a silent skip or a one-line warning; making a worktree can never fail because of this step.

**No copying to weird places.** It refuses any hooks path that would point outside the worktree or the source folder, so a malformed config can't trick it into writing somewhere it shouldn't.

**Does nothing when there's nothing to do.** Repos that don't use this hooks style, or already have the folder, are left exactly as they were — a genuine no-op.

## What ships when

This is a single self-contained fix (one method + its call site + tests). It ships as one Tier-1 PR; there are no phases or follow-on parts.

## What you actually need to decide

Do you approve making fresh dev worktrees seed their git-hooks folder so the commit/push safety checks actually run from the first commit — yes or no?
