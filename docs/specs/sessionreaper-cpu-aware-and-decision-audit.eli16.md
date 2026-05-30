# ELI16 — SessionReaper: CPU-aware pressure + decision audit

## What this is, in plain English

Your machine runs a lot of AI agents at once. Each one, even when it's just
sitting there waiting, keeps a little engine running that uses a slice of the
computer. There's a janitor process — the "SessionReaper" — whose job is to
clean up agent sessions that are genuinely doing nothing, but ONLY when the
machine is actually struggling. It's extremely careful: it never shuts down a
session that might be working. It looks for hard proof a session is idle (the
screen is parked at a ready prompt, nothing is running, nothing is being written)
before it ever touches anything.

## What already exists

The janitor already works and is already cautious. The problem: it decided "is
the machine struggling?" by looking at **memory only**. But on a busy box the
thing that actually hurts is the **CPU** being overloaded — and you can have
plenty of free memory while the CPU is pinned. So the janitor would sit on its
hands during the exact CPU crunch where cleaning up idle sessions would help.

It also kept no real diary. When it ran in "watch but don't touch" mode it didn't
write down what it was thinking, so you couldn't look back and ask "what were you
considering, and why did you keep that session?"

## What's new

1. **The janitor now feels CPU strain, not just low memory.** It looks at how
   busy the processors are (the load average divided by the number of cores). If
   either memory OR CPU is under strain, it counts as pressure — it uses whichever
   is worse. So a CPU-bound machine finally wakes the janitor up. There are two
   dials (a "moderate" and a "critical" CPU level) you can tune; they have sensible
   defaults, and a brief spike (like a build) won't trigger a cleanup spree because
   the janitor still has to confirm a session is idle several times in a row.

2. **The janitor now keeps a quiet diary.** Every time its decision about a
   session changes ("keeping this — it's active" → "this one's now idle" → "shut
   it down"), it writes one line to a dedicated log file, stamped with why. It only
   writes when the decision *changes*, so a session it's been keeping for days
   shows up once, not thousands of times. You can read the diary through a new
   read-only address. It never pings you — it's there for when you want to look.

## The safeguards, in plain terms

- The careful part is completely unchanged. It still requires proof of idleness
  and still never reaps a working session. CPU-awareness only changes *when* it's
  allowed to consider acting, not *how carefully* it acts.
- It still ships turned OFF by default.
- The diary is silent — no notifications, no alerts, no new chat messages.
- Nothing here can break an existing agent: if the machine can't report CPU info,
  it quietly falls back to the old memory-only behavior.

## What you actually need to decide

Whether the two default CPU dials (moderate at 1.0 load-per-core, critical at 1.5)
feel right for your hardware, or whether you'd rather tune them after watching the
diary for a while. Nothing else requires a decision — it's a careful, additive,
reversible change.
