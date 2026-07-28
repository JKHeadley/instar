# WS5.3 Escalation Rides the Topic — ELI16

## What is this?

Your agent can run heavy work — designing a spec, building a feature, a long autonomous run — on
a bigger, more expensive AI model ("escalated" to Fable) for a while, then drop back to the normal
model when the heavy work is done. That bigger-model state is tied to the exact running session.

Now suppose that conversation is moving from your laptop to your Mac mini (you said "move this to
the mini", or a machine went to sleep and it failed over). When the mini picks the conversation
back up, it starts a BRAND-NEW session — and the bigger-model state, which was tied to the OLD
session, silently vanished. So your heavy work suddenly continues on the smaller model, mid-task,
without anyone noticing. WS5.3 fixes that.

## How does it work?

When a topic that is currently on the bigger model gets moved, the machine it's leaving writes
down a tiny note: "this topic was running escalated." That note rides along with the move (over
the same secure machine-to-machine channel the topic's settings already travel on). When the new
machine resumes the conversation, it reads the note and asks ITSELF: "should this session be on
the bigger model?"

The crucial word is **asks**. The new machine does not just flip the session to the bigger model
because the note said so. It runs the exact same cost checks it would run for any fresh request to
use the bigger model — is there quota headroom? am I already running too many big-model sessions?
is the hourly budget blown? has enough time passed (anti-flapping)? — and only escalates if ALL of
those pass. If any check says no, the session simply runs on the normal model. Same as if the
request had been refused from scratch.

So the note is a **reason to re-decide**, never a free pass.

## Why does that "asks, never grants" rule matter so much?

Because the alternative would be a money leak. If a moved topic could carry its "I'm escalated"
state straight onto the new machine WITHOUT re-checking the new machine's budget, then you could
bounce a conversation around your machines and rack up bigger-model usage that none of the
per-machine guards ever caught. Every machine has its own budget; the move has to be re-priced
against the machine it lands on. That's the whole safety story, and it's the one thing we proved
with a dedicated test: when the cost checks refuse, the session lands on the normal model — never
the bigger one.

## What if the topic is set to "never use the big model"?

If you've pinned a topic to "don't escalate this one" (`escalationOverride: suppress`), it stays
that way across a move. The leaving machine writes NO note for a suppressed topic, and even if a
note somehow arrived, the new machine re-checks the suppress pin before escalating. Two guards, on
purpose.

## Is anything turned on right now?

No. This ships dark, off by default, behind a flag (`models.tierEscalation.ridesTopic`) that
itself only matters if the whole escalation feature is turned on (which is also off by default on
the fleet). On a single-machine agent it does nothing at all (there's nowhere to move a topic to).

## Is it safe? (The four things we checked.)

1. **No free escalation (the big one)** — the new machine can NEVER end up on the bigger model
   without its own cost checks passing. The note only decides whether to ASK; the answer always
   comes from the guards. Proven with a named test: refused checks → normal model.
2. **A stale or lying note can't do harm** — the note's "trigger" label is just for the audit log;
   the new machine re-decides from its own real state, so a note claiming something untrue still
   has to pass every real guard. An old note simply expires and is ignored.
3. **No escalate-flapping** — bouncing a topic between machines can't reset the anti-flap timer to
   keep re-escalating; the new machine's normal dwell/time guards apply to the resumed session like
   any other.
4. **Suppress and "I'm full" both land on the normal model** — a "never escalate" topic and a
   machine already at its big-model limit both correctly run normal. The move degrades gently; it
   never strands a session on the wrong tier or smuggles escalation across.

## Open questions (so you don't have to read the spec to decide)

- **The note carries a generic label, not the exact original trigger.** When the leaving machine
  writes the note, it stamps a generic "transfer" label rather than the precise reason the session
  was escalated (build vs autonomous vs instar-dev). That's because the live trigger isn't recorded
  per-session today, and the new machine re-decides from real state anyway — so the precise label
  would only make the audit log prettier, it's not load-bearing. Recovering it is tracked as a
  follow-up (CMT-1416). **Decision for you:** is shipping with the generic audit label fine? (The
  build assumes yes, per pre-approval.)
- **The placement tie-breaker is still deferred** (inherited from WS5.1, CMT-1416): when two
  machines are equally good hosts, preferring the one with more quota headroom is a separate,
  larger piece and is NOT part of this slice.
- **WS5.2 (account follow-me) is a separate surface** — this slice is only about the big-model
  state following a moved topic, re-checked under the destination's guards.
