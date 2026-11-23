# Unroutable-owner release — plain-English overview

## What this change is

When an agent runs on several computers, every conversation (a Telegram topic, for
example) is "owned" by exactly one of them. Messages for that conversation are sent to
its owner. This change makes sure a conversation never stays owned by a computer that
can never answer again.

## What went wrong

On 2026-11-20 the operator's Mac Studio was wiped and set up again. It came back with a
brand-new identity. Around seventy conversations, including the operator's Chief of
Staff conversation, were still recorded as owned by the old identity. The old identity
had been cancelled ("revoked") on some machines and was simply unknown on the rebuilt
one. So every message the operator sent in those conversations was routed to a computer
that no longer exists. All the operator saw were automatic "your message didn't reach
the session" notices. Three separate safety mechanisms each refused to fix it:

- The automatic "dead owner" recovery wanted proof of death by trying to contact the old
  computer over each of its network addresses. A cancelled identity has no addresses, so
  the proof never arrived and it waited forever.
- The message router tried to re-assign the conversation with a step that is only
  allowed for unowned conversations, so the message was parked forever.
- The manual "move this conversation" command could not move it either.

## What already exists

A careful recovery system for owners that are merely offline: it waits several minutes,
probes the machine on every network route, checks that a majority of machines agree,
and only the machine holding the "serving lease" (the one in charge) may take over.

## What is new

A small shared rule that says when an owner can never be reached: its identity is
revoked, or it is unknown to this machine's list of machines and its activity log has
been silent for at least six hours (never decided in the first nine minutes after a
restart, and never when the list of machines itself cannot be read). When that is true:

- the recovery system treats the owner as gone without waiting for probes that can never
  succeed, and acts even while that system is still in its trial ("dry run") mode;
- the router, when a message arrives, takes the conversation over on the machine in
  charge and delivers the message there;
- the manual move command works and reports truthfully that the conversation moved.

It also fixes a bug where the recovery system read the activity log with the wrong key
and always saw "no activity" — that made it less careful than intended.

## Safeguards

Only the machine holding the serving lease can take a conversation over. Every takeover
goes through the same versioned ownership record as before and is written to the shared
log that the other machines copy. Unknown identities with no activity record at all, or
with recent activity, are left alone. Any error reading the evidence means "do nothing
new". A switch turns the dry-run exception off if needed.

## What the reader needs to decide

Nothing beyond approving the change: it is reversible by reverting the code, needs no
data migration, and only acts where conversations were otherwise stuck forever.
