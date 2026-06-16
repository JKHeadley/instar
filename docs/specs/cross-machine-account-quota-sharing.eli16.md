# Cross-Machine Account & Quota Sharing — plain-English overview

## The problem, in one breath

You run me on more than one computer (say a Laptop and a Mac Mini). A conversation
can "live" on either one. We already proved a conversation can MOVE from the Laptop
to the Mini. But when it landed on the Mini, the Mini went silent — it gave you the
"🔭 working…" spinner and never actually replied.

Why? Because your Claude accounts are logged in **per computer**. The Mini had
*zero* of your accounts logged into it, so it literally had no way to talk to
Claude and produce an answer. The conversation moved to a machine that couldn't do
the work. That dead, never-arriving reply is the whole problem.

## What you asked for

"Make it seamless — share all my accounts and all my quota across machines, so
whichever machine holds a conversation can always answer."

## The catch we discovered (and why the obvious fix is dangerous)

The obvious fix is "copy every account onto every machine." We can't do that
safely, for two hard reasons we verified in the code:

1. **Anthropic forbids it.** Claude login tokens aren't allowed to be copied out of
   the official Claude tool into other places, and that rule is enforced.
2. **It would destroy your accounts.** Claude rotates a secret "refresh token"
   every time it's used. If the same login lived on two machines and both used it,
   the second machine's copy would instantly break — silently logging that account
   out. We proved this happens.

So "copy the credential everywhere" isn't a shortcut — it's a foot-gun.

## The fix we're building instead

Flip the problem around. Instead of moving the *credential* to where the *work* is,
move the *work* to where the *quota* is.

When a conversation's home machine can't answer (no working account), the system
**automatically moves the whole conversation to a machine that CAN** — using the
exact "move a conversation between machines" mechanism we already built and proved.
The machine that now holds it answers normally, using its own logged-in account.
You never see a dead reply. From your side it's invisible: you send a message, you
get an answer, full stop.

To you, the result is identical to "sharing all accounts" — the reply always comes,
drawn from whatever quota the pool has. We just get there without ever copying a
credential, which keeps your accounts safe.

## What review changed about the design

The first draft proposed something more complicated: let one machine *serve* a
conversation while a different machine still *owned* it. Six independent reviewers
(plus two outside AI models — GPT-tier and Gemini-tier) all said: don't split those
apart. If two machines are involved in one conversation, you risk both of them
answering (you'd get doubled replies) or neither (silence again). So we collapsed
it: the machine that answers IS the machine that owns the conversation. Simpler,
and it reuses machinery we've already proven works.

Review also caught and fixed: making sure a flaky account can't make a conversation
bounce back and forth between machines (we added "cooldown" timers); making sure if
EVERY machine is out of quota you get one honest "all accounts are at their limit,
resets around X" message instead of either silence or a flood of repeats; and making
sure the "who is my verified user" information travels correctly when a conversation
moves, so the new machine always knows who it's talking to.

## What ships, and how safely

This ships **dark** (turned off) at first, then in a "dry-run" mode that only
*logs* what it *would* do, before it's allowed to actually move anything. On a
single-machine setup it does nothing at all. And — by our own gold-standard testing
rule — it isn't "done" until a real message you send is genuinely answered by the
second machine, proven end to end through Telegram and Slack, before you're ever
asked to test it.

## What we deliberately did NOT build (yet)

Actually relocating a login from one machine to another ("make account X live on
the Mini") is a separate, harder, riskier job. It adds nothing you'd notice over
the automatic-move approach above, so we split it into its own future spec rather
than bolt it on here.
