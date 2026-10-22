# Plain-English overview — stop telling you a message will be retried when it won't

## What happens today

When your agent writes you a reply and can't send it, it keeps the reply and
raises a notice telling you so. That notice says, among other things, that the
reply "is held durably and retried on the recovery schedule."

For one of the two ways a reply can get stuck, that sentence is false.

## The two ways a reply gets stuck

Your agent can run on several machines, but only one of them at a time holds the
right to speak on Telegram. If a reply is written on a machine that doesn't hold
that right, one of two things happens.

**Either** the reply gets handed to the machine that does hold it. If the handover
fails, the reply is kept and retried — genuinely, repeatedly, and it often gets
through in the end. For this kind, the notice is accurate.

**Or** the reply was already sealed by the machine that wrote it before the
problem was noticed. A sealed reply is bound to the machine that sealed it — that
binding is what lets anyone later prove which machine said what — so it *cannot*
be handed to another machine. There is nothing to retry. It waits for the right to
speak to come back to its own machine, and if that never happens, it is deleted.

Both kinds currently get the same notice, promising a retry that only one of them
receives.

## Why that matters more than it sounds

The measurements on one agent: of 152 replies stuck the second way, **none were
ever retried and 133 were deleted undelivered**. Some had been waiting eleven
days. Every one of them had produced a notice saying it was being retried.

So the operator was told, accurately, that a message was stuck — and then told,
inaccurately, that the system was working on it. The reasonable response to "held
and retried" is to wait. The reasonable response to "this cannot be sent unless
the lease comes back" is to do something about the lease.

The notice was quietly steering toward the wrong one.

## What changes

Only the words, and only for the kind that isn't retried. That notice now says the
reply cannot be forwarded, is not retried, and will expire unless the right to
speak returns to this machine.

Nothing about delivery changes. The same replies get stuck, the same ones expire.
The difference is that the operator is no longer told a retry is coming when it
isn't.

## What this does NOT fix

The underlying problem — that a machine can hold a conversation it has no right to
answer in — is untouched, and is a genuine design question with no small answer.
This change makes the failure legible, not rare.

## What a reader has to decide

Whether "say the true thing about a failure you cannot yet fix" is worth a change
on its own. The argument for is that an operator acting on a false promise is
worse off than one acting on an honest limit, and this costs nothing but words.
