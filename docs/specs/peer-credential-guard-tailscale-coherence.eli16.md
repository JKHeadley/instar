# Plain-English overview — why "what's happening on my other machine?" comes back empty

## The symptom

Justin runs one agent across three machines. From the Windows machine, every question of the
form "show me this across all my machines" came back with nothing — each machine listed as
simply unavailable. The agent could not see itself.

## What was actually wrong

Each machine knows several ways to reach each of the others. Think of them as three different
roads to the same house:

- a **Tailscale** road (a private network overlay),
- a **home-network** road (only works if both machines are on the same home network),
- a **tunnel** road (goes out to the internet and back; works from anywhere).

Before sending its password to another machine, the agent checks that the road is one it
trusts. That check knows about home networks and tunnels. Nobody ever taught it about
Tailscale roads — so it refuses them.

That refusal alone was survivable. The real problem was the next step: the part that *picks*
which road to use picked the best road without ever asking whether the security check would
allow it. It picked the Tailscale road, the check refused it, and the whole thing gave up —
even though two other perfectly good roads were sitting right there.

So one line of code that threw away a list of alternatives turned a small gap into a total
dead end.

## The fix

Two small changes:

1. **Ask the security check *before* picking.** Choose the best road that is actually allowed,
   rather than picking first and discovering the refusal afterwards.
2. **Remember which roads don't work.** The agent already has a memory of which roads are
   reliable, but the "show me everything" feature never wrote anything into it. Now it does,
   so a road that keeps failing stops being chosen.

That's it. Same number of connections as before, same security rules as before.

## Something the review caught that is worth knowing

The first version of this fix was wrong in a way that would have looked completely fine.

It said: "if the first road is refused, try the next one." Tested against the real machines,
that fails — because the Windows machine and the Studio are on *different* home networks. So
the Studio's home-network road passes the security check and is completely unreachable from
the Windows machine. The first fix would have chosen that dead road and stopped.

The mistake was treating "allowed to use" as if it meant "actually works." There's now a test
that fails if anyone writes it that way again.

## The honest limitation

Machines currently talk to each other using the agent's main password — the same one that can
change things, not just read them. That password is sent to whichever road is chosen, and the
agent never verifies that the machine answering really is the machine it meant to reach.

This fix does not solve that, and in one narrow way it makes it slightly worse: by choosing
different roads over time, the password reaches a few more machines than it used to. All of
them are machines already on Justin's own list, authenticated exactly the way they are today —
but "slightly more" is not "the same," and the review was right to keep insisting on that
distinction until it was written down plainly.

The real answer is that machines shouldn't be using that shared password with each other at
all. Instar already has a better mechanism built in — each request signed individually, so
nothing reusable ever travels.

One correction worth making plainly, because an earlier draft of this page got it wrong:
signing proves **who sent** a request, not **who answered it**. So switching to it removes the
reusable-password problem but does *not* by itself confirm the machine on the other end is
really Justin's. Doing that properly needs the signature to also commit to the intended
recipient and the exact request, plus a signed reply. That is a bigger, security-sensitive
change with its own design document — written down as the next step rather than left as a good
intention, and deliberately not bolted onto this one.

## What changes for Justin

Cross-machine questions start working: "what's running everywhere," "how much quota is left
across all my machines," "what needs my attention." Before, those were silently empty.

Two different promises, kept apart on purpose:

- **Guaranteed, immediately:** a road the security check refuses is never chosen again, so the
  permanent dead end is gone from the first attempt. That is the reported problem, and it is
  fixed outright.
- **Not guaranteed:** a road that is *allowed* but dead is only dropped after three failures in
  a row, and because that memory is shared with other traffic, a success elsewhere can reset the
  count. So that case usually recovers within a few cycles and in an unlucky pattern might not.
  Saying "it recovers" without that caveat would be claiming more than the mechanism delivers.
