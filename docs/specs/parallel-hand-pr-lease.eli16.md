# Parallel-Hand PR Lease — the plain-English version

## The problem, in one picture

I can have more than one of "me" running at the same time — an autonomous overnight session, plus the session you're chatting with, plus maybe another working a different topic. They're all the same agent, but they don't automatically know what each other is doing.

On June 15 two of those sessions both decided to fix the **same pull request** at the same time. Picture two people editing the same document and both hitting "save" over each other: every time one pushed its version of the code, it overwrote the other's and restarted a 15-minute test run from scratch. The PR head got rewritten five times. A pull request that should have merged in a couple of minutes took about two hours of the two "hands" fighting each other.

We already fixed one cause of the slow merges (a separate repo-settings problem). This fixes the *other* cause: two of my own hands racing the same branch.

## The fix

Give each branch a **lease** — a little "I've got this one" claim:

- Before any of my sessions pushes code to a branch, a small check runs first and asks: *does another live session of mine already hold this branch's lease?*
- If yes, the second session **stands down** and goes to do something else, instead of pushing a competing version.
- The lease has a timer and cleans itself up if the session holding it dies, so a crashed session can never lock a branch forever.

## The things we got careful about (this took four review rounds)

- **Where the check runs.** My first draft put the check in the wrong place — a piece of internal code that my sessions' actual `git push` commands don't even go through. It would have looked like it worked while protecting nothing. The check now runs as a "pre-tool hook" right before a session runs `git push` in its terminal, which is exactly where the competing pushes happen.

- **Recognizing my own work after a restart.** My sessions restart often (after compaction, crashes, etc.), each time getting a new internal ID but keeping the same conversation topic. So the lease is owned by the **topic**, not the session ID — otherwise a restarted session would mistake its own lease for a stranger's and freeze itself.

- **Never getting stuck.** Every uncertain case "fails open" (allows the push). If the lease file is corrupt, if the check itself crashes, if it can't tell whether the other hand is alive — it lets the push through rather than blocking your work. A guard that breaks must never lock everything up. There's also a hard 90-minute ceiling: a *dead* holder past that gets cleared automatically; a *live* holder past that doesn't get steamrolled — instead I flag it to you to decide, because a long rebuild is legitimate.

- **It's a polite agreement, not a wall.** This only coordinates my own cooperating sessions. It never blocks you, never blocks another person or agent, and a human decision always wins. It ships turned off everywhere except my own dev machine, and even there it starts in "watch only" mode (it logs what it *would* do before it actually does anything).

## What you'd notice

Almost nothing — which is the point. Branches stop getting thrashed by my own parallel work, PRs merge faster, and if two of my hands ever do collide, one quietly waits instead of starting a two-hour tug-of-war. If a branch is ever held too long, you get one clear heads-up rather than silence.
