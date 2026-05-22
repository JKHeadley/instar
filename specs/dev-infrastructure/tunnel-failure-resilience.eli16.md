# Tunnel failure resilience — plain English

## What we're building

instar puts the agent's dashboard online through a Cloudflare tunnel.
When Cloudflare rate-limits the shared tunnel pool, the link just
vanishes today with no explanation. This spec builds the tunnel layer
out into something resilient:

1. **It tells you what broke.** When the tunnel fails, the agent posts
   in your Dashboard topic with what happened and why — instead of
   going silent for minutes while you wonder if it's broken.

2. **It tries something else.** When Cloudflare is fully unavailable,
   the agent can offer to route through a backup relay — but only
   after asking you in DM first, because relays send your private
   dashboard traffic through someone else's servers.

3. **It heals itself.** When Cloudflare comes back up, the agent
   automatically switches you back to your normal link. No restart
   required.

## The security rule that drives the design

You chose "default to secure" for the backup providers. That means:

- The automatic backups are Cloudflare only. Cloudflare's named tunnel
  (your account) first, then Cloudflare's free quick tunnel as a
  fallback. Both you already trust.
- The two free relays (localtunnel, bore) send your traffic through a
  third party's servers. Neither is used silently. The agent asks you
  in DM, you approve with a single tap, and only then does it activate.
- The credentials (the URL with its signature, your dashboard PIN)
  never go to the group topic. Anyone in the group could read them.
  The agent puts the actual link in your DM; the group only gets
  status text like "backup is up, check your DM for the link."
- After a relay episode ends, your auth token and PIN both rotate.
  That invalidates any signed view URLs that transited the relay.

## What changes for you

- Today: Cloudflare goes down → no dashboard link → silence → you
  guess. After the change: Cloudflare goes down → the agent tells you
  in Dashboard topic exactly what happened, optionally asks in DM if
  you want a backup, switches back automatically when Cloudflare
  recovers. No restart.
- After a relay episode ends, any browser tab where you're already
  logged into the dashboard will ask for a PIN again — the new PIN
  arrives in your DM as part of the recovery message. Any private
  view link the agent gave you before the relay episode will stop
  working; ask for a fresh one if you need it. This is the security
  cost — see the longer explanation in the topic-9984 thread.

## What's NOT in v1

- `bore` (the unencrypted relay) is disabled by default. Plaintext TCP
  means the relay operator and on-path observers could see your
  traffic. v1 ships localtunnel as the only consent-gated relay.
  A future release can add bore once we have a verified install path.
- ngrok stays excluded entirely (account friction).
- A single message in your DM with a "yes" / "no" button is how you
  approve. No free-text consent — that would be vulnerable to
  misinterpretation.

## Why this took 4 review rounds

Four parallel internal reviewers (security, adversarial, integration,
state-machine) found 25 material issues; an external GPT reviewer
found 7 more (one CRITICAL: the original design would have posted the
URL+PIN to the group topic, defeating the owner-only consent gate);
a verification round on the rewrite found 2 more (rotation on
crash/shutdown paths, and consent-prompt cross-episode cooldown).
All 34 material findings are folded into v4. A second verification
round confirmed convergence — no new material issues.

The full technical spec lives in the parent document; this companion
is what you read.
