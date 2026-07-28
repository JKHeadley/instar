# Tunnel Reachability Grace Window — Plain-English Overview

> The one-line version: when the agent's public tunnel comes up, give the internet a few seconds to notice before declaring it dead — a single too-early check was killing perfectly healthy tunnels and leaving agents link-less for hours.

## The problem in one breath

Every instar agent can expose itself to the internet through a Cloudflare tunnel — that's what makes the dashboard, private views, and remote access work from your phone. When the tunnel process starts, the agent checks "can the world actually reach me?" by fetching its own public URL once. But Cloudflare's edge needs a few seconds after a tunnel connects before it starts routing traffic — during that window it answers with an error even though the tunnel is fine. The agent's single, immediate check kept landing inside that window, concluding "unreachable," killing the healthy tunnel, and falling back to throwaway quick tunnels that Cloudflare rate-limits. End state: the tunnel system gives up ("exhausted") and retries every 15 minutes — hitting the exact same too-early check every time, forever. We watched this live on the instar-codey agent on 2026-07-09: its tunnel config was perfect (a hand-started tunnel served traffic within 6 seconds), but the agent had been link-less for hours, its dashboard-link job failing every 80 seconds and flooding its health report with two dozen degradation notices.

## What already exists

- **The tunnel manager** — starts the tunnel process, checks reachability, and walks a ladder of fallbacks (named tunnel → quick tunnel → consent-gated relay) with a lifecycle state machine and retry backoff. All of that stays exactly as it is.
- **The reachability check itself** — one HTTP fetch of the agent's own public `/health` URL. This is the only piece that changes.

## What this adds

The reachability check now retries over a short grace window before giving a "dead" verdict: check, and if it fails, wait 2 seconds and check again, then 4, then 6 — four attempts in total, roughly twenty seconds of patience at most. The first success ends the loop immediately, so a healthy tunnel passes exactly as fast as before. Only a tunnel that fails every attempt across the whole window is declared unreachable and torn down. If the agent is shutting down mid-window, the loop bails instantly instead of sleeping through it.

## The safeguards

- **Nothing gets more permissive about real failures** — a genuinely dead tunnel is still detected and torn down; it just takes a few bounded seconds longer, after which every existing fallback (quick tunnel, relay consent, 15-minute retry) behaves exactly as today.
- **No new authority** — the check stays a yes/no signal feeding the existing lifecycle machinery; nothing new can block or kill anything.
- **Shutdown-aware** — stopping the agent never waits out the grace window.
- **Test seam, not a config knob** — tests inject millisecond delays so the suite stays fast; there is no new user-facing configuration to misconfigure.

## What you actually need to decide

Nothing — this is a small resilience bug fix with an obvious revert (it's one code path, no data or config changes). The observable effect for users is that agents with named tunnels stop mysteriously losing their public link after a restart or a transient Cloudflare hiccup, and the "exhausted, retrying forever" failure mode heals itself on the next retry instead of replaying the race.
