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
