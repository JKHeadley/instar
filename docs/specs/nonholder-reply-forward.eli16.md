# ELI16 — Why one of my machines went quiet for twelve hours, and the fix

## What this is about

When I run on more than one computer, exactly one of them holds the "serving
lease": the badge that says "I'm the one allowed to send Telegram messages
right now." The others can still own conversations and do work in them, but
when they want to reply to the user, the rule is: hand the reply to the
badge-holder, who sends it. That hand-off is called forwarding to the holder.

On 2026-10-21 the Windows machine (the Mama PC) owned a conversation with
Justin, did real work in it for hours, and none of its replies reached him.
Its own records said every reply was "held — I don't hold the lease", which is
supposed to be the state you land in only after a forward attempt FAILS. But
no forward attempt had ever been made. The Studio — the badge-holder — had
logged zero incoming forwards from the Mama PC the whole time.

## What was actually wrong

The forwarding code was fine. The code that decides WHETHER to forward had a
shortcut in front of it:

> If the multi-machine "session pool" feature is still switched off (its
> default), just send the reply directly.

"Send directly" is the right answer on a single machine. On a machine that
does not hold the lease, "send directly" is always refused — the sending code
checks the badge and holds the message. So on any agent that has not turned
the session pool on (which is most of them, including this one), a non-holder
machine could never speak: the shortcut picked the one route that is
guaranteed to fail, and never looked at the route that would have worked.

The shortcut existed for a good reason: when the lease is in flux (nobody
holds it yet, or the holder isn't known to be healthy), the forward path waits
up to fifteen seconds for things to settle before deciding. On an agent that
hasn't rolled the pool out, that wait is pointless, so the shortcut skipped it.
It just skipped too much.

## What changed

The decision now has three answers instead of two, and checks the lease
before checking the pool switch:

- I hold the lease → send directly (unchanged).
- Another machine holds the lease and it is healthy → forward to it. Always.
  The pool switch no longer matters here, because a confirmed holder is a
  fact, not a rollout stage.
- The lease is in flux → keep the old behaviour: pool off, send directly (no
  wait); pool on, wait for it to settle.

The replies the Mama PC held were not lost — they sat in its durable queue
and went out when the lease later moved to it. The fix means they would have
gone out at once, through the Studio.

## Two small things fixed alongside it

**The stray "." messages.** To learn a topic's name, I send a tiny probe
message ("."), read the name off the reply, and delete the probe. On a
machine that should be forwarding, that probe is itself a direct send, so it
gets held — and later replayed into the topic as a lone ".". The probe now
simply isn't attempted on a forwarding machine; the name I already have on
file (or a placeholder) is used instead.

**"Restart failed" when the restart worked.** After restarting a conversation's
session, I post "Session respawned." in the topic. On the muted machine that
post was held, the hold was reported as an error, and the restart was
reported as failed — so the caller restarted it again, which is where the
duplicate sessions came from. The notice is now best-effort: if it can't be
sent, that is logged, and the restart is still reported as the success it
was.

## What you need to decide

Nothing. There are no new settings. The existing per-agent switch that turns
forwarding off (`messageOrigin.forwardToHolder.enabled`) still works and
still returns a machine to the old "send directly" answer if that is ever
wanted. Single-machine agents are unaffected: with no other machine to hold
the lease, the decision is always "send directly", exactly as before.

## How it was checked

The decision table is now a small named function with a test for each row,
including the exact case that bit us: pool off, another machine holds the
lease → forward. The probe guard has a test on each side (a forwarding
machine never sends the probe; a direct-sending machine still does). The 51
existing tests for forwarding, holding and recovery pass unchanged.
