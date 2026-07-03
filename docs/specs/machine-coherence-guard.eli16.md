# Machine-Coherence Guard — plain-English overview

**Companion to:** `docs/specs/machine-coherence-guard.md` (roadmap item 4.1)

## The problem, in one story

I run on two machines — the Laptop and the Mini — and I'm supposed to be ONE
agent across both. On July 2nd we caught them being subtly different people:
one machine had a feature switched on that makes conversation-moves work
across machines, and the other machine had it off. Nothing was broken loudly.
You asked me to move a conversation to the Mini, I said "on it" — and the move
silently never happened, forever, with no alarm anywhere. A human had to dig
through logs to find out why, and then hand-edit a config file to fix it.

The same audit found two more flavors of the same disease: nothing checks that
both machines run the same VERSION of my software (that night they matched only
because someone updated both by hand), and the health read-out that's supposed
to say "how many machines think they're in charge?" said **zero** while both
machines were online and one was clearly in charge.

## What this build does

**A watchdog for "are my machines the same me?"** Every 30 seconds my machines
already send each other a little status heartbeat. This build adds a small,
fixed-size card to that heartbeat: my software version, and the on/off state of
the dozen-or-so settings where the two machines genuinely must agree (the list
ships in code, so it's the same list everywhere). A comparator looks at the
cards from every online machine and, if they disagree, raises **one single
alert** that names exactly which setting differs, on which machine, what it
quietly breaks, and the one-line fix. When the machines agree again, the same
alert marks itself resolved. If it stays broken for a day, you get exactly one
reminder — never a stream of nagging.

**Fix the "zero machines awake" read-out.** Today that number comes from a
sticky note each machine wrote about itself long ago (and a read error silently
shows as 0). It moves to the live source of truth — who actually holds the
serving lease right now — and if it genuinely can't tell, it says "unknown"
instead of lying with a zero.

**Not in this build:** actually coordinating updates (one machine acting as
the "version owner" that rolls updates through the fleet in a safe order).
That's sketched as Phase 2 because it restarts other machines — an action that
needs its own permission story, not a rider on a watchdog.

## Safety posture

Watch-and-report only. It never blocks anything, never edits a config, never
restarts anything. It ships OFF for everyone except my development setup, and
even there it starts in rehearsal mode (it logs what it WOULD alert, sends
nothing) until a soak proves it doesn't cry wolf. On a one-machine setup it
does nothing at all. If the watchdog itself hits an error, it stays silent and
counts the error — a broken alarm must not become its own flood.

## The open questions — your call, stated simply

These are the decisions the reviewers (and ultimately Justin) should weigh in
on. You should not need to open the technical spec to decide any of them:

1. **What counts as "must match"?** The draft says: compare what each machine
   is EFFECTIVELY doing (after all defaults resolve) — which means "one
   machine is marked as my dev machine and the other isn't" is itself always
   an alarm. Is that right, or is there ever a legit reason one of my
   machines should resolve features differently? And is the starting list of
   compared settings right — anything to add or drop?
2. **How fast should the alarm fire?** Two consecutive 30-second checks
   (alarm within ~a minute, steadier) or one check (alarm within 30 seconds,
   which is what the roadmap literally promised, but a bit twitchier)? Also:
   is 45 minutes the right patience window before version differences alarm,
   so normal rolling auto-updates don't cry wolf?
3. **Where does the new heartbeat data live?** In its own new card (the
   draft's choice — cleaner, one more field on the wire) or crammed into an
   existing card that other machinery already relies on (riskier)?
4. **Where does the alert land?** Its own high-priority alert topic (the
   draft's choice — this is something you'd act on) or the quieter "agent
   health" digest lane (calmer, but easier to miss)?
5. **The fixed health number.** "How many machines are awake" becomes
   honest — it can now say "unknown" instead of a fake 0. Does anything you
   use (dashboard, doctor, scripts) break if that field can be null, or
   should we keep a compatibility zero plus a truth-tag next to it?
6. **How seriously should the system treat the watchdog itself?** Should
   "the coherence watchdog is off" itself count as a critical unguarded gap
   (loud), or is that circular for a watch-only feature in version one?
7. **How long is the rehearsal?** The draft says: five days on my dev pair
   with zero false alarms before it may actually send alerts. Long enough?
   Too long?

## How we'll know it works (the live proof)

On the real two-machine pair: deliberately flip one guarded setting on one
machine — one alert should name it within about a minute; flip it back — the
same alert resolves itself. Then re-run the exact conversation-move scenario
that failed on July 2nd: on a healthy pair the watchdog stays silent and the
move just works with nobody hand-editing configs; with the old asymmetry
re-introduced, the watchdog names the problem before the move is even tried.
And the health read-out shows the true awake-machine count through a failover,
never a silent zero.
