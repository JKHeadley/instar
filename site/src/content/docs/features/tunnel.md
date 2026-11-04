---
title: Tunnels
description: How an agent keeps a public address for its dashboard and private pages, and when it may fall back to a relay.
---

A tunnel gives the agent a public address for its dashboard and private pages. Several backends can provide one, and one owner decides which runs.

## Backends and trust

Each backend implements `TunnelProvider`, and the manager treats them as interchangeable. A provider only starts its backend, reports the address and gives a way to stop it. It doesn't decide about retries, fallback or notices.

| Tier | Backend | When it runs |
|---|---|---|
| 1 | `CloudflareNamedProvider`, a persistent named tunnel | Tried automatically |
| 1 | `CloudflareQuickProvider`, a zero-config Cloudflare quick tunnel | Tried automatically |
| 2 | `LocaltunnelProvider`, a relay through `*.loca.lt`, and bore | Never without the owner's recorded approval |

## An address has to work

An address counts as active only after a request to `/health` through the public address succeeds. That stops a false "back online" message about a dead link.

## One owner of the lifecycle

`TunnelLifecycle` owns the sequence: detect a failure, attempt a start, fall back, notify, and heal itself. Every state change goes through one compare-and-swap, which refuses a change from a state the tunnel is no longer in.

## Who sees what

`TunnelNotifier` keeps two channels apart. A group topic gets status text only, and never the address, the PIN or a signed link, because anyone in the group could read them and get around the owner's consent. The owner's private chat with the bot is the only channel that gets the address, the PIN and signed links.

`GET /tunnel` reports the current status.
