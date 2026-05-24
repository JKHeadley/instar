# Plain-English overview — remembering *how we're working*, not just *what we said*

## The one-sentence version

Rung 0 taught me to remember the **facts and decisions** in a conversation.
Rung 1 teaches me to remember **the way we're working right now** — like the
fact that we're testing something over Telegram — which is the exact thing I
forgot in the incident that started this whole project.

## Why this matters (the kitchen analogy)

Think of a busy kitchen. Rung 0 is me writing down the **recipe decisions** —
"we're using butter, not oil," "the cake comes out at 6pm." Useful.

But the thing I actually messed up wasn't a recipe decision. It was forgetting
**which stove we agreed to cook on**. Nobody writes "we're using the back
stove" on the recipe card — it's just the setup everyone's working in. So when I
drifted over to the front stove halfway through, the recipe card didn't catch it,
because that was never the *kind* of thing it tracked.

"We're testing over Telegram" is the back stove. It's not a fact the conversation
states — it's the *setup we're working inside*. Rung 1 makes me notice and hold
onto that setup, so when I start to wander off it, something gently says "hey,
weren't we on the back stove?"

## What actually changes

1. **Three new things I can remember:** the *method* (how we're working), the
   *audience* (who the work is for), and the *goal* (what this task is trying to
   do). These get stored in the exact same filing cabinet rung 0 already built —
   no new cabinet.

2. **I notice them the same way, for free.** The same once-per-message read that
   already runs now also looks for "what's the setup here?" — no extra cost, no
   button anyone has to press.

3. **These fade faster than facts.** "We're testing over Telegram" matters a lot
   *today* and should quietly fade in a few days once we've moved on — unlike a
   long-term fact like "Justin prefers plain English," which sticks around for
   months. So I'm giving different kinds of memory different "shelf lives," which
   is the short/medium/long-term idea you've been pointing at. (The exact shelf
   lives are starting guesses we can tune once we can watch them work.)

4. **It shows up where it'll actually help:** at the start of a session ("active
   setup: we're testing over Telegram") and as a gentle heads-up if I'm about to
   do something that drifts from it — a nudge, never a hard stop.

## What I want from you

This is the **ratification gate** — your sign-off before I build. Three small
choices I made a call on and want you to confirm (full reasons in the spec):

- **(A)** Track method / audience / goal as three separate things (my pick) vs.
  one lumped "task setup" thing.
- **(B)** Just teach the existing reader to also spot the setup (my pick, keeps
  it one cheap read) vs. a second, separate reader.
- **(C)** The starting "shelf lives" for how fast each kind fades — confirm the
  *idea* of different shelf lives; the exact numbers are knobs we tune later.

## One honest caveat

I wrote and self-reviewed this, but the full multi-model review process
(/spec-converge + /crossreview, where GPT/Gemini/Grok catch things my own family
misses) isn't installed on this machine. So "approved" here means "yes, this
direction is right, go ahead" — and I'd still want to run it through the full
review (or harden it more myself) before the code actually ships.
