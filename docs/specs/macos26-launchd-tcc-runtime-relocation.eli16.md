---
title: macOS 26 launchd-TCC runtime relocation — ELI16
date: 2026-05-27
author: echo
companion-spec: macos26-launchd-tcc-runtime-relocation.md
---

# macOS 26 launchd-TCC runtime relocation — plain-language version

## What broke

The Mac just changed the locks on the Documents room. The building manager (launchd, the thing that starts your agent when you log in) used to have a key to anything that ran out of a homebrew node — so we put the agent's startup files in `~/Documents/Projects/<project>/.instar/` and called it a day. After macOS 26 the building manager no longer has that key. When it tries to open the Documents room to start the agent, the kernel slams the door and the agent never starts. The agent's own backup plans live inside the agent, so if the agent never starts, none of them fire either. The building manager just kept rattling the door 600 times in two hours, silently.

The b2lead agent hit this after a reboot today. Echo isn't affected because Echo's startup files live in `~/.instar/`, which the manager DOES have a key to.

## The hard truth the review forced (important — this changed)

I first told you b2lead would recover automatically with zero touch. The review proved that's impossible, and I need you to know why. To move the startup files out of the locked room, something has to reach INTO the locked room to grab them. But everything that runs on its own in the background (the agent, the watchdog, the auto-updater) is started by the same building manager that doesn't have a key. They're all locked out too. macOS designed it this way on purpose — no always-running background thing can reach into Documents.

The only things WITH a key are the ones YOU start by hand: a normal Terminal window, and the Claude Code session sitting at the project. So:

- **Brand-new agents:** immune from day one. Setup runs when you start it (it has a key), moves the files to the safe room, done. Never a problem.
- **Existing agents still alive:** move themselves to the safe room the next time you run an update by hand.
- **An already-dead agent like b2lead:** needs exactly ONE thing from you — either click "Allow" on a Full Disk Access popup we trigger, or run `instar relocate` once in a terminal. After that one click it's fixed forever and never comes back. That one action can't be avoided; it's the same first-time permission every Mac app asks for. I was wrong to say zero-touch, and I'd rather correct it now than after building the wrong thing.

## What we're fixing (one PR, five parts)

**A — Move the startup files out of the locked room.** Anything the manager touches on boot (node, the boot script, the shadow install, the agent's state and config, AND the logs — the review found the manager couldn't even write the error log into the locked room, which is why b2lead's error log was empty) gets relocated to `~/Library/Application Support/instar/`, which the manager can always reach. The agent's BRAIN moves to a safe room; the project code stays where it is. The boot instructions point straight at the safe room so the manager never has to touch the locked room at all.

**B + C — Always-reaches-you alarm (no new secret file).** Today the fleet watchdog only knows how to page you THROUGH another healthy agent on the same machine. One-agent machine = no one to pass the message to = silence. My first draft fixed this by stashing every agent's Telegram token in a new file — the review rightly killed that (it's exactly how we leaked a bot token before). The better design: the watchdog writes the alarm to a small to-send list, and either sends it directly using the agent's OWN already-stored token (for agents already moved to the safe room), or hands it to the next thing that DOES have a key — the Claude session's startup hook — to send for it. No token ever gets copied into a new place. The watchdog also learns to recognize "the kernel slammed the door" (exit 78) specifically and name the exact one-time fix, instead of a generic "offline." And it only pages you ONCE per outage, not every 5 minutes.

**C — Reboot-proof the updater.** When the updater is in its "wait 5 minutes before restarting" pause and the machine reboots in the middle, today the pause intent is forgotten. We persist it to disk and re-check on every boot, so the restart finishes after the reboot instead of stranding the agent on the old code.

**D — Discovery: never "NOT RUNNING" with no explanation.** Today if the agent is down, the only thing SessionStart and capabilities can tell you is "Instar server: NOT RUNNING." We add a small diagnostic that reads launchd's logs and tells you the actual cause and the actual fix.

**E — One-time setup prompt for Full Disk Access.** The honest part I'd written off too fast: macOS grants Full Disk Access PER BINARY, and once node has it, every future launchd-spawned node inherits it. The prompt fires when an interactive process triggers the access. So at setup time on macOS 26+, after A is done, we deliberately trigger that prompt once. User clicks Allow. Done — from then on the agent can also operate on project source files in Documents without any further manual step. (I haven't empirically verified that the prompt fires from a CLI on 26.5; if it doesn't, we fall back to a clear System Settings deep-link instead of overpromising.)

## What I'd been wrong about

I'd told you the FDA grant was "Apple-mandated manual" and not automatable. You pushed back citing Scout's manual recovery — and you were right. Scout worked because Scout runs inside an interactive shell that has TCC consent; the same thing launchd lacks. The automation IS there in two ways: relocating the startup files (so launchd doesn't NEED that room) and triggering the FDA prompt during interactive setup (so node gets the room key once and never asks again). I'd conflated "you can't auto-grant FDA via an API" with "this isn't automatable." Saved the lesson.

## What the review changed (so you can see the convergence working)

The first draft had three problems the five reviewers caught:
1. **"Zero touch for dead agents" was impossible** — corrected to the honest one-click story above.
2. **A new file holding every agent's Telegram token** — killed; we reuse the token already on disk and never copy it.
3. **The migration would have run in the locked-out context and silently done nothing** — now it checks whether it can actually reach the files first, and if it can't, it shouts (pages you) instead of failing quietly. It also can't leave a half-moved mess: it builds the new copy off to the side, checks it really works, and only then flips over — and keeps a backup until the next healthy boot.

## Open questions (just one left for you)

The first three are now decided (no token file; runtime root in `~/Library/Application Support`; whole-folder symlink + a single resolver with a build-time guard so nothing drifts).

**The one left:** I haven't tested whether macOS 26.5 actually pops the Full Disk Access dialog when a command-line tool asks — I'm not on a 26.5 machine. Until I can verify it on b2lead's machine, part E ships as "here are the exact System Settings steps" rather than auto-popping the dialog. Is it OK to ship E in that guided mode first, and turn on the auto-popup only once I've confirmed it works on a real 26.5 box?

## No-deferrals

Five parts, one PR. The three resolved questions are decided in the spec, not punted. The last one is a verification gate, not a deferral — part E works safely either way.
