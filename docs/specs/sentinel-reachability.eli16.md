# Sentinel Reachability — plain English

## What's broken

We have a little guardian that watches for one specific problem: when Anthropic's
servers get briefly busy and tell Claude "slow down for a bit" (a temporary
throttle — *not* your usage limit running out). When that happens, the guardian
is supposed to do two things: tell you "heads up, I got throttled, I'm backing
off, you haven't been dropped," and then quietly poke the session to wake it back
up once the busy spell passes.

Here's the problem. Both of those actions started by asking one question: "Is
this session attached to a Telegram topic?" If the answer was no, the guardian
just stopped and did nothing — no message, no poke, nothing.

Think of it like a smoke alarm wired to send its alert only to the upstairs
phone. If you're standing in the kitchen with no upstairs phone, the alarm still
"goes off" internally — but nothing reaches you. You'd swear the alarm was dead.

Your interactive developer window — the one where you talk to me directly — isn't
attached to a Telegram topic. So when you hit that throttle in that window, the
guardian detected it, started its timer, and then dropped both the message and
the wake-up poke on the floor. You sat watching a frozen screen. That's exactly
what you reported, and why my earlier "it's fixed" was wrong: my tests only ever
checked the upstairs-phone case.

## What we're fixing

Make the guardian reach you no matter what kind of window you're in:

- **The wake-up poke** now has a second route. If there's no Telegram topic, it
  uses a trusted internal path to nudge the session directly. (That internal path
  is locked down — it can only be used from inside the program, never from the
  outside web interface, so it can't become a security hole.)
- **The "you're throttled" message** now tries your topic first, then falls back
  to your always-there system channel (the lifeline), and if even that's missing,
  it writes a loud note in the logs and on the dashboard. It never just goes
  silent.
- **A paper trail.** Every recovery attempt now leaves a record saying either
  "reached the user" or "couldn't reach the user," so we can never again *think*
  the guardian is working when it isn't.

## What's NOT in this change

The original plan also bundled two other things. Both are already handled, so
they're left alone here: the worktree safety fix already shipped, and the
"send all the quiet watcher alerts to Telegram" switch is deliberately staying
OFF (we turned it off on purpose to stop a notification flood — flipping it back
on would undo that).

## How I proved it this time

Not just tests. I rebuilt the real guardian, pointed it at a real terminal window
that was *not* attached to any topic, triggered the throttle, and watched: the
wake-up poke actually landed in the window, the "throttled, backing off" message
and the "back online" message both reached the lifeline channel, and the paper
trail showed "reached the user" with zero "couldn't reach." Before the fix, all
of that was silence.
