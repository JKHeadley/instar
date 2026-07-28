# Threadline Single-Store Collapse (Phase 2a) — Plain-English Overview

## What this is

The tidy-up I flagged when Phase 1 shipped. Phase 1 made one clean "conversation
record," but it couldn't fully retire the old record-keeping file yet, because of a
real-world snag. This finishes that.

## The snag, in plain terms

The new record keeps its data **in memory** for speed. The catch: **two different
programs** write thread data — the main server and a little messaging-tools helper.
Two programs can't each hold their own in-memory copy of the same file; they'd
overwrite each other and lose data. So Phase 1 left the old file as a second store.

## How I almost over-built it (and what the review caught)

My first plan was to make the server the only writer and have the helper "ask the
server" over a local web request. A two-reviewer pass against the real code shot
three holes in that:
1. The thing I planned to also convert is actually **dead code** — nothing uses it.
   So that work was pointless.
2. The web requests I'd add would have been **wide open** — that family of routes
   skips the password check, so I'd have shipped an unlocked door.
3. It was a lot of new machinery just to replace **one** "delete this thread" call.

So I changed the approach to the reviewers' simpler idea.

## The fix (revised)

Give the conversation record the same safe-sharing trick the old file already used:
**read the file, make the change only if nobody else changed it first, and save by
swapping the file in one atomic step.** Add a version stamp so that if two writers
collide, the loser just re-reads and retries instead of overwriting. That makes it
safe for both programs to write — no new web requests, no unlocked door, nothing
to break when the server restarts. Then the old file becomes a thin view onto the
new record (every existing piece of code keeps working), and the old file stops
being written.

One careful detail the review flagged: when the helper saves resume info, it must
**merge** into the record, not overwrite it — otherwise it could wipe the loop
counter. The spec now requires that.

## Why it's safe

One file, one safe-sharing rule, atomic saves. The old file is kept (but no longer
written) for one release so we can roll back instantly. Full test suite **plus** the
live test-on-a-real-agent gate before it ships.

## What you're deciding

Just whether to approve building this revised version. It's the foundation the
bigger Phase 2 ("an inbox you drain deliberately") needs.

## What's still after this (tracked)

- **Phase 2b (CMT-493):** the inbox/deliberate-drain reply model + agent-conversations
  inbox + scaling + stranger identity/reputation checks. Built on top of this.
