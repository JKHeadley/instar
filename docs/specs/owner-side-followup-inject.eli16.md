# Don't let a moved conversation duplicate itself on every reply — explain it like I'm 16

When you move a conversation from the laptop to the Mac mini, the mini takes over and
starts the conversation. Good. But then you send a SECOND message — a normal follow-up
like "ok, now do the other thing." That message still arrives at the laptop (the laptop
is the one connected to Telegram), and the laptop forwards it to the mini, because the
mini now owns this conversation.

Here's the bug. Every time a forwarded message reached the mini, the mini ran its
"start a session for this topic" code — even when a session for that topic was already
running from the first message. It never checked "wait, am I already talking in this
conversation?" So instead of handing the new message to the session that's already
going, it tried to start a fresh one.

And it got worse because of a naming detail. The mini remembers a session by its full
internal name, something like `echo-topic-13481`. When the follow-up came in, it fed
that full name back into the "start a session" function — which adds the `echo-` prefix
AGAIN, producing `echo-echo-topic-13481`. The mini looked for a session by that
double-prefixed name, didn't find one (because the real one is `echo-topic-13481`), and
so spawned a brand-new duplicate session. Every single follow-up would spin up yet
another duplicate, and none of them would be the original moved conversation. Your
"now do the other thing" would land in some fresh, confused session — not the one that
already knew what "the other thing" was.

This matters a lot because the live test for the whole feature is exactly: move the
conversation, then send a follow-up and expect a sensible reply. With this bug, the
move would look fine but the follow-up would fall apart — which is the worst kind of
bug, because it hides until the moment you actually rely on it.

The fix makes the mini behave like the laptop already does for normal messages. When a
forwarded message arrives:
- First it checks: is there already a live session for this conversation on this
  machine? If yes, it just hands the message to that running session (with the normal
  `[telegram:…]` label the session expects), and stops. No new session, no duplicate.
- Only if there's NO live session does it start one — and when it does, it uses a clean
  name (`topic-13481`), never the already-prefixed one, so the double-prefix problem
  can't happen again.

One honest note: like the previous multi-machine fixes, I proved this at the code and
unit-test level, but I have NOT yet proven it live, because the moved session can't
actually run on the mini until the mini's Claude is logged in — a one-time step only
the user can do. So this ships unit-verified, and the live confirmation (move, then a
follow-up that the moved session answers correctly) comes the moment the mini is logged
in and I re-run the test.

Why it's safe to ship now: this code only runs when the multi-machine session pool is
turned on (it's off by default), and if anything goes wrong it falls back to the old
spawn behavior — it never blocks a message. A normal single-machine agent never touches
this path at all.
