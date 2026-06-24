# Mesh Endpoint HTTP Propagation — plain-English overview

## The one-line version

When you run your agent on two machines (laptop + Mac Mini), they need a fast, reliable way to talk
to each other so they can agree on "who's in charge." Right now they're stuck using one slow, flaky
connection — and this fix gives them the fast ones they already have but never told each other about.

## What's actually broken

Your two machines each have several possible "ropes" to reach the other one:
- **Tailscale** (a private, reliable network) — fast.
- **LAN** (your home wifi) — fast.
- **Cloudflare tunnel** (over the public internet) — works, but occasionally spikes to 30+ seconds.

Each machine figures out its OWN fast ropes correctly. The problem is they never *send* that list to
the other machine. The only address they share is the slow Cloudflare one — and they only share THAT
because it gets recorded once, at the moment the two machines are first paired.

Why don't the fast ropes get shared? Because the code that's supposed to share them does it by
writing to a shared Git repository — and your personal 2-machine setup doesn't use Git for that. So
the sharing step quietly does nothing. The fast ropes exist, but each machine is blind to the other's.

The consequence is the bug that's been biting you: the machines fall back to the one flaky Cloudflare
rope to keep their "who's in charge" badge (the lease) up to date. When Cloudflare hiccups, the
laptop briefly thinks it lost the badge — even though it's literally holding it — and the safety net
that's supposed to revive a dead session refuses to act because "I'm not in charge right now." That's
the death-loop: your overnight session dies and your Telegram messages hit a dead end.

## The fix

Send each machine's fast-rope list to the other one over the secure connection they ALREADY use to
exchange heartbeats ("still alive!" pings) every few seconds. This is the exact same path the slow
Cloudflare address already travels — we're just adding the fast ones alongside it. When the laptop
receives the Mini's heartbeat, it records the Mini's Tailscale/LAN addresses, and from then on the
lease prefers those fast, reliable ropes. Cloudflare stays as a last-resort fallback.

## What changes for you

Nothing you have to do. After this ships, your two machines find each other over the fast network,
the lease stops falsely flapping, and the revival safety net works the way it was meant to. The
overnight death-loop's root cause is gone.

## The tradeoff

This is a purely *additive* change — it only ever gives the machines MORE ways to reach each other.
The worst case (if the new data is missing or malformed) is exactly today's behavior: Cloudflare-only.
It can't, by itself, cause the machines to disagree about who's in charge; if anything it makes that
agreement *more* accurate, because the machines stop losing contact over a flaky rope. The one thing
we're careful about: the receiving machine validates the addresses it's told (they must look like
real Tailscale/LAN/Cloudflare addresses) and ignores anything that doesn't, so a machine can't be
fed junk. It rides the existing multi-machine mesh feature flag, so it's off when that's off.
