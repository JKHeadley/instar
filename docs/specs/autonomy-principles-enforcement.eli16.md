# Autonomy Principles Enforcement — Plain-English Overview (ELI16)

## What this is

Justin wrote down two rules for how the agent should work (PR #1050) and asked: how do we
bake these into Instar so they actually happen, instead of just being words in a doc?

**Rule 1 — Almost every "I'm blocked" is a fake wall.** When the agent says "I can't do this,
I need you," that's usually a judgment call it's ducking, not a real wall. The right move is to
work it: Do I have permission? Do you? Can I get the access myself? Try it safely (dry-run),
then for real (live-run), then write down the steps so next time it's a reusable skill. On the
rare occasions a wall is genuinely real, record *why* — so nobody re-fights it every session.

**Rule 2 — Decide everything up front.** When the agent designs a feature, it should pull ALL
the decisions that need you to the *front* of the design, so it can then build the whole thing
in one go without stopping to ask you mid-way. Because agents build 100–1000x faster than humans
behind safe "dark / dry-run / read-only" phases, it's cheaper to finish the build and let you
change a decision afterward than to freeze mid-run waiting for you.

## What we found

Rule 1 is mostly already built — Instar already *catches* the agent making excuses (a hook +
two gates). What's missing is the part that *works the blocker through* and *remembers* the
outcome. Rule 2 is barely built — our spec-review process checks for security and bugs, but
never checks "could the agent actually finish this in one run?"

## What we're adding

1. **A Blocker Ledger** — a durable list where every blocker gets logged and walked through the
   pipeline. Two ways a blocker can end: "resolved" (the agent figured it out — and it MUST leave
   behind a reusable playbook, proven by a real successful run, or it doesn't count) or
   "true-blocker" (genuinely yours — and it MUST name a real reason from a fixed list, prove the
   agent first tried to do it itself, and actually asked you).

2. **A Decision-Completeness gate** — before a design can be called "done reviewing," a new
   reviewer hunts for every spot where the agent would have to stop and ask you, and forces each
   one to be decided up front or explicitly marked "safe to change later." A design can't pass
   while a real question is still buried in it.

3. **Stronger cross-model review** — Justin noticed we've been skipping the step where OTHER AI
   models (Gemini, GPT) review our designs. Now it's mandatory, and it auto-picks the strongest
   available model from whatever AI tools the agent has — no hard-coded model names, so it stays
   current as models improve.

## The big thing review caught

The first draft of the Blocker Ledger was DANGEROUS. A "this is a real wall, settled" record
that future sessions trust would have made the agent LAZIER — it could rubber-stamp a fake wall
once and then point to its own record forever as proof it shouldn't try. Six independent reviewers
(including a live Gemini cross-model pass) caught this. The fix: a "true-blocker" is never
"settled" — it's always "a guess, last checked on <date>," it gets automatically re-opened and
re-tested on a schedule, and the agent literally cannot mark one without proving it first tried
to do the thing itself (checked its own vault for the password, etc.) and then asked you. The
ledger now makes ducking work *harder*, which was the whole point.

## What changes for you

Nothing breaks. It all ships "dark" (off) first. Over time: the agent stops handing you fake
blockers, its designs stop stalling halfway, and its design reviews get a real second opinion
from other AI models — automatically.
