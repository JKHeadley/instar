# Machine-Coherence Guard — plain-English overview

**Companion to:** `docs/specs/machine-coherence-guard.md` (roadmap item 4.1,
round-3 revision)

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
ships in code, so it's the same list everywhere — and a build-time check stops
the list from quietly growing past its size limit, or a new must-match setting
being added without a deliberate decision). A comparator looks at the cards
from every online machine and, if they disagree, raises **one single alert**
that leads with what it means for you ("my machines have drifted apart —
conversation-moves between them will silently fail"), names which machine
differs, and proposes a fix **that I perform if you approve it** — you reply
"fix it" and I equalize the setting and restart that machine myself. You're
never handed a config command to run.

**The fix has guardrails of its own.** Only YOU can approve it — the approval
only counts from the verified owner of that conversation, and it's tied to
the exact proposal you were shown (if the situation changes, I re-propose
rather than act on a stale yes). The proposal always says which machine gets
changed, to what value, and why that direction (match the majority, or match
the machine currently in charge) — a one-word "fix it" can never flip
something in a direction you weren't told. Two switches are never auto-fixed:
the master "this is my dev machine" switch (it changes dozens of things at
once) and the watchdog's own on/off state — for those I show you the
difference and ask which way you want it. The change is always made ON the
divergent machine by my own hands there — there's no remote-rewrite channel
between machines, on purpose. And if the fix doesn't take, I say so once and
keep the alert open — the alert only ever closes when the machines are
OBSERVED agreeing again, never because a fix claims it worked.

**Exactly one machine speaks.** Both machines run the comparator, but they
hold a quick deterministic election (the one currently "in charge" wins;
otherwise the alphabetically-first live one) so exactly ONE machine raises the
alert. Without that, every machine would confirm the same problem and you'd
get two identical alarms for one issue. Two backstops keep that honest: each
machine's heartbeat card now also says "I'm currently holding an open alarm
about X" — so if the machine that WON the election is quietly broken (its
alarm-sending arm is dead even though its heartbeat looks alive), the others
notice the missing "I raised it" marker within about five minutes and the
next machine in line steps up and raises it instead. And if a weird moment
ever produces TWO alerts for the same problem (a network split, a laggy
view), the machines spot each other's markers and one of them politely
withdraws its copy, labeled honestly as superseded — never two alarms dueling
for days.

**The alert never lies about being fixed.** If the differing machine simply
goes to sleep (a laptop overnight), the alert doesn't declare victory — it
notes "the divergent machine went offline, holding this open" and waits. It
only says "restored" when both machines are actually back and actually agree.
If the same problem flaps on and off, it re-opens the SAME alert instead of
minting new ones; after three flaps it says "this is flapping — recording
quietly until it stabilizes" and stops narrating each bounce. And there's a
hard cap of three new alert topics per day — past that it records quietly
and tells you once that it's capped. The flap/cap bookkeeping is saved to
disk, so a restart (which is exactly when settings flap) can't wipe the
brakes.

**Trust rules for the heartbeat cards.** A card from another machine is
untrusted data: it's size- and type-checked on receipt, a malformed card makes
that machine show up as "can't verify coherence" (loudly — malformation can't
buy silence), and a card that's gone stale (the machine is alive but its
card-carrying channel is down) is treated as unknown rather than read as
current truth. During a normal rolling software update, the watchdog
deliberately holds its tongue (45-minute grace) so auto-updates don't cry
wolf.

**Fix the "zero machines awake" read-out.** Today that number comes from a
sticky note each machine wrote about itself long ago (and a read error
silently shows as 0). The fix has each machine remember, per peer, the
freshest "I hold the lease" claim it actually heard from that peer's own
mouth (an expired or second-hand claim doesn't count), and the count derives
from that live view — with a tag saying which source spoke. If it genuinely
can't tell, it says "unknown" instead of lying with a zero. The `instar
doctor` command learns the same honesty: it shows both the live count and the
old sticky-note count, labeled, so they can't silently disagree.

**Not in this build:** actually coordinating updates (one machine acting as
the "version owner" that rolls updates through the fleet in a safe order).
That's sketched as Phase 2 because it restarts other machines — an action that
needs its own permission story, not a rider on a watchdog.

## Safety posture

Watch-and-report only. It never blocks anything, never edits a config on its
own, never restarts anything on its own — the only action anywhere in it is
the fix you explicitly approve per alert. It ships OFF for everyone except my
development setup, and even there it starts in rehearsal mode (it logs what it
WOULD alert, sends nothing) until a soak proves it doesn't cry wolf — the soak
must include at least one real software-update wave passing with zero false
alarms. On a one-machine setup it does nothing at all. If the watchdog itself
hits an error, it stays silent and counts the error — a broken alarm must not
become its own flood. The only part that ships live for everyone immediately:
the heartbeat card itself (so a machine that hasn't enabled the watchdog can
still be SEEN by one that has), and the honesty fixes to the awake-count
read-out (correcting a lying number isn't a new behavior).

## The decisions, made (formerly open questions)

Round 1 required every parked question to be decided. Plain-English record:

1. **What counts as "must match"?** What each machine is EFFECTIVELY doing
   after all defaults resolve — so "one machine is marked as my dev machine
   and the other isn't" is itself always an alarm. The starting list stays as
   drafted (including the mesh-transport switch); per-machine-by-design
   things like subscription seats are deliberately excluded, with the
   exclusion written down.
2. **How fast?** Two consecutive 30-second checks (~a minute to alarm) — the
   steadier house pattern. The roadmap's "within one heartbeat" is restated
   honestly as "within two". The 45-minute update-grace stays, and also
   covers machines that haven't sent a card yet.
3. **Where does the card live?** Its own new card. The existing card it could
   have piggybacked on has machinery depending on its exact shape — not worth
   the risk.
4. **Where does the alert land?** A high-priority alert topic — this is
   something you'd act on, not housekeeping. (And honestly noted: this alert
   class is exempt from the platform's topic-flood budget, which is exactly
   why the watchdog carries its own re-open damper and daily cap.)
5. **The health number's new shape.** It can now be "unknown" instead of a
   fake 0, with a source tag. Everything that reads the old shape — tests,
   my own docs on both machines, the doctor command — is updated in the same
   change.
6. **How seriously to treat the watchdog being off?** In version one, being
   off on the fleet is normal (it ships dark), so it's NOT flagged as a
   critical unguarded gap — that would false-alarm on every fleet machine.
   Revisited when Phase 2 starts depending on it.
7. **How long is the rehearsal?** At least five days on my dev pair with zero
   false alarms, AND at least one real update wave observed passing cleanly,
   AND one deliberately-injected fault correctly caught.

## How we'll know it works (the live proof)

On the real two-machine pair: deliberately flip one guarded setting on one
machine — one alert (from one machine only) should name it within about 90
seconds; flip it back — the same alert resolves itself with a "restored"
marker. Put the divergent machine to sleep overnight mid-alert — no false
"restored", no fresh alarm topic in the morning. Then re-run the exact
conversation-move scenario that failed on July 2nd: on a healthy pair the
watchdog stays silent and the move just works with nobody hand-editing
configs; with the old asymmetry re-introduced, the watchdog names the problem
before the move is even tried. And the health read-out shows the true
awake-machine count through a failover — transiently "unknown" is honest,
a silent zero is the bug.
