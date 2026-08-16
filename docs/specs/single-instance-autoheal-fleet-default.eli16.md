# ELI16 — Turning on a repair that already exists

## The one-sentence version

Your agents already know how to recover from the bug that took four of them offline this morning — but that recovery is switched off on every agent except the development one, and this turns it on for all of them.

## What actually goes wrong

Every agent's server checks, at startup, whether another copy of itself is already running. If one is, it refuses to start. That check exists because of the June 20 fork-bomb, where three copies of the same server ran at once and took the machine down. It is a good check and it stays.

The way it recognises "another copy" is by writing a small file that records the machine's name. On a Mac, that name is not fixed. If you haven't pinned it, macOS works it out from the network — so the same laptop can call itself `mac.lan` on one boot and `Justins-MacBook-Pro-144.local` on the next. Nothing about the machine changed. Only the label did.

When the label changes, the leftover file from the previous run looks like it belongs to a *different machine*. The agent concludes another computer is sharing its files, refuses to start, and keeps refusing — forever. It never re-examines that conclusion. The supervisor retries, fails, and backs off to trying every 30 minutes, so the agent is simply gone and nothing says so.

This has happened three times: one agent in July, five agents for eleven hours on July 22nd, and four agents this morning — one of which had failed to start **109 times in a row**.

## The part that's already built

Someone already anticipated this. There is a repair that reclaims the leftover file, and it only acts when three separate things are all true:

- the process that wrote the file is **dead**,
- the file hasn't been touched in over **five minutes**, and
- the storage is confirmed to be a **physical disk inside this machine** — not a network drive.

That third one is doing the heavy lifting. A disk inside this machine cannot also be inside another machine. So if all three hold, the leftover file provably came from this same computer under its old name. There is no second machine, and refusing to start was simply wrong. If any one of the three is uncertain, the repair does nothing and the agent still refuses — it errs toward being cautious.

## So what's the actual bug

The repair is set to run **only on a development agent**. Every other agent has it off.

That is why your `echo` agent has sailed through every one of these incidents while the others died. I'd previously told you echo got lucky with timing. It didn't. Echo is the development agent, so it had the repair switched on the whole time. Every agent that broke is one where the repair was switched off.

## What changes

One line. The repair goes from "development agents only" to "on by default", and a migration turns it on for agents already installed — without that, the fix would only reach fresh installs and every existing agent would stay broken.

Nothing about the three-part safety test changes. Not one condition is loosened.

## Is this making the fork-bomb protection weaker

No, and this is the question worth pushing on.

The dangerous case — two copies running on one machine at the same time — is caught by checking whether the other process is **still alive**. That check is untouched. A live copy still blocks startup, exactly as before, on every path.

There are seven situations the startup check can face. Six of them behave identically before and after this change. Only one changes: the case where the other process is dead, the file is stale, *and* the disk is confirmed local. Today that refuses, and refusing is the bug. After this, it repairs itself.

## What you're deciding

Whether a repair that's been running on echo through multiple real incidents should now run everywhere.

The honest argument against: this touches the startup safety check, and that check exists because of the worst outage instar has had. Anything near it deserves suspicion.

The honest argument for: the repair has a strict three-part evidence test, fails safe whenever anything is unclear, has been proven in real use on echo, and the thing it prevents has now caused three silent multi-hour outages. A safety feature whose job is bringing agents *back* shouldn't be switched off on the agents that need it.

Reverting is one setting per agent, or one line fleet-wide. Nothing about the file format changes, so going back is clean.

## Two smaller things, deliberately not in this change

- The name in that file should probably not be the network-derived one at all — a fixed machine ID would sidestep the whole problem. That's the deeper fix, it changes the file's format, and it deserves its own review.
- Failing 109 times should have told you something. It didn't — it just went quiet. That's a separate gap and is tracked separately.

Both are real. Neither belongs bundled into a one-line default change.
