# What this PR does — in plain English

## The bug

On the last test install, the Telegram group ended up with TWO
"Dashboard" topics — one with a 📊 icon, one with a 📢 icon.

Here's why: the Codex setup flow creates four topics (Lifeline,
Updates, Dashboard, Attention). But the instar server ALSO creates
Dashboard, Updates, and Attention when it first starts up — that's
its existing job, and it does it well (with proper intros and the
dashboard-link wiring). The two creators didn't know about each
other, so the Dashboard topic got made twice.

Lifeline didn't duplicate because the Codex flow saves Lifeline's
ID to the config, and the server reuses it. But it doesn't save
the other three IDs, so the server made its own copies.

## The fix

Simple ownership split: the Codex flow creates ONLY Lifeline. The
server creates Dashboard, Updates, and Attention on boot like it
already does. No more duplicates.

The Lifeline orientation message now also tells the user "a few
more topics will appear automatically once my server starts," so
the brief moment where only Lifeline exists doesn't look broken.

## About the missing dashboard link

That was a separate issue — not a bug in our code. When I checked,
Cloudflare was rate-limiting the quick-tunnel service for your IP
(error 429), almost certainly because we spun up a dozen+ tunnels
across all today's test installs. No tunnel means no dashboard
URL to post. The wiring is correct; the tunnel just couldn't get
an address.

Your two follow-up asks — (1) tell the user when the tunnel can't
connect, and (2) keep a pool of backup tunnel providers — are
tracked as separate work items. This PR is just the duplicate-
Dashboard fix.

## What doesn't change

- The server's topic creation (Dashboard/Updates/Attention) is
  untouched.
- The post-server "agent comes alive" greeting still fires.
- The Claude wizard path is untouched.
