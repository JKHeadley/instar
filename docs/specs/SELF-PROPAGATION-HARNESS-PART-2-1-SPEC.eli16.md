# ELI16 — `instar test-as-self` (Part 2.1)

## What broke that led to this

Last week we tried to deploy a copy of "me" onto a second machine over
Telegram to verify cross-machine seamlessness. The deploy was hand-done:
mint a bot, copy files, start things, send a probe, watch logs. Two
things went sideways at once — a Telegram polling conflict and a node
crash — and because the deploy was hand-done, it was hard to tell which
failure was real and which was the operator. We fixed the conflict at
the structural level (the poll-ownership lease, shipped). We shipped a
basic verifier (shipped). But the actual deploy is still hand-done, so
the same kind of confusion will happen the next time.

## What this spec does

Adds one new command: `instar test-as-self`. Run it, and it does all
seven steps of the deploy/verify/teardown loop for you: get a test bot
token (the safe way, never typed in chat), set up a throwaway agent home
that isn't your real one, deploy the current build into it, start it
up, send a real probe message and confirm the throwaway agent replied,
check the crash log for any signs of trouble, and tear it all down. One
button, deterministic, can't touch your real agent or "Bob" (the Mac
mini).

## Why this matters now

PR #428 — the cross-machine seamlessness PR — is sitting at "all green
except a doc-coverage check we fixed this afternoon." The only thing
between it and merge is one live two-machine test. And that test is
exactly the kind of hand-done deploy that bit us last week. Building
this command IS the path to closing PR #428.

## The structural guarantees

A bot token never appears in a command line, in an environment variable,
or in chat — only ever through Secret Drop (in-memory, one-time, 15-min
expiry). The throwaway agent home physically cannot be set to your real
home or to Bob. If the deploy crashes, V8's native crash reporter writes
a structured report we can parse, instead of you trying to reconstruct
what happened from log fragments after the fact.

## What it does NOT do

- It does not run automatically (you choose when to test).
- It does not replace the unit tests for cross-machine seamlessness; it
  backs them up with a real-deploy check.
- It does not touch Bob, ever.

## What I need from you

One of:
- **A)** Greenlight the full version (auto-mint bot + real Telegram
  round-trip + one-button command). About a day's work. Best.
- **B)** Greenlight a smaller version (one-button command but you
  manually verify the Telegram reply). About half a day. PR #428 closes
  sooner but the underlying problem isn't fully fixed.
- **C)** Skip this spec; manually run the two-machine test once and
  close PR #428 the old way; build this command later.

I lean **A** — the whole point of the parent spec was that hand-done
deploys are the failure mode, and (C) re-creates that failure mode for
the exact test we'd run to close PR #428.
