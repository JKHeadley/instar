# Letting ordinary autonomous runs count as "running" — plain-English overview

## What this is

When I work on my own for hours (an "autonomous run"), a strict checker decides whether that run is really alive. It looks at five things: is my working session running, is it writing to its log recently, can messages reach the user, have I saved real work in the last half hour, and is the run officially admitted. Only when all five are true does it call the run "active".

The fifth check, "officially admitted", only knew how to read one special record that exists for a particular kind of scheduled work window. Ordinary runs, the kind started from a normal conversation, never have that record. So no ordinary run could ever pass, no matter how well it was going. It had been that way since mid-September.

Two smaller problems blocked the same runs. If a run was registered under the wrong name for its working session, there was no way to fix the name. And the instructions for starting a run showed the task list as numbered checkboxes ("1. [ ]"), but the server only reads dashed checkboxes ("- [ ]"), so it saw zero tasks and could never record any saved work.

## What already exists

The checker, its five checks, the server's record of each run (with its end time), and the update mechanism that refreshes the built-in skill instructions on every agent.

## What is new

- A setting, off by default: when it is on, an ordinary run counts as admitted while its own server record is open and before its end time — but only if no special work-window record claims it. The other four checks are unchanged and still have to pass.
- A run registered under the wrong session name can be corrected, but only before the checker has ever judged it and only if nothing else about the registration differs.
- The autonomous-mode instructions now show dashed checkboxes, and existing agents get the corrected instructions on their next update (unless someone has customised theirs).

## Safeguards

The new setting is off unless turned on, and turning it off takes effect immediately. Special work windows keep using their own record. The name correction refuses anything that has history or differs in any other way.

## What you need to decide

Nothing. This makes permanent a fix already proven on my own setup this morning.
