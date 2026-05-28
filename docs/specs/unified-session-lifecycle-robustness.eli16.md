---
title: "Unified Session-Lifecycle Robustness — the plain-English version"
date: 2026-05-27
author: echo
companion-to: unified-session-lifecycle-robustness.md
---

# Why your sessions were vanishing — and the fix

## What happened

Think of each working session as a burner on a stove that's actively cooking something. The system
has a cleanup crew whose job is to turn off burners that have been left on with nothing on them.

The trouble: the cleanup crew asks one quick question — "is anything cooking on this burner?" — and
only waits **one second** for an answer. Right after the kitchen reopens (a server restart), it's
chaos in there: lots of burners, everyone busy, slow to answer. When a burner doesn't answer in that
one second, the crew assumes it's empty and shuts it off — *even though dinner was still cooking on
it*.

That's literally what the log showed: at one restart it turned off **all 9 burners at once** and
declared every single one "empty," while several were still cooking. To you, your sessions just
blinked out — with nobody telling you.

## The bigger picture

When I went looking, I found there isn't *one* cleanup crew — there are **eight** different ones,
each hired at a different time, none of them talking to each other. They each decide "is this thing
alive or dead?" their own way, and most of them share the same three bad habits:

1. They mistake "slow to answer" (or "the laptop was asleep") for "dead."
2. They sometimes turn off a burner that's actually cooking.
3. They do it without telling you.

The good news: the *newest* crew — the one we built together recently (SessionReaper) — already does
this right. It refuses to shut anything off unless it has **positive proof** the burner is empty. If
it can't tell, it leaves the burner alone and checks again later. It also knows which burners are
protected and never touches those.

## The fix, in one sentence

**Give all eight crews one shared brain — the careful one we already built — instead of eight
careless ones.**

Concretely, three shared rules everyone now follows:

- **"Can't tell" never means "dead."** If a burner doesn't answer, we wait and ask again — we never
  shut it off on a guess. (This single rule would have saved all 9 of your sessions.)
- **No proof it's empty, no shutoff.** We only turn off a burner when we can actually see it's empty
  — never just because it went quiet for a bit.
- **If we genuinely do shut one off, we tell you.** With one exception: when a session is just being
  *restarted* to recover (turned off and immediately back on, like a quick reboot), that's not a
  disappearance, so we stay quiet — no spammy "I bounced your session" messages.

## A couple of specific culprits worth knowing

- One crew judged sessions purely by the clock and **counted the time your laptop was asleep** as if
  the session had been running the whole time — so a perfectly fine job looked "way overdue" after a
  nap and got shut off. Fix: don't count sleep time.
- One crew decided a session was "stuck" just from its log file going quiet — but a session waiting
  on a slow network looks exactly the same. Fix: actually check whether the work is still moving
  before declaring it stuck.

## Bonus

You also asked: when you rename a Telegram topic, the session label in the dashboard should rename
too. Small, unrelated to the bug, but it's the same "session labeling" area — so I bundled it in.

## What the review round changed (you approved the first draft — this made it stronger)

After you approved, I ran the spec through five independent reviewers plus our constitution-checker.
They found real things my own pass missed, and the design got noticeably stronger:

- **One bouncer instead of eight.** The first draft let all eight cleanup crews still make their own
  shut-off call, with the shared rules only as advice. The reviewers (rightly) called that out. Turns
  out we already have a single front-door that every shutoff *could* go through — so now they all do,
  and that front door holds the rules. A crew can *ask* to shut a burner off; the front door decides.
  No crew can act alone anymore.
- **The machines won't step on each other.** If you're running me on two computers, only the "awake"
  one is allowed to shut anything off — so a sleepy second machine can't reach over and kill the
  active one's work.
- **It won't slow down startup.** Being careful, done naively, would've made the kitchen take a
  minute-plus to reopen — bringing back the exact pile-up we're fixing. Now the careful check is fast:
  one quick "who's here?" question for everyone at once, with a hard time limit.
- **Nothing can hide forever, either.** A burner that *pretends* to be cooking (or that we genuinely
  can't get an answer about) used to risk never being touchable. Now, after a while, instead of
  guessing, I just ask *you* ("this one's been unreachable for half an hour — want me to force it
  off?") — and it can never clog things up so badly you can't start new work.
- **You get a log.** Every shutoff and its reason lands on a page you can pull up any time — so a
  vanished session is never a mystery again.

One honest caveat: the *external* reviewers (a GPT and a Gemini reading it independently) aren't wired
up on this machine yet — standing that up is its own separate piece of work I'm tracking. So this round
was my five internal reviewers plus the rules-checker, not the full outside panel.

## What I'm asking you

The spec proposes doing this in three chunks: first the fix for the bug you hit plus the shared brain,
then bringing the other crews onto it, then the polish. I'd build it straight through to merged once
you're happy with the shape — not ping you at every step.

Three small calls I'd like your steer on (they're in the spec's last section):
1. Should the "I had to shut down your session" notice be on by default? (I lean yes, but routed
   quietly to the right topic, not blasted everywhere.)
2. Want a "reap log" page in the dashboard so you can see every shutoff and why? (I lean yes.)
3. When you're almost out of Claude hours and the system sheds load, should it still spare a session
   that's mid-build, or is saving hours more important? (Your call on the tradeoff.)
