# Why the agent's internal thinking went dark — and the one-line limit behind it

## The short version

Your agent runs a lot of small background "judgment calls" on itself: is this message safe to send,
did that job really finish, is this session stuck. Those calls were failing — most of them, all day —
and the reason turned out to be a size limit on how much text you can hand a terminal in a single
command.

## What actually broke

The agent talks to its own reasoning sessions by typing into a terminal, the same way you would. The
command it uses (`tmux send-keys`) takes the entire message as **one single argument**.

Operating systems cap how big a single command argument can be. On the affected machine that cap
worked out to about **16 KB**. A 16.2 KB message went through; a 16.5 KB one came back with three
words: `command too long`.

The prompts these background checks send are routinely **40 KB**. So they never had a chance. They
weren't slow, or rate-limited, or expensive — they were simply too long to hand over, every time.

## Why nobody caught it for hours

This is the part worth understanding, because the failure hid behind a *wrong label*.

When a call fails, a safety component called the circuit breaker steps in and pauses further calls so
the agent doesn't hammer a broken service. Sensible. But its log message was hardcoded to say:

> `OPEN: provider rate-limited`

It said that for **every** cause. So the logs showed a machine that had apparently blown through its
usage quota fourteen times in a row. Every instinct that message creates — check the plan, check the
billing, wait for the limit to reset, maybe buy more capacity — points somewhere the problem wasn't.

The actual reason string was sitting right there in the same line, saying `command too long`. The
headline just talked over it.

Meanwhile ten separate components sat at 76–100% failure, including the one that reviews the agent's
outgoing messages and the one that checks whether it's telling the truth about finishing work.

## What changed

**1. Big messages are now sent in pieces.** All nine places that send text to a terminal now route
through one shared helper that splits anything oversized into safe-sized chunks. The receiving end
sees exactly the same text — verified byte-for-byte on a real terminal with a 40 KB payload.

**2. The breaker stops guessing.** It now reads the actual failure and says what it was — "prompt too
large for the transport (argv ceiling — NOT a rate limit)", or a genuine rate limit when it genuinely
is one, or plain "provider unavailable" when it honestly can't tell. It no longer asserts a cause it
didn't measure.

**3. A check stops this class coming back.** A new lint fails the build if anyone adds a raw
unsplit send. This matters more than the fix: seven of the nine call sites had the same latent bug
and none had failed *yet*. Without the check, the next one added re-opens the hole, invisibly, until
real traffic hits it.

## What already existed

The splitting helper is new, but the pattern isn't — the codebase already funnels risky file and git
operations through single shared chokepoints for the same reason. This applies that pattern to
terminal sends.

There was also an obvious alternative fix (`load-buffer`/`paste-buffer`, which has no size limit at
all). It was deliberately **not** used: a comment in the codebase records that it triggers macOS
privacy-permission popups, and an unattended agent can't click a popup. Chunking keeps the existing
transport and avoids that entirely.

## What to watch out for

- **The chunk size is a fixed number (8 KB), not a live measurement.** It's set to roughly half the
  measured limit so there's room to spare, and a test checks a full-size chunk still sends in one
  call — so if that assumption ever breaks, it breaks loudly.
- **The breaker's log line changed.** Anything searching logs for the literal text
  `provider rate-limited` will now miss the cases that were never rate limits. That's the point, but
  it's a real change to a string other tooling might match on.
- **The lint is a guardrail, not a proof.** Someone building the command dynamically could still slip
  past it. It catches the direct, obvious pattern — which is how all nine of these were written.

## What you actually need to decide

Nothing is required of you. This is a correctness fix to something that was silently broken, and it
removes an over-block rather than adding one — no threshold moved, no new gate.

The one judgment call worth your attention: the misleading "rate-limited" label was arguably more
expensive than the bug. If there are other places where a component reports a cause it hasn't
measured, they'll mislead the same way, and that's a broader cleanup than this change covers.
