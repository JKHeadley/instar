# OrphanedWorkSentinel — ELI16

## The problem, in one story

Tonight a background "build session" was spawned to do a job in its own copy of the codebase (a *worktree*). It edited a bunch of files, kicked off its tests, and said "standing by for the tests to finish." But that kind of session can't actually wait around — the moment it stops typing, it ends. So it died with all of its work **uncommitted** and no pull request opened. The edits were sitting right there on disk, but **nothing and nobody knew**, so they sat invisible for hours while the user waited.

There's already a system that rescues *promises* — if the agent said "I'll get back to you" and registered that promise, a watcher revives it when the session dies (the PromiseBeacon escalation ladder). But that only works when something was **registered**. Tonight nothing was registered for the code itself — it was just files in a folder. So the rescue system had nothing to act on.

## What this adds

The **OrphanedWorkSentinel** is a safety net that needs *nothing* registered. It looks at the actual folders on disk. Every few minutes it asks, for each of the agent's worktrees:

1. Does this worktree have **uncommitted changes** (real work)?
2. Is the session that was working in it **gone** (no live process, no lock)?
3. Has it been **quiet for a while** (so we don't grab work that's just paused for a second)?

If all three are true, the work is **orphaned** — stranded by a dead session. The sentinel then:

- **records** it durably (so there's an audit trail), and
- raises **one calm notice** ("a build died here with uncommitted changes — open the worktree to finish it, or throw it away").

Optionally (off by default) it can also write a **preservation patch** — a copy of the changes saved to a safe spot — as extra insurance. That copy is made by *reading* the changes only; it never touches or deletes the real work.

## Why it's safe to leave running

It only ever **reads and reports**. It never deletes anything, never blocks a message, never spends money, and never reaches out to the internet. It's the exact opposite of the worktree *reaper* (which cleans up finished, already-merged folders): this one only cares about folders the reaper deliberately leaves alone — the ones with unfinished work in them.

It ships **dark on the fleet** and **live on the development agent** (the dogfooding ground), which is the standard way new infrastructure is proven before it's turned on everywhere. You can see what it sees at any time with `GET /orphaned-work`.

## The one-line lesson

A promise that depends on a single session staying alive is a wish; work that depends on a single session committing it is the same wish. This makes "the session died before it saved its work" a **detected, surfaced** event instead of a silent loss.

This is the *detection* layer. The complementary *prevention* layer — a commit-or-surface discipline so a session can't yield while "standing by for tests" with work still uncommitted — is tracked as a follow-up; together they close both ends of the same failure class.
