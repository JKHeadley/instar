# ELI16 — Why "restart sessions" never reached your stuck session

## The problem

You sent a session a message to wake it up — "restart sessions" — and instead
of doing anything, I replied *"I didn't recognize that command"* and showed you
a list of commands that literally included "restart sessions." That's
maddening: I rejected the exact thing I told you to type. Worse, your message
never actually reached the session at all.

Here's what was really happening under the hood.

I have a set of emergency "fix command" shortcuts — short things you can type
like "restart", "fix auth", "clean processes" — that I handle directly without
spinning up a whole AI session. They exist for one specific place: the **Agent
Attention topic**, where I post little "something needs fixing, tap to resolve"
notifications. In that topic, typing "restart" should just work.

The bug: the code that *catches* those shortcut words was running in **every
topic**, not just the Attention topic. So any message you sent that happened to
start with "restart", "fix ", or "clean " got grabbed by the shortcut-catcher
first. The catcher then asked the real handler to run it — but the real handler
checks "am I in the Attention topic?" and, if not, quietly says "not mine" and
does nothing. At that point the catcher gave up with the confusing "I didn't
recognize that command" message **and threw your message away** — it never got
passed along to the session you were actually talking to.

So two everyday things were broken:
1. Trying to revive a stuck session by typing "restart sessions" in that
   session's own topic — eaten, with a misleading reply.
2. Just talking normally — "restart the build", "fix the login page", "clean up
   this function" — anything that started with one of those words got silently
   swallowed instead of reaching the session.

## What already exists

- The fix-command shortcuts ("restart", "fix auth", etc.) and the handler that
  runs them. These were already correctly limited to the Attention topic *on
  the execution side* — the handler refuses to act anywhere else.
- The normal path that routes a message to its session. That path was always
  there; the shortcut-catcher was just jumping in front of it and stopping it.

## What's new

One small, surgical change: the shortcut-catcher now checks **which topic it's
in before grabbing the message.** It only intercepts inside the Agent Attention
topic. Everywhere else, the message flows straight through to the session like
any other message.

The check is a tiny pure function, `shouldInterceptFixCommand(text, topicId,
attentionTopicId)`, that returns "yes, intercept" only when the message is in
the Attention topic AND looks like a fix command. It's covered by 17 unit tests
that nail down both sides: in the Attention topic the shortcuts still fire (and
lookalike words like "fixture" or "cleanup" correctly don't); in any other
topic, "restart sessions" and friends fall through to the session.

## The safeguards in plain terms

- **Nothing is removed.** The fix-command shortcuts still work exactly as
  before — they were always Attention-topic-only on the execution side; now the
  catching side agrees. So no real capability is lost.
- **Fail-safe default.** If I don't yet know which topic is the Attention topic
  (e.g. very early at startup), the catcher simply doesn't intercept — messages
  go to the session. That's the safe direction: route, don't swallow.
- **It only makes the gate *less* aggressive.** This change can only let more
  messages through to sessions; it can never block a message that wasn't already
  being blocked. That's why the risk is low.

## What you need to decide

Nothing complicated. This is a bug fix that makes your messages reliably reach
your sessions. The only judgment call is whether to ship it as a normal patch
(yes) — there's no new setting to configure and no behavior you have to opt
into. After it deploys, "restart sessions" (and ordinary chat starting with
restart/fix/clean) will reach the session instead of being eaten.
