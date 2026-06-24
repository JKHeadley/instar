---
title: Mesh Coherence — Live-State Honesty (ELI16)
companion-spec: mesh-coherence-live-state-honesty.md
parent-principle: "Signal vs Authority"
author: echo
date: 2026-06-24
---

# Mesh Coherence — Live-State Honesty (in plain English)

## The one-sentence version

There's a little "is your multi-machine wiring set up sanely?" health-checker that prints
friendly warnings at startup, and right now it can lie in two small ways — this fixes both so
its warnings are actually true.

## What's the checker?

When you run me on more than one machine, my machines talk to each other over a "mesh" — a few
network ropes (Tailscale, your local network, a Cloudflare tunnel) that I hedge across so one
flaky rope doesn't make a machine look dead. At startup I run a tiny checker that looks at the
mesh settings and prints a yellow warning if something looks contradictory (for example, "you
turned the mesh off but you're still actively moving conversations between machines — that
combo reintroduces the bug we just fixed").

Crucially, this checker only **warns**. It never refuses to start, never blocks anything. It's
a heads-up for you (the human), and you decide what to do. That's the "Signal vs Authority"
rule — the checker is a signal, you're the authority. We keep it exactly that way here.

## Lie #1: it only reads the SETTINGS, never what's actually running

Imagine you edit the config to turn the mesh OFF, but you don't restart me. The running
process is still bound to the network and still telling other machines "here's how to reach
me" — because that was all decided when I booted, and a config edit doesn't reach a
already-running process. But if you then ask the checker "is everything coherent?", it re-reads
the new config, sees "mesh: off," and cheerfully says "all clear." It's reading your *intention*,
not my *reality*. You'd think the mesh is off when it's plainly still up. The reverse can
happen too: config says "mesh: on" but I never actually managed to advertise any ropes, so it's
really just sitting there inert — and the checker still says "on."

**The fix:** add a second, periodic check that compares the config's intention against the live
truth — the network address I actually bound to and whether I'm advertising any ropes at all —
and warn when they disagree ("config says off, but I'm still bound — a restart will apply it,"
or "config says on, but I'm not currently advertising any ropes — check identity/network/tunnel").
It still only warns; it just tells the truth now.

A few careful details so the new check is honest AND quiet:
- **It leans on what it can trust.** The "is the mesh still up?" verdict keys off the address I
  actually bound to — that's a fact about MY own process that can't change without a restart.
  And "up" means *any* non-loopback address, not just the catch-all wildcard ones: if you pin
  the mesh to a specific machine address (say your local-network IP) and then flip mesh off
  without restarting, I'm still genuinely up on that address — so the check correctly counts
  that as "still up" and warns, instead of being fooled into silence. (That bound address comes
  from your own settings, so it's safe to print.) The list of ropes, by contrast, lives in a
  file my other machines can also write, so the check only uses it as a yes/no "am I advertising
  anything?" hint — it never reads the actual addresses out of it or repeats them in a warning.
  That way a junk or hostile entry written by another machine can never steer what the warning
  says.
- **It doesn't nag.** Instead of printing the same warning every 30 seconds forever, it prints
  ONCE when a problem appears and then stays quiet until the problem goes away and comes back.
  (A "same true line over and over" log is exactly the kind of noise we've been burned by.)
- **It waits a beat before crying "inert."** Right after I boot, it's normal to have no ropes
  advertised yet for a minute or two. So the "you're advertising nothing" warning holds off for
  about two minutes after startup — long enough for a healthy start, but it still fires if the
  mesh genuinely never wakes up (which is the most important case to catch). It measures that
  two minutes with a clock that can't be fooled by the system time jumping around.
- **It's gradeable.** Every time it runs it quietly records "did I find a problem or not?" so we
  can tell, during the soak, whether it's earning its keep.
- **It can't get stuck or go silent on a bad read.** The live state lives in a file that other
  machines rewrite, so a read can occasionally hit a half-written or corrupt file and throw.
  When that happens the check doesn't crash the tick and doesn't invent a warning — it records a
  quiet "that read failed" note and then *backs off*, retrying less and less often instead of
  hammering a broken file every 30 seconds. But the back-off is capped, so even a permanently
  broken file still logs a failure note roughly every ten minutes — it never goes fully silent —
  and the moment the read works again it snaps right back to normal.

This new periodic check ships behind a development-only switch first (so it can be soaked and
turned off instantly), which is the normal careful-rollout pattern for any new background check.

## Lie #2: it checks a setting that doesn't exist anymore

The checker also tries to make sure the rope priorities (which rope to prefer) are sane —
distinct and positive. But it's looking at an old-style setting key that nothing ever fills in
— in fact that key exists in NO settings type and NO default; it was a phantom that only ever
lived inside the checker's own local description of the config. The real settings are three flat
keys (`priorityTailscale`, `priorityLan`, `priorityCloudflare`, which default to 10/20/30). So
the priority check is dead — it's been silently doing nothing. If you accidentally set two ropes
to the same priority, or a negative number, you'd get no warning and rope selection would
quietly become random.

**The fix:** delete the dead phantom check entirely and check the REAL keys for "distinct and
positive," reusing the same warning names. We also tighten the checker's internal type so the
phantom key literally can't be typed back in. This one's a pure improvement to an existing
startup warning, so it ships right away with no switch.

## What this is NOT

- It does NOT block startup or change any mesh behavior — it only makes warnings honest.
- Two earlier suspected issues were dropped: one ("binds to localhost so the mesh is dead")
  was already fixed in the current version, and another ("turning the tunnel off leaves only
  the local-network rope") turned out to be wrong — live evidence shows the Tailscale rope
  works fine with the tunnel off.
- It's machine-local: each machine just checks its own settings against its own running state.
  Nothing fans out across the fleet.

## Why it matters

A safety check that says "all clear" when things are actually misconfigured is worse than no
check at all — it gives false confidence at exactly the moment you're trying to verify
something. This makes the mesh health-check tell the truth, while keeping it a gentle warning
you stay in charge of.
