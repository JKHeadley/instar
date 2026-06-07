# One dashboard for every machine — the plan

## What you asked for

Right now your dashboard lists sessions from all your machines, but you can only
click into and watch the ones running on the SAME machine you opened the
dashboard on. A session on the Mac mini, viewed from the laptop dashboard, is a
dead tile. You said: everything should be in one dashboard, and this isn't
scalable. Agreed.

## The plan, in plain terms

Teach the dashboard to fetch the live terminal stream from whichever machine
actually has the session — quietly, in the background — so you click any tile
and it just streams. You never have to know or care which machine it's on.

Three things the design pins down (after three independent reviewers — one for
security, one for scale, one for honest-screens — picked the draft apart):

1. **Watching is on everywhere; TYPING into a remote machine is off by default.**
   Reading a remote terminal is safe. But letting one machine send keystrokes to
   another is a real security risk (a compromised machine could type commands
   into a clean one). So remote viewing works out of the box; remote typing is a
   deliberate per-machine opt-in.

2. **The machine-to-machine link uses a one-time, short-lived pass.** Instead of
   one login that stays valid for the whole connection (which a thief could
   replay), each stream gets a fresh pass that expires in under a minute and
   can't be reused — even across a restart.

3. **Every screen state tells the truth.** Offline machine → the tile says
   "unreachable," not a frozen black box. Stream drops → "reconnecting…", then
   either it recovers or it honestly says "lost." Typing where typing is
   disabled → you see why, never a silent swallow. Session moved to another
   machine while you watched → "moved to <machine>," not a confusing "ended."

It's also built to scale: the heavy work (capturing each terminal) stays on the
machine that owns the session; your dashboard just receives the picture. Adding
more machines doesn't multiply the cost.

## Where this is

The design is written and reviewed. Building it is the next phase — it's a real
feature (a new streaming relay, the secure pass, and the dashboard screens for
every state), so it goes through the full build-and-test pipeline like everything
else, not a quick patch. I've registered it so it doesn't get lost.

## Phase 2a shipped — the serving side (the machine that HAS the session)

The machine that owns a session can now safely hand its live terminal to another of your machines. When your laptop wants to watch a session running on the Mini, it first asks the Mini (over the already-secure machine-to-machine channel) for a one-time pass. The Mini hands back a single-use ticket that expires in a minute and can't be reused — even if the Mini restarts in between. The laptop opens a streaming connection to the Mini using that ticket; the Mini checks it once, then streams the terminal.

Two safety rails are live and tested: typing into a remote machine's session is OFF by default (you opt in per machine), so by default another machine can only WATCH, never type; and a session name is checked against a strict safe-character list and confirmed to actually be running before anything touches the terminal — so a malformed or made-up name can never reach the machine's shell. Six real end-to-end tests prove all of this over actual sockets (valid ticket streams, bad ticket rejected, ticket can't be reused, typing blocked by default, typing works when enabled, malformed name refused). Still to come: the laptop side that opens these connections automatically when you click a tile (phase 2b) and the on-screen states (phase 3).

## Phase 2b shipped — the requesting side (the dashboard machine)

Now the other half: when you're on the laptop dashboard and click a session that's running on the Mini, the laptop quietly opens a stream to the Mini (using the one-time pass from phase 2a) and shows you the live terminal — you never think about which machine it's on. One connection per peer machine is shared by everything you're watching on it (efficient), and every frame the laptop sends you is tagged with which machine it came from, so the screen can show you. Typing is relayed to the Mini, which decides whether to accept it (off by default). If the link drops, you get an honest "reconnecting / unreachable" instead of a frozen screen. Proven by a real end-to-end test: two machines, real sockets, a browser subscribing to a remote session and getting the live output back. Last piece is the on-screen polish (phase 3): making the remote tiles clickable and drawing the status badges.
