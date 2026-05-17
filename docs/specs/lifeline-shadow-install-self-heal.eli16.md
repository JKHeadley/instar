# Lifeline self-heal + fleet watchdog hardening — plain-English overview

> **One-line shape:** when an agent's bundled copy of instar disappears (it did, four days ago, for AI Guy), the agent currently dies forever. After this change, it puts itself back together within seconds.

## What broke

AI Guy is one of your instar agents. Every instar agent ships with its own bundled copy of the instar code — a private "shadow install" that's separate from any system-wide install. That isolation is good: an OS-level node upgrade can't break a running agent.

Four days ago, AI Guy's shadow install just… vanished. We don't know why — could have been an aborted auto-update, a stray cleanup script, or something on the filesystem. What we DO know is what happened next:

1. AI Guy's boot wrapper looked for its shadow install, couldn't find it, printed "ERROR: Shadow install not found", and exited.
2. macOS's launchd saw the agent had died and tried to restart it.
3. Same boot wrapper. Same missing file. Same error. Same exit.
4. Repeat every 10 seconds for **four days**. The error log has 37,659 identical entries.

That alone is bad. Worse: you have a watchdog that runs every 5 minutes specifically to catch this kind of stuck agent and try to repair it. The watchdog DID notice. It DID try to reinstall the missing shadow install. But every single repair attempt failed silently because of a tiny, embarrassing bug — the watchdog runs under launchd, which gives it an empty PATH variable, and `npm install`'s shebang line (`#!/usr/bin/env node`) couldn't find `node` because of that empty PATH. So every cycle: "HEAL-FAIL: npm install failed", written to a log file you don't read.

Four days. Detection works, repair fails, you never knew.

## What this change does

Three layers, fixed in the same PR:

**Layer 1 — Boot wrapper self-heals.** When the boot wrapper notices the shadow install is missing, instead of just exiting, it tries to reinstall it once before giving up. There's a 5-minute "I already tried" marker so launchd's rapid-restart behavior doesn't trigger thirty reinstalls per hour. One try, succeed, continue booting. This alone would have brought AI Guy back within seconds of the original outage.

**Layer 2 — Watchdog actually works.** The fleet watchdog gets two fixes:
- Its `npm install` call now uses absolute paths (`/opt/homebrew/bin/node` and the npm next to it) instead of relying on the empty PATH it's given.
- Its launchd configuration now sets PATH explicitly anyway, as belt-and-suspenders for any other shell utility it might invoke.

The watchdog also gets promoted from a hand-rolled script in `~/.instar/` into proper instar source, with a migration path so all future installs and all existing agents pick up the fix on the next update.

**Layer 3 — When repair fails enough times, you actually get pinged.** Today, the watchdog gives up silently after a few failed repair attempts. New behavior: after the THIRD consecutive failed repair for the same agent, the watchdog picks a healthy peer agent on your machine, calls into that agent's existing Telegram-alert infrastructure (the one we wired through the tone gate two days ago), and sends you a plain-English message: "AI Guy is offline — repair attempts aren't working — want me to dig in?" The message goes through the same quality gate as every other outbound message, so it's guaranteed jargon-free and ends in an actionable yes/no question.

## Why use a peer agent for the alert

The dead agent has no Telegram bot connection — that's the whole problem. Each agent has its own bot token, and the dead agent's bot polling died with the rest of it. To send you a Telegram alert about a dead agent, *some* running agent has to do the actual sending. The watchdog asks a healthy peer on the same machine to make the call. It's not a new authority — it's the existing alert path, just invoked from outside the dead agent.

## Why this isn't the v3 Remediator

You approved a much bigger architectural plan four days ago — the v3 Remediator spec — which builds a full orchestration system for self-healing, with capability tokens, runbooks, and a "NovelFailureReviewer" that proposes new repair recipes from observed failures. That's the right destination.

This PR is plumbing, not architecture. The watchdog's peer-escalation path will get absorbed into the Remediator's Tier-3 "Fleet Intelligence" layer when that ships. Both specs agree on the absorption point, so there's no architectural conflict — this is the immediate-value fix that closes the four-day-outage class today, while the Remediator builds toward the long-term consolidation.

## What gets safer for every agent, not just AI Guy

- Any agent whose shadow install vanishes (for any reason) self-recovers on next boot.
- Any agent that crash-loops past a few cycles for ANY reason — not just shadow-install loss — escalates to your Telegram within ~15 minutes via the peer-agent path.
- Any future fleet-watchdog improvements ship through the normal instar update flow instead of requiring you to hand-edit a script in your home directory.

## What's NOT in scope

- The root cause of the shadow-install deletion. If this turns out to be a recurring auto-update bug, that's a separate spec.
- The per-agent `health-watchdog.sh` (different artifact, working as designed).
- Any new authority over outbound messaging — all decisions still go through the existing tone gate.
