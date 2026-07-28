# Post-Transfer Closeout Correctness — the ELI16 version

## What's the machine actually doing here?

I'm one agent that runs on more than one of Justin's computers — the Laptop and
the Mac Mini. A "topic" is one conversation (one Telegram thread). At any moment
that conversation lives on exactly one machine, and the others should NOT keep a
worker running for it — a leftover worker would do duplicate work, or worse,
answer the same person twice.

So there's a janitor inside the reaper called the **post-transfer closeout**.
Its job sounds simple: "if a topic moved to another machine, close the leftover
session here." When a conversation genuinely moves from the Laptop to the Mini,
the Laptop's old session for it is a leftover and should be shut down.

## What's broken

The janitor decides "should I close this session?" by reading ONE thing: a local
record that says which machine *owns* the topic. If that record says "the Mini
owns this," the janitor — after a short wait — kills the local session.

The problem: **that ownership record can be stale and lie.** It can say "the Mini
owns this topic" when, in reality, the Mini has NO live session for that topic at
all (its session finished, or never materialized after a failover). Meanwhile the
ONLY machine actually doing the work for that conversation is... the local one the
janitor is about to kill.

Nothing in the janitor checks "wait — does the machine I think owns this actually
have a live worker for it?" It just trusts the ownership label. So on a real
multi-machine setup, the closeout can terminate the one live worker for a topic
because a stale label pointed elsewhere. The user's conversation goes dead.

There's a safety net — a "circuit breaker." If the kill keeps getting blocked
(because the session is busy with a recent message), the breaker eventually gives
up and raises an alert: *"Topic N moved to X, but the old session won't close."*
Justin saw exactly that alert. But notice: the breaker is treating "won't close"
as the problem to escalate — when the real problem is that the janitor never
should have been trying to close a LIVE worker in the first place.

There's also a smaller bug. The breaker counts failed attempts per *session id*.
When a session restarts, it gets a brand-new id, so the count resets to zero. That
means the breaker takes far longer to trip than it should — about 32 minutes
observed instead of the intended ~10.

## What this spec changes

Three tightly-scoped fixes, all in the reaper and its wiring, all hidden behind a
new off-by-default config switch so nothing changes for anyone until it's
deliberately turned on for a dev machine to dogfood.

**Fix 1 (the load-bearing one): ask before you kill.** Before the janitor acts on
a "topic moved away" closeout, it now asks a new question: *"Does the machine that
supposedly owns this topic actually have a live worker for it right now?"* It gets
this answer from the real cross-machine signal the dashboard already uses — each
peer machine's list of its own running sessions, each tagged with its topic. The
wiring layer keeps a fresh snapshot of "which topics have a live worker on which
peer." Then:

- If the supposed owner DOES have a live worker → it really is a duplicate → close
  the leftover. (Same as today.)
- If the supposed owner has NO live worker → the local session is the only one
  doing the work → **do NOT kill it.** Hold off, and nudge the stale ownership
  record back toward "this machine owns it."
- If we can't tell (the snapshot is missing, the peer is unreachable, the answer
  is "unknown") → **do NOT kill it.** When in doubt, never kill a live local
  worker. This is the whole point — the bug came from acting on uncertainty.

That "when in doubt, don't kill" rule is the heart of the fix. The old code killed
on a guess; the new code refuses to.

**Fix 2: let a REAL leftover actually shed.** There's a flip side. When the move is
genuine (Fix 1 confirmed the owner has a live worker), the leftover here is truly
redundant — but a different guard ("this topic got a user message recently") can
block its closure forever, because a message that arrived just before the move
still looks recent. So for a *confirmed-genuine* move only, the closeout marks its
kill as an operator-grade action so it overrides that recent-message guard. This
override is granted ONLY in the confirmed-genuine case — never in the stale case,
never in the unknown case. Those still refuse to kill, full stop.

**Fix 3: make the breaker count survive a restart.** The breaker now counts
attempts keyed to the *topic*, not the throwaway session id, so a session restart
no longer resets it. The breaker trips on schedule instead of taking three times
too long.

## Why it's safe

- The actual kill still goes through the same guarded authority it always did. This
  spec only changes the *decision to attempt* a kill — it never punches a new hole
  in any safety guard. (The Fix 2 override is the existing operator-grade path,
  used narrowly and only when liveness is confirmed.)
- Every uncertain case fails toward *keeping* the live session. The failure
  direction is always "don't kill," which is the safe direction.
- It all hides behind a new switch that defaults OFF. With the switch off, the
  reaper behaves byte-for-byte like today. A dev machine can flip it on to dogfood
  before it ever ships to the fleet.

## What this spec deliberately does NOT do

The broader cleanup — releasing ownership the instant a session completes,
claiming ownership the instant a session spawns, and a recovery gate for
double-dispatch — is real work, but it's a SEPARATE follow-up. This spec fixes the
one dangerous behavior (killing a live worker on stale ownership) without trying to
boil the whole multi-machine-ownership ocean. Keeping it tight is the point.
