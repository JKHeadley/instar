# Duplicate-Build Guard — plain-English overview

## What this is

Sometimes the agent (or two of its sessions running at once) starts building a feature that is *already being built* somewhere else — under a different name/ticket — and nobody notices until the two collide at the very end. That actually happened on 2026-07-12: a whole session was spent building something that had already merged. This is a small tool that catches that collision **at the start of a build, before the work is wasted**, instead of at the end.

## How it works

Before the agent starts building from a spec, the tool looks at what the spec says it's going to add (new files, new decision points, the feature's name) and asks three "is anyone else on this right now?" questions:

1. **Is another session on THIS machine already building the same thing?** (The tool leaves a little "I'm building X" note on disk when a build starts, and checks for a matching note from a sibling session. This is the exact shape of the original accident — two sessions on one computer.)
2. **Is there an open pull request that's adding the same thing?**
3. **Did a pull request merge the same thing very recently** (while this build was underway)?

It also does a fuzzy "does this sound like the same feature?" check so a simple rename doesn't fool it.

## What's new vs. the first draft

The first draft had two fatal flaws the review caught: it checked whether the work was "already finished on main" — but in the real accident the work was being *created inside* the other pull request, so that check would have said "all clear." And its only enforceable layer ran at push time — after the whole build was already done. So the fix: (1) look for work **in flight**, not just work already finished; (2) make the early, build-start check **structural** — the agent has to write down "I checked for duplicates, here's why I'm proceeding" in the build record, and the commit is refused without it. It's no longer something the agent can forget to do.

## The safeguards, in plain terms

- **It never blocks your `git push`.** It's a signal, not a boss. The teeth are that the agent must *record* that it looked — not that a machine hard-stops a human's action.
- **It only speaks up loudly when it's confident.** Common false alarms (a filename that happens to overlap) stay a quiet note, so the agent never learns to ignore it.
- **If it breaks, it gets out of the way.** Any error, timeout, or missing tool means "proceed" — a broken guard must never wedge a build or a push.
- **It can't be tricked into leaking secrets or running commands.** All the git/GitHub calls are locked down (no shell string-building, no reading arbitrary files), because a spec's text is untrusted input.
- **Honest about what it can and can't see:** two builds on the *same* computer are caught by the on-disk note; two builds on *different* computers are caught once one of them opens a pull request.

## What you'd decide

Nothing to decide right now — the sensible defaults are baked in (warn, never block; record the check in the build trail; fail open on errors). It ships behind a flag and off-switch, and can be turned off with one setting if it ever gets in the way.
