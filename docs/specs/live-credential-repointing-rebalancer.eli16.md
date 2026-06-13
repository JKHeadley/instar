---
title: "Live credential re-pointing — plain-English overview"
slug: "live-credential-repointing-rebalancer"
audience: operator
---

# Using every drop of your subscriptions — without ever touching a screen

## The problem, in one picture

You have five Claude subscription accounts pooled together. Each one's weekly allowance resets
on a clock and **doesn't roll over** — whatever you didn't use just evaporates. So you can be in
a "use it or lose it" spot: one account is about to reset with lots left, while your work is
piled onto a different account. That's wasted allowance. On top of that, when a session gets
close to an account's limit, today the only way to move it is to **restart the session** — heavy,
and it can interrupt work.

## The key realization (the thing that reshaped this whole design)

You pointed out — and I verified with live experiments on the machine — that switching which
account a session uses is **not disruptive at all**. When you run `/login`, every running session
quietly starts pulling from the new account on its very next message, with no restart. I proved
why: Claude re-reads its saved credential on each request. So the right way to rebalance is to
**move the credential, not restart the session.**

That one insight collapsed two separate pieces of work (the rebalancer *and* the "change my
default account without logging in" request) into a single, much lighter feature.

## What this builds

A quiet background "credential dealer." Think of each session's folder as a **seat** that never
moves, and each account's login as a **player** that can change seats. The dealer re-seats the
players based on live usage — exactly like a calm, slow stock-trader:

- **Use-it-or-lose-it:** when an account's weekly window is about to reset with allowance left,
  it gets dealt to a busy seat so the allowance gets spent before it evaporates.
- **Wall-avoidance:** when a seat's account is about to hit its limit, a healthier account is
  dealt in so the session keeps working — no restart, no interruption.
- **Your default account flip:** changing which account "plain `claude`" uses becomes just one
  more re-seat. Zero logins, zero taps, nothing on your screen.

## The promises I'm holding it to

- **Zero user involvement, ever.** After an account is enrolled once, nothing here ever needs you
  to log in, tap a link, or touch a file. (Enrolling a brand-new account is the only time a human
  signs in — that's authentication itself.)
- **Never interrupts work.** Moving a credential takes effect on the next message; no session
  restart, no lost context.
- **Accounts are shared equally across the org** — no per-person walls, as you asked.
- **Ships dark and dry-run-first on me.** It starts OFF for everyone. On my own agent it first
  runs in "watch only" mode (decides, writes nothing) so you can see it make sane calls before it
  ever touches a real credential. The fleet stays off until you say otherwise.

## The one hard part, handled honestly

Anthropic rotates a login's refresh token every time it's used — so the same login can't safely
live in two folders at once (one copy would rotate, the other goes stale and breaks hours later).
The whole engineering core is bookkeeping that keeps **each login in exactly one place** as it
shuffles seats: a durable ledger of who's where, a crash-safe "exchange, never copy" move, and a
verify step that checks the *account identity* after every move using a Claude endpoint that
reports which account a credential belongs to.

## How I know it's solid

This design went through **five rounds of adversarial review** — including a new reviewer whose
only job is to challenge the premise itself (the lesson from last time, where I over-built before
you caught it). The reviewers found real bugs each round and I folded every one; the count fell
50 → 22 → 12 → 5 → 0, and the final round came back clean. A few examples of what they caught:
the original dev-gate would have shipped this live-with-writes on me instead of watch-first; a
subtle race where a credential could be stranded if Claude refreshed its own token at the exact
moment of a move; and a pattern where each safety "escape hatch" I added needed its own limit so
it couldn't run away. All fixed.

## What I need from you

This is me modifying my own infrastructure, so there's a deliberate **human sign-off** before I
build — the one step that isn't autonomous, by design. The design is converged and documented.

**Approving authorizes the BUILD only** (worktree → PR → CI → merge, shipping dark/off). Turning
it ON to actually start re-seating credentials stays a separate, later decision that's entirely
yours.

## Amendment (2026-06-13) — not dark for development agents

The operator directed that this should not be dark for development agents. So the gating
changed: on a **development agent** the feature now runs **live — but in dry-run**. That means
the `/credentials/*` levers return real data and the balancer runs its full decision loop and
shows every move it WOULD make, while a separate safety switch (`dryRun`, on by default) keeps it
from actually moving any credential. The wider fleet stays fully dark. Actually moving logins
between accounts still needs a deliberate, operator-controlled flip (`dryRun:false`), gated behind
running the livetest battery first. So: alive and observable for dogfooding on a dev agent, with
**zero real credential moves** until you say go.
