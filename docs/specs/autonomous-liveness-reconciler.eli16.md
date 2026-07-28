# ELI16 — Autonomous Liveness Reconciler

## The problem in plain words

When I run a long autonomous job, my "session" (the actual running program) gets recycled every few hours — that's normal and healthy. The recycle is supposed to be invisible: my job is meant to automatically come back and keep going. There's a status file on disk that says "this job is active, with 15 hours left."

One night that safety net failed. A recycle happened, and the bit of code that decides "did this interrupt real work? → if yes, bring it back" looked at the wrong instant and decided "nothing was in progress" — even though I was mid-build. So nothing brought the job back. The status file still said "active, 15 hours left," but there was no actual program running it. Nothing was watching for that contradiction. When my operator messaged an hour later, there was no live me to answer.

The root cause: the "bring it back" decision happens at one single moment (the instant of the recycle) and depends on a chain of lookups all working perfectly in that instant. If any one link fails right then, the job dies silently forever, and nothing ever re-checks.

## What this builds

A small background "watcher" that works like a thermostat instead of a one-time switch. A thermostat doesn't try to perfectly predict the exact second the room gets cold — it just keeps checking "is the room the temperature it should be? If not, fix it." This watcher keeps checking: "for every job whose status file says it's active with time left, is there actually a live program running it? If not — and it's safe to act — bring it back."

Because it re-checks continuously, it doesn't matter HOW the job got orphaned (a missed signal, a crash, the laptop sleeping). It converges back to the right state. It's the companion to a sibling feature (the "heartbeat") that handles the milder case of "I'm alive but went quiet"; this one handles the worse case of "I'm gone but the records still say I'm here."

## The safety rules (why it won't misbehave)

The watcher only brings a job back when it's genuinely safe: it won't touch a job the operator deliberately stopped, a job that's paused, a job that's moving between machines, a job another machine owns, a job that's already coming back through the normal path, or a job that actually has a live session. It waits a couple of cycles before acting (so a brief, self-healing gap doesn't trigger it). If a job keeps dying and coming back, it gives up loudly after a few tries (raising ONE alert for the operator) instead of looping forever. Every time it acts, it tells you ("I noticed my run here had no live session and brought it back").

Most importantly: it ships OFF for everyone, and on my own development machine it starts in "observe-only" mode — it just writes down "I WOULD have brought this back" without actually doing it, so we can watch its judgment for a while before it's ever allowed to act for real. Every dependency it reads fails toward NOT acting, so when it's unsure, it does nothing — the safe direction. The worst it can do when fully live is waste a few tokens bringing back a job that should be alive; the thing it prevents is a job silently dying for hours.

## Status

Converged (4 review rounds, codex cross-model) and approved under the operator's standing autonomous mandate ("make autonomous runs robust; don't stop to ask for a steer" — reversible, dark/observe-only changes). Shipping through the full instar-dev gate as a dark-on-fleet, dryRun-first-on-dev feature.
