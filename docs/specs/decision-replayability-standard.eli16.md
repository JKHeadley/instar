# When the agent decides for you, you should be able to see the decision — Plain-English Overview

> The one-line version: parts of this system make choices on your behalf, and some of them were
> recording almost nothing about it. You could see *that* a decision happened, but not what the
> options were, what was picked, or why. That's a receipt, not a record.

## The problem

There's a component that answers approval prompts for you. When your agent is running somewhere you
can't see — driven from your phone, say — and the terminal stops to ask "do you want to proceed?",
nobody is sitting there to press a key. So this component presses it.

That's the right behaviour. The problem is what it wrote down afterwards: only the name of the
pattern that matched. Nothing about what was on the screen, what the options were, which one it took,
or why.

That can't be reviewed. If you came back later and asked "should it have pressed that?", the record
can't tell you. You'd know something happened, and nothing more.

The reason it was built that way was privacy — the reasoning being that terminal contents might be
sensitive, so better to store none of it. That reasoning gets the trade backwards. A choice made on
your behalf that can't be reconstructed is a choice nobody can hold to account. That's a safety
problem wearing a privacy costume.

## What changes

From now on, when something decides for you, the record has to be good enough to *replay* the
decision: what was offered, what was chosen, the reasoning that produced it, and enough of the
surrounding situation to judge whether it was right.

The test is simple — if someone reading the record can't reconstruct the situation well enough to
*disagree* with the choice, the record isn't good enough.

## The screenshot question

The obvious next question is whether we should just save a picture of the screen. That was asked, and
the answer is interesting, because the question hides an assumption: that the choice is between a
picture and nothing.

For a terminal, it isn't. Saving a picture of the terminal and saving the terminal's *text* capture
exactly the same information. But the text can be automatically checked for passwords and keys before
it's saved, it can be searched later, and it can be compared between incidents. A picture can do none
of those things.

So the rule is: **save the text wherever text exists.** That's not being squeamish about the picture —
it's that the picture is a *worse* record which also happens to be one we can't clean. Where there
genuinely is no text version, like a browser page or a graphical dialog, then a picture it is, with
limits on how much and how long.

## Two limits worth knowing

**We capture the prompt and its surroundings, not the whole scrolled-back terminal.** Everything
further up is unrelated output from other work, which might contain sensitive things and answers no
question the prompt doesn't already answer. Capturing more would be less safe and no more useful.

**Nothing gets saved without being checked for credentials first.** And — this is the part that
matters most — if that check strips out so much that the record no longer explains the decision, the
record says so explicitly. It doesn't quietly leave behind something that looks complete but isn't.

That last rule exists because a log that silently became useless is the exact trap this whole line of
work keeps running into: something that's present, reports no problem, and guards nothing.

## What this does not do yet

**The standard is written. The code does not follow it yet.** The component described above still
records only the pattern name. Changing it is real work, and it's been registered as a tracked item
rather than quietly assumed.

Saying "we have a standard for that" while the code ignores it would be the same failure this
standard is about — so it's worth being blunt: right now this is a rule we've agreed to, not a rule
the system enforces.
