# ELI16 — The agent must never go silent on you

## The problem

The agent runs work in "sessions." To protect the machine, it closes idle sessions when memory looks tight and brings them back when things calm down. But two things can go wrong:
1. It can close a session and then **never bring it back** — and tell you NOTHING. A whole topic goes quiet, and you only find out by noticing the silence. That just happened (topic 28744): a session was closed, got stuck in the "bring back later" line, and the line never moved — silently.
2. There's no guarantee that AT LEAST ONE session — the one you actually talk to the agent through (the lifeline) — is always alive. If everything gets closed, you can't reach the agent at all. And the agent is the very thing that could fix the problem if you could reach it.

## The principle

The operator's rule: **the agent must always be reachable, because the agent is the solution.** It has the tools to diagnose and free up resources itself. So:
- Keep at least one session — the lifeline — always alive, no matter how tight resources get.
- If a session is EVER held back or closed for resource reasons, say so clearly, in plain English, with guidance — never silence.
- Free your own resources first (clean up junk, fix bad readings) before bothering the user.

## The fix (three guarantees + a rule)

1. **A floor:** the lifeline session is always protected from being closed, and is allowed to start up even when the machine is busy. One session is guaranteed — you can always reach the agent.
2. **No silence:** any time a session is denied or held for resource reasons, you get one clear message saying what happened and what to do — instead of a topic just going quiet. The specific gap (a "bring-back" that silently never happens) now speaks up after a short wait, not after a day.
3. **Self-help first:** the agent tidies its own house (stale sessions, junk worktrees, wrong readings) before ever telling you it's stuck.
4. **A standard:** this becomes a written INSTAR rule — "The Agent Is Always Reachable" — so it's enforced in code, not just hoped for. It's the availability twin of the existing "the operator's channel is sacred" rule.

## Safety

- The floor exempts EXACTLY ONE session (the lifeline) from resource limits — it's a minimum guarantee, not a free-for-all. Every other session still respects resource limits, so this can't be used to overload the machine.
- The "no silence" messages respect the existing anti-flood budget, so you won't get spammed.
- The change can only make the agent MORE reachable and resource problems MORE visible — never less. There's no direction in which it makes things quieter or closes more.
- One machine only; on a multi-machine setup, each machine guarantees its own reachable session.

## Note

A separate fix (already shipped) corrected a bad memory reading that was causing FALSE "out of memory" alarms — that's what made this particular silence happen. This change is the structural guarantee that you stay reachable even when the machine is GENUINELY tight, and that you're always told what's going on.
