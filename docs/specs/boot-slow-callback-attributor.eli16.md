# Finding what freezes the server at boot

## What is going on

Each time the agent server on the Mac Studio starts, it freezes for about 22 seconds before it begins answering. During that time nothing can reach it: phones, other machines, and the agent's own sessions all wait. The logs show the freeze happened, because a watcher notices the clock jumped while the processor stayed busy, but they don't show what caused it. Both restarts on 18 November froze at the same point.

The usual way to find a freeze like this is to profile the running server. We tried that once on the Studio and it crashed the server, so we don't profile live servers any more.

## What this change adds

A small built-in diagnostic that runs only for the first two minutes after the server starts:

- It times every piece of deferred work the server runs (timers, "do this next" callbacks, and promise continuations).
- For anything that runs longer than one second, it writes one line to the server log. The line names the kind of work and the place in the code that scheduled it.
- After two minutes it switches itself off.

The next restart then tells us which step is the 22-second one, and that step can be fixed directly.

## Safeguards

- It only watches. It never delays, stops or changes any work.
- If it hits an error of its own, it switches itself off and says so in one log line.
- It writes at most 20 lines, and it caps how much it remembers at once.
- It runs only on development agents. It is off everywhere else.
- It is temporary. Its maturation-ladder entry is marked for removal once the freeze is fixed.

## What needs deciding

Nothing. This is a small, reversible diagnostic. Removing it is a one-line revert.
