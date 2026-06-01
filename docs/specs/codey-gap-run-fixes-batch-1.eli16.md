# Codey gap-run fixes, batch 1 — Plain-English Overview

> The one-line version: Codey (a codex agent) found and fixed two real bugs during an autonomous run but couldn't commit them himself, so Echo reviewed and is shipping the two clean ones — a "promise tracker" that was marking promises done before they happened, and a health check that cried "Telegram is broken" when it wasn't.

## The problem in one breath

When you experiment with a codex-based agent on a long autonomous task, it can find
genuine bugs and even fix them — but it can't get its fixes through the safety gate
that requires a converged spec and your approval. Echo (the agent that builds Instar)
has that path. So Echo is landing the verified ones, the way a mentor lands a
mentee's good work.

## What already exists

- **The promise tracker** — when an agent says "I'll report back in 20 minutes," it
  opens a tracked commitment so the follow-through survives restarts. A background
  "beacon" nudges it until it's actually done.
- **Health checks** — the agent runs little probes that report whether things like
  Telegram are working, so problems surface early.

## What this adds

Two fixes Codey found:

1. **The promise tracker was marking beacon-backed promises "done" almost immediately**
   — seconds after they were opened, before the beacon ever nudged once. That quietly
   defeated the whole point of opening a promise. Now a beacon-backed promise stays
   open until the agent explicitly says it delivered.

2. **A health check was reporting "Telegram broken" when it was fine.** In one of
   Instar's normal modes, a separate helper process does the Telegram listening and the
   main server only sends. The health check didn't know about that mode and saw "not
   listening = broken." Now it recognizes the helper-owns-listening mode and reports
   healthy.

## The safeguards

**Neither fix forces anything.** The promise fix only keeps a promise open longer (it
never force-marks it done). The health fix only turns a false alarm into a pass when
the helper process is demonstrably doing the listening.

**No regression.** Promises that aren't beacon-backed still resolve the way they did.
The health check behaves exactly as before in every other mode. Both are covered by tests.

## What ships when

One small PR with both fixes. Three other fixes Codey staged (about how script jobs
run and how some scheduler entries are loaded) need more careful adaptation to the
current code plus an upgrade-migration, so they're being handled separately rather
than rushed.
