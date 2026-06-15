# Supervisor respawn guarantee — plain-English overview

> **One-line shape:** when my server process dies, the thing that's supposed to restart it got tricked into thinking "the laptop just went to sleep, give it a minute" — over and over — so it waited forever instead of restarting a server that was already gone. This makes "is the server actually there?" the deciding question instead of a guess.

Today my server crashed and then stayed dead for about two hours, until Justin messaged me and I restarted it by hand. That is exactly the thing he says is non-negotiable: I should be able to work for hours without anyone checking whether I'm still alive. So this fix is about one promise — if my server dies, it comes back on its own within seconds, no matter why it died or what else is going wrong on the machine.

Here is what went wrong, in plain terms. There's a little supervisor that checks the server's pulse every 10 seconds. If it ever notices a big gap between two checks — say several minutes passed instead of 10 seconds — it assumes the laptop went to sleep and woke back up, and it politely says "okay, the server is probably just booting again, I'll ignore any failures for a while so I don't kill it while it's starting." That politeness is good when the laptop really did sleep.

The problem: the laptop wasn't sleeping. It was just overloaded — so busy that the supervisor's own 10-second timer was running minutes late. The supervisor saw those late checks and *thought* it was sleep/wake. Every late check reset its "give it time to boot" window. So it stayed permanently in "ignore all failures, it's probably booting" mode — and never noticed that the server had actually crashed and its window (its tmux session) was completely gone. It sat there being patient with a server that no longer existed.

## The fix, in three parts

**Part A — the real guarantee: check if the server actually exists.** Before deciding to "be patient because it's booting," the supervisor now first asks a question that has no grey area: *does the server's session even exist right now?* A server that's booting always has its session open (the window opens first, the webpage comes up a moment later). So if the session is gone, the server isn't "booting slowly" — it's dead. In that case, restart it immediately. No patience, no sleep guess, no waiting. This one change alone would have brought me back within 10 seconds today instead of two hours.

**Part B — stop the sleep/wake confusion at the source.** When the supervisor sees a big gap, it now checks how busy the machine is. If the machine is slammed, it correctly says "that gap was me running late because of load, not the laptop sleeping" — and does *not* reset the patience window. It only treats a gap as real sleep when the machine is actually idle.

**Part C — a hard time limit on patience.** Even in the worst case, the "be patient, it's booting" window can never stretch past a fixed wall-clock limit. After that, the supervisor goes back to acting on failures normally, so it can't be lulled forever.

## What this does NOT change

A server that is genuinely just booting (its session is open, the webpage isn't up yet) still gets the full normal grace period — Part A only fires when the session is truly gone, so it never kills a healthy boot.

## Two things still on the list (not dropped)

This fixes the main net — the one that failed today. Two more nets had problems too, and I'm tracking them so they don't get forgotten: (1) stopping one small subsystem error (a Slack connection hiccup) from being able to crash the whole server in the first place, and (2) fixing the separate 5-minute "backup" watchdog that was quietly erroring out. Both are written down as follow-ups in the spec, not left to memory.
