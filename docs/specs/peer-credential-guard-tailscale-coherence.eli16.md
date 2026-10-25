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

---

## Update, 22 October 2026 — the second half, and a mistake I made

### What actually shipped first, and what didn't

The first change shipped the *choosing* — walk the roads, skip the ones the security check
refuses, take the best one that is allowed. It did **not** ship the *learning* — writing down
which roads turned out to be dead so they stop being chosen. The spec described both as though
they shipped together. They didn't, and the tests all passed because they test the choosing and
never the learning.

The learning half now exists. Every cross-machine read goes through one piece of code that
notes what happened and tells the same shared memory the rest of the system already uses. So a
road that dies gets demoted, and a road that comes back gets its place back.

One detail worth stating because the obvious version would be wrong: a reply that comes back
counts as the road *working*, even when the reply is an error. The road carried the message;
the machine at the other end simply disagreed with the request. Had errors counted against the
road, every machine answering "that feature is switched off" — which is most of them, most of
the time — would have slandered its own perfectly good road.

### The mistake, because it changes what the first half is credited with

While checking the learning half, I tested the already-shipped code against the real machines
and concluded the first half had **not** fixed the problem. I told the operator that. **I was
wrong**, and the fault was in my test rig, not the code.

I built the road-chooser by hand and left out two settings the real server always supplies:
one that only considers another machine's local address when we are actually on that same
local network, and one that says how many failures make a road count as dead. Without the
first, I was offering the chooser a local address no real server would ever consider. Without
the second, *no road could ever be marked dead at all* — the comparison was against a missing
number, which is never true.

Run with the real settings, the shipped code picks the tunnel for all three machines — the
road I had measured as alive — and correctly names the refused one. So the first half does fix
the reported problem, and it fixes it for a reason I had not credited: the same-network rule
removes the dead local road before the chooser ever sees it.

This is the oldest trap in the book — a broken measuring stick looks exactly like a broken
thing being measured — and the expensive part was not the mistake but reporting it before
checking it.

### So what is the learning half actually for?

Not the reported problem; that is already fixed. It is for the case the same-network rule
cannot help with: two machines *on the same desk*, sharing a network, where a local address is
a genuine candidate. If that road dies, nothing today tells the chooser to stop picking it. Now
something does.

That is also why its main test puts the reader on the same network as the peer. Testing it with
the real machines' addresses would have passed against the broken code too — the same trap,
wearing a test's clothes.
