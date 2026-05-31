# Short-circuit remote placement — explain it like I'm 16

Two computers act as one assistant. When you say "move this conversation to the Mac
mini," the laptop is supposed to hand that conversation off so the mini takes over.

Here's how a message gets handled when the feature is on. Every incoming message
goes to a "router" that decides: should I handle this here, or send it to the other
machine? The router gives back a one-word answer about what it did:
- "forwarded" / "duplicate" → I sent it to the machine that owns this conversation.
- "spawned" → this conversation had no owner yet, so I picked a machine, claimed it,
  and started it up THERE.
- "handled-locally" → I'm keeping it right here on this machine.
- a few others (queued, blocked).

The bug: the code that reads the router's answer only knew to "stop and not also
handle it here" for the answers "forwarded" and "duplicate." But when you MOVE a
conversation, the router picks the mini, claims it, and answers "spawned" (start it
on the mini). The reading code didn't recognize "spawned" as "it went to another
machine," so it ALSO shoved the message into the old session still sitting on the
laptop. Result: the conversation got started on the mini AND kept being answered on
the laptop — so from your side, the move looked like it did nothing; the laptop just
kept replying.

The fix is small and precise. I wrote one tiny pure function,
`isRemotelyHandled(answer, me)`, that knows the full rule: "forwarded"/"duplicate"
always mean it left this machine; "spawned" means it left this machine UNLESS the
machine it picked is me; same idea for one other answer ("owner-dead-replaced").
Everything else means "handle it here." The reading code now just asks that
function. Because it's a separate little function, I could write tests that check
every possible answer — including the tricky case where I don't even know my own
machine name yet (in which case I play it safe and handle locally, so a message is
never silently dropped).

I also added one log line that prints, for every message, what the router decided
and which machine owns it. Before, that decision was invisible — the live test
could see the "move" command land but had no idea what the router did next, which
is exactly what hid this bug. Now the next live run can see it plainly.

To be clear about what this does and doesn't do: it stops the double-handling so a
moved conversation actually leaves the laptop. It does NOT yet fix the separate
problem that the mini has no way to send Telegram replies back to you (that's a
different piece I'm tracking). So this is one rung of the ladder, with the next rung
clearly in view.
