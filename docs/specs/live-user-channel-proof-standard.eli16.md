# ELI16 — Live-User-Channel Proof (the gold-standard testing standard)

## The short version

Right now, when I build something you use through chat — like the ability to move
a conversation from my laptop to my Mac Mini — I test it with automated tests that
run inside my own code. Those tests can all pass while the real thing is still
broken. That's exactly what happened on June 15: the "move this topic to the Mini"
feature reported success, but the conversation never actually moved. **You found
that out the first time you tried it.** That's the failure this work fixes — not
just the move bug, but the fact that *you* were the one who hit it.

## What we're adding

Three connected things, plus one first use of them:

1. **A rule (in the constitution).** A feature you interact with through chat isn't
   "done" until a session pretending to be *you* has actually used it — through the
   real channels, **both Telegram and Slack** — across a big checklist of
   situations, before you're ever asked to try it. The goal is that ~90% of the
   things that could go wrong are caught by me, in a real live test, before they
   ever reach you.

2. **Teeth (so the rule can't be ignored).** Saying "I'll test better" is a wish.
   So I'm adding a gate: when one of my autonomous work-sessions tries to declare a
   chat-facing feature "done," it gets blocked unless there's a real, machine-written
   record proving the live test actually ran on both Telegram and Slack and passed.
   I can't hand-write that record to sneak past — it has to come from the test
   harness itself. This is the same trick we used this morning to stop me from
   re-labeling unfinished work as "follow-ups."

3. **The test harness.** A tool that logs in and drives a feature like a real human
   user would — sending real messages, reading the real replies — and writes down
   pass/fail for each situation. Anything risky (testing permissions, anything that
   could break things) runs on throwaway practice accounts — a demo Slack workspace
   and a demo Telegram group — never your real account.

4. **The first feature we point it at: the broken "move between machines" bug.**
   I traced exactly why the move fails: the record of "which computer owns this
   conversation" lives only in the memory of one machine and never gets copied to
   the other, so the other machine never learns it's now in charge. I'll fix that so
   the conversation really moves, make the feature stop lying about success when it
   didn't actually move, and then prove the fix with the new harness over both
   Telegram and Slack before calling it done.

## Why it matters to you

You should almost never be the one who discovers a broken feature. Today you are,
too often, because my testing stops at the edge of my own code. After this, the bar
is: I act as you, through your real channels, and catch the problem first. It means
you can trust "done" to mean done — and it means you depend on me a little less,
which is the whole point.

## The main tradeoff

Real live testing is slower and needs real (practice) accounts to log into, versus
fast fake tests that run instantly but can miss real-world breakage. We're choosing
the slower, realer path for the final "is it really done?" proof, while keeping the
fast tests for quick breadth. The new gate also ships carefully: first it just
*logs* what it would block (so we can watch it for false alarms), then it warns,
then it actually blocks — so it never surprises a real work-session by slamming a
door shut on day one.

<!-- CMT-1568 -->
