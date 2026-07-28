# Explain it like I'm 16: the codex Stop-hook "invalid JSON" fix

## The background

Instar lets an AI agent keep working on a long task across many turns. The trick is a little
script called a "Stop hook" that runs every time the AI tries to stop. If there's still work
to do, the hook says "no, keep going"; if the work is done, the hook says "okay, you can stop."

We recently taught this same hook to work for a second kind of AI — "codex" (the one our
agent Codey runs on) — not just Claude. That's the #28 feature.

## The bug

Here's the catch: Claude and codex listen to the Stop hook differently.

- **Claude** is relaxed about what the hook prints. If the hook prints a friendly note like
  "✅ All done, good work!", Claude just shows it to you and stops. Fine.
- **codex** is strict. It expects the Stop hook to print EITHER nothing OR one specific
  machine-readable line (JSON). If the hook prints a friendly human sentence instead, codex
  throws an error: "invalid stop hook JSON output," and marks the whole Stop hook as FAILED.

Our hook had a few spots where, when a task finished, it printed a friendly "✅ Autonomous
mode: all done" line. That's perfect for Claude — but for codex it's garbage on the wrong
channel, so codex failed the hook every time a codex run finished. We only caught this by
actually running a real task on Codey and watching it happen — our automated test had only
ever checked the "keep going" case, never the "okay, stop" case.

## The fix

Think of a program as having two output channels: channel 1 ("stdout", the official answer)
and channel 2 ("stderr", side notes). codex only reads channel 1 and demands it be clean JSON.

So we added a tiny helper called `emit`. When the hook is talking to **codex**, `emit` sends
all the friendly human messages to channel 2 (side notes), keeping channel 1 spotless for the
one JSON line codex cares about. When the hook is talking to **Claude**, `emit` keeps sending
those messages to channel 1, exactly like before — so nothing changes for Claude.

## Why it's safe

We never changed the actual decision (keep-going vs stop). We only changed WHICH channel the
human-readable note goes out on, and only for codex. The worst that could go wrong is a status
note showing up in the logs instead of on screen — never a wrong decision. And we added a test
that fails if anyone ever prints a non-JSON line to codex's channel again, plus one that
confirms Claude still gets its messages the old way. We also bumped the upgrade marker so every
existing codex agent automatically picks up the fixed hook on its next update.
