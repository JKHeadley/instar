# Dynamic MCP — the pure decision cores (ELI16 overview)

## What's the problem?

An MCP server is a helper program your AI session can use — for example,
Playwright runs a whole Chromium web browser so the agent can click around web
pages. These helpers are heavy: a browser engine eats a lot of memory and
spawns many processes. The agent decides which helpers to load by reading a
file (`.mcp.json`) **once, when the session starts**. After that the set is
fixed — there's no way to add or drop a helper without restarting the session.

The trouble: most of the time those heavy helpers just sit there idle, doing
nothing but holding memory and process slots. On 2026-06-26 the machine actually
ran out of those slots and the whole computer crashed (a kernel panic). A big
share of the wasted weight was idle MCP helpers stacked across many sessions.

## What did the operator ask for?

"Load an MCP helper only when a session actually needs it, and let it go when
it's been idle. Playwright can stay loaded because we use it a lot; everything
else should come and go on demand." And crucially: **we can't know up front what
a conversation will need, so we must be able to change the set mid-conversation —
even if that means a quick restart.**

## What does THIS change add?

Just the **thinking part** — the small, pure pieces of logic that decide *what
the new helper set should be*. No restarting, no killing, no file-writing yet —
those come next, wired on top of these cores. Splitting the decision out means we
can test every branch in isolation, which matters because getting it wrong could
yank a tool out from under a working session.

Two cores:

1. **`dynamicMcpConfig`** — given the current set of loaded helpers and a request
   ("load Playwright" / "drop Playwright"), it returns the new set. It refuses to
   "load" a helper that isn't even defined, and it does nothing if you ask to drop
   one that isn't loaded. It also computes the lean *starting* set when an agent
   opts into trimming.

2. **`mcpIdleLiveOffload`** — decides *whether* an idle heavy helper under a
   still-running session is safe to drop. The golden rule: if the session is — or
   even *might* be — using its tools right now, **keep the helper**. Any doubt at
   all means keep. Only a heavy helper that has been provably idle for a long time
   (about 30 minutes) becomes a candidate.

## Why is this safe to ship now?

It's **off by default** (dark) and it doesn't *do* anything yet — it only
computes answers. Nothing restarts or dies. When we later wire the "act on the
decision" part, dropping a helper just means restarting the session with a
smaller helper list; the old browser process is cleaned up the normal way (as a
leftover of the old session), so we never have to reach in and kill a live
session's helper directly. That keeps the existing safety rule — "never touch a
running session's processes" — completely intact.
