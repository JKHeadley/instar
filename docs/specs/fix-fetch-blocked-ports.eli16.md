# ELI16 — Don't put an agent on a "bad port"

## The one-sentence version

Some port numbers are secretly off-limits to the web-request function our agents
use to talk between machines, and we were accidentally allowed to assign one of
them — so an agent could end up on a port where it silently can't be reached by
the rest of the fleet. This stops that.

## What's actually going on

When two of our agents on different machines talk to each other — to pair up, to
agree on who's "in charge" (the lease), to send heartbeats — they use the
built-in `fetch` function in Node.js (the same thing a browser uses to load a
URL).

It turns out `fetch` has a little-known safety rule baked into the web standard:
it **refuses** to connect to a short list of "bad ports." These are ports
historically tied to other system services (for example, port **4045** is the
old NFS file-lock service). If you ask `fetch` to talk to `http://something:4045`,
it doesn't even try — it immediately fails with the cryptic error
`fetch failed: bad port`.

Here's the trap: the normal way *we* picked a port for a new agent was "start at
4040 and count up to 4099, grab the first free one." But **4045 is inside that
range** and **4045 is on the bad-ports list.** So an agent could legitimately get
assigned port 4045 — and then quietly be unable to join any mesh, because every
other machine's `fetch` to it bounces off the bad-port rule. And it's *invisible*,
because ordinary tools like `curl` don't follow that rule — `curl` to the agent
works fine, so everything *looks* healthy. We hit this for real: a test agent on
4045 simply could not be paired, no matter what, until we moved it.

## What we changed

Two small things:

1. **The port picker now skips bad ports.** When allocating a port for a new
   agent, we step over anything on the WHATWG bad-ports list (4045 and friends),
   exactly like we already step over ports that are taken. New agents can never
   land on a port the mesh can't reach.

2. **A loud warning for any agent already on a bad port.** The port-picker fix
   only helps *new* agents. If an existing agent is already sitting on 4045 (from
   before this change, or set by hand), it would still be silently unreachable —
   so on startup we now print a clear warning telling the operator to change the
   port. We don't auto-change it, because silently moving a running agent's port
   could surprise things; a loud nudge is safer.

## Why it matters

Multi-machine only works if machines can actually reach each other. A silent
"can't be reached" failure on a handful of unlucky port numbers is exactly the
kind of gremlin that wastes hours (it wasted ours). Now the failure mode is
designed out for new agents and surfaced for old ones.
