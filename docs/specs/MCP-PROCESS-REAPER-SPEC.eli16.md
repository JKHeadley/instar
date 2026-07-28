# MCP-Process Reaper — the plain-English version

## What's the problem?

When an agent session runs, it starts little helper programs called **MCP servers**
(for example, the Playwright browser helper or the Fathom bridge). When the
session ends, those helpers are *supposed* to die with it — but they don't.
Killing the session's main program doesn't automatically kill its helpers, so the
helpers get "adopted" by the operating system and keep running. Over days, they
pile up. The fleet had about **80 of these stray helpers**, some 5 days old, all
quietly eating CPU. That's the "host load" problem.

## What already exists?

Instar already has reapers (cleanup robots): one for stale sessions, one for stale
git worktrees. But none of them clean up these leaked **MCP helper** processes —
they clean the session, not the session's leftover helpers.

## What's new?

A new cleanup robot, the **MCP-Process Reaper**. Once per pass it looks at every
MCP helper process and asks: *who owns you?* It follows the family tree upward to
find the tmux session the helper belongs to.

- If the owner is **alive and tracked** → leave it alone (even if it's old — a
  long-running session is allowed to own old helpers).
- If the owner is **someone else's** (not an instar session) → never touch it.
- If the owner is a **dead/stale instar session**, or the helper has **no owner at
  all** (orphaned), and it's **old** → that's a leak; reap it.

## How safe is it?

Very deliberately safe:
- It ships **off**, and even when on it starts in **dry-run** — it writes down what
  it *would* kill but kills nothing — so you can review first at `GET /processes/mcp-reaper`.
- It only ever matches **three exact helper types**, never a broad "any node program" match.
- It **never** kills a live session's helpers, and **never** touches a non-instar
  (your own) session's processes.
- Every decision is written to an audit log.
- On echo (the dev agent) it runs but stays in dry-run, so we can watch it judge the
  real ~80 leaks before anyone turns the actual killing on.

## What do you need to decide?

Nothing to decide to ship it — it ships dark + dry-run, so merging changes no live
behavior. The only later decision is *when* to flip `dryRun:false` on echo to let it
actually reclaim the leaks, after you've looked at a dry-run pass.
