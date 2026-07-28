# Plain-English overview: stop "restarting" a session that's actually working

## What's broken (in one breath)

You text your agent. Instead of replying, it says something like "Session
respawned / starting up…" and your message just vanishes — you have to open the
dashboard and type there to actually reach it. The session was never dead. It was
busy *thinking*.

## Why it happens

When the agent's "working memory" gets compacted, a safety system
(`CompactionSentinel`) tries to wake the session back up: it pokes the session
with a "re-orient yourself and continue" prompt, then waits ~25 seconds and
checks whether the session wrote anything new to its transcript file. If nothing
new was written, it assumes the poke didn't land and **pokes again**. And again.

Here's the trap: when Claude is doing a long *think* on a big conversation (which
is exactly what happens right after it resumes a nearly-full transcript), it
writes **nothing** to the transcript file until the thought finishes — which can
take longer than 25 seconds. So a healthy, hard-working session looks "stuck" to
the watchdog. Every re-poke shoves another big "re-orient" message into the input
box, piling on top of *your* actual message. Your message gets buried, and all
you see is the agent saying it's restarting. On Echo's own logs we caught this
firing three times in under a minute against a session that was perfectly alive.

## What already existed

The codebase already knows how to tell when Claude is mid-turn: Claude Code shows
a little footer line like `esc to interrupt` / `… tokens · esc` *only* while it's
actively working. A different sentinel (`StuckInputSentinel`) already uses that
footer to avoid pressing Enter at the wrong time. We're reusing that exact,
proven signal.

## What's new

The recovery watchdog now **checks whether the session is actively working before
it re-pokes**:

- If the session shows the "I'm mid-turn" footer (or has a tool actually
  running), the watchdog **waits instead of re-poking**. If the work finishes and
  the session writes to its transcript on its own, that counts as recovered —
  with zero pokes, so your message is never buried.
- If the session is genuinely idle (no footer, no running tool) — or wedged and
  fast-failing — nothing changes: it gets recovered exactly like before.
- There's a safety cap (`maxWorkingDefers`, default 10) so a session whose
  "working" footer is somehow stuck forever still eventually gets a real poke.

A second, smaller fix in the same spirit: the "your typed message is stuck at the
prompt, let me press Enter for you" helper now also holds off while the session
is mid-turn — that's what was spamming the `Injection stuck — Auto-recovering`
warnings on every message to a busy session.

## What you need to decide

Nothing to configure. It defaults ON because it only changes behavior for a
session that is *actively working* — the precise case the old code was wrong
about. An idle or wedged session recovers just as before, so the fix can't make
recovery worse; it can only stop the false "restarting" loop. The single escape
hatch, if it were ever needed, is setting `maxWorkingDefers: 0`, which restores
the old always-re-poke behavior.

## How you'll know it worked

You text the agent while it's busy on a long turn, and instead of "Session
restarting…" you simply get your answer once the turn lands — no dashboard
detour, no buried message.
