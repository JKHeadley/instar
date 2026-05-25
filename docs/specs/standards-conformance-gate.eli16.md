# Plain-English overview — making the rulebook actually check the work

## The one-sentence version

We wrote a rulebook (the constitution), but nothing actually *reads* it when I
write a new plan — so a plan can break a rule and slip through. This builds the
checker that reads the rulebook and flags plans that break the rules.

## Why this matters (the building-inspector analogy)

Imagine a town with a thick building code, but no inspector. Builders are *told*
to follow the code, and mostly they try — but the only thing actually catching a
violation is the homeowner noticing the crooked wall after move-in.

That's where we are. The constitution exists. But the "check this plan against the
rules" step is just an instruction I'm supposed to remember during review — and on
this machine, the tool that's supposed to run that step isn't even installed. So
when my North Star plan quietly broke the "no making the human do manual work"
rule, the review didn't catch it. *You* did. You were the homeowner spotting the
crooked wall.

This builds the inspector: a piece of code that reads the actual rulebook and
checks a new plan against every rule, then hands back a short report — "this part
might break the No-Manual-Work rule, here's why." It's the same lesson we keep
hitting — *don't rely on remembering, build the thing that runs* — finally applied
to the rulebook itself.

## What it does, concretely

1. **Reads the rulebook into a list** the code can work with (each rule, plainly).
   It double-checks it actually found the rules (so a formatting change can't
   silently make half the rulebook invisible).
2. **Checks a plan against every rule** using a careful read, and produces a
   report: for each rule, "fine / might break this / doesn't apply," with a reason.
3. **Hands you the report — it does NOT block anything.** This is important: it's a
   second pair of eyes that flags concerns, not a bouncer. You and I still decide.
   We only consider letting it actually block things later, once we've seen it's
   accurate enough to trust.
4. **Keeps score** of which rules get flagged most — so over time we can see which
   rules keep getting bent (maybe they need to be clearer, or guarded earlier).

## What I want from you

This is the **ratification gate** — your sign-off before I build. Three calls I
made and want you to confirm (details in the spec):

- **(A)** Give a rule-by-rule report (my pick) vs. one overall pass/fail.
- **(B)** For now it only *advises* — it doesn't block commits. We'd add blocking
  later, only after we've watched it and trust its accuracy (my pick).
- **(C)** Use a stronger (more careful) model for the check, since it runs rarely
  and the judgment is subtle (my pick).

## One honest caveat (same as last time)

I wrote and self-reviewed this, but the full multi-model cross-check tooling isn't
on this machine. So "approved" means "direction's right, go build" — and a fuller
review is still worth doing before we lean on it. There's a nice irony here: this
spec is *for the very tool* that would make that review step automatic.
