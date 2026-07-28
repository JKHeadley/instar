# Why the agent servers were running hot (and the one-line-idea fix)

## The one-sentence version
Every few moments, each agent's server asked "what sessions exist?" — and to answer, it opened and re-read **every** session file off the disk, **from scratch, every single time**. Many watchers asking that many times a second = the disk-reading never stopped, and the server's engine ran hot. The fix: remember the answer for one second.

## The library analogy
Imagine a librarian who, every time *anyone* asks "how many books are checked out?", walks the entire building, opens every drawer, and re-counts from zero. Now imagine five assistants each asking that question several times a second. The librarian never sits down — exhausted, sweating, accomplishing nothing new, because the answer barely changes second to second.

The fix is obvious once you see it: **count once, write the number on a sticky note, and reuse it for the next second.** When a book is actually checked out or returned, tear up the note and re-count. That's it.

## What was actually happening
- `listSessions()` did: list the folder → open every `.json` file → parse each one. No memory of the last answer.
- The session-reaper and several watchdogs each call it on every tick (many times a second between them).
- So it was: (number of sessions) × (number of watchers) × (ticks per second) disk reads — constantly. A CPU profiler showed **~30% of the server's entire CPU was literally re-reading those files**.
- This is why it was everywhere (every agent), and why **restarting a hot server never helped** — the re-reading just started over.

## The fix
- Remember the session list for **1 second** (a tiny cache).
- All the watchers asking within that second share **one** read instead of dozens.
- The instant a session is created or removed, **throw the note away** so the next answer is fresh — no stale views, spawns and shutdowns show up immediately.
- Hand out **copies** so a reader can't accidentally scribble on the shared note.

That collapses the constant disk-churn to about one read per second, and the agent servers idle cool again.

## The safety rails
1. **No behavior change** — same answers, just not re-derived from scratch every time.
2. **Writes are instant** — a new or removed session is visible on the very next call (the note is torn up on every write).
3. **Worst-case staleness is 1 second**, and only for changes made by a *different* machine — which the reaper and scheduler already tolerate.
4. **Backed by tests** — cache-hit, cache-expiry, instant-invalidation-on-write, filtering, and copy-safety all covered; the existing 71 StateManager tests + 255 dependent tests stay green.

## Why it matters
This was the real, systemic reason the machine load kept climbing and bouncing servers didn't stick. One small cache fixes it for every agent at once.

---

**Rendered (verified HTTP 200):** https://echo.dawn-tunnel.dev/view/c4f223db-0376-4e74-9cec-362cbea16c9d?sig=296ffb5a0f90e907a4fe0637dd21265c6fe511c7eccb2507fb66566087d1105c
