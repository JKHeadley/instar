# Tailscale Rope Detection — Plain-English Overview

> The one-line version: ask the machine whether it has a private-network address, instead of asking an app that might be the wrong copy.

## The problem in one breath

When an agent runs on more than one machine, the machines need routes to reach each other. One of those routes is Tailscale — a private network that works from anywhere. Each machine works out whether it has a Tailscale address and advertises that route to the others. It did that by asking the Tailscale command-line tool. On a machine with two Tailscale installs, it asked the wrong one, got told "logged out", and advertised no route at all — while that very route was carrying traffic.

## What already exists

- **Multiple routes between machines** — Tailscale, the local network, and a Cloudflare tunnel. The machines use whichever is healthy, so a single flaky one shouldn't cut a machine off.
- **Route advertising** — each machine publishes the ways it can be reached, and the others hedge across them.
- **The Cloudflare tunnel** — the fallback that works from anywhere but is the least reliable of the three; it is the one behind the historical disconnects.

## What this adds

Detection now reads the machine's own network settings first: if a private-network address is bound to a tunnel device, the route exists — whichever background service put it there and however many copies of the app are installed.

- The old method is kept as a fallback for systems whose tunnel device is named unusually, so this can only ever ADD a detection, never remove one that already worked.
- It needs no program on disk, no command to run, and no search path — it reads state the operating system already holds.

## The new pieces

- **The interface reader** — picks a private-network address bound to a tunnel device. It is deliberately narrow: it only accepts tunnel-shaped device names, and refuses the same address range on an ordinary network adapter.

## The safeguards

**Prevents a false route being advertised.** Some internet providers hand out addresses from the same private range on a normal connection. Advertising one of those as a Tailscale route would tell the other machines to try an address that goes nowhere. Restricting to tunnel devices closes that.

**Prevents losing a detection that used to work.** The old method still runs when the new one finds nothing, so no machine that was detected before stops being detected now.

**Prevents the tests lying about it.** The existing tests previously read the real network of whatever machine ran them — which is both unrepeatable and would have hidden this exact bug. They now pass an explicit empty table.

## What ships when

One patch. No phases, no flag, no rollout stages.

## What you actually need to decide

Nothing operational — there is no setting and no action for anyone to take. The only reviewer question is whether the machine's own network state is a better source of truth than an app's answer about itself, and it is: the address either is bound or it isn't, and no signed-out copy of an app can make a working route disappear.
