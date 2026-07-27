# ELI16 — the guard now covers the whole class it names

## The thing being protected

Some features in this codebase ship switched off and "graduate" to on once a stated
condition is met — usually a number read from a specific web address inside the agent.
The document describing the feature names that address.

If the address does not exist, the condition can never be checked. The feature then sits
switched off forever, and nothing anywhere says so. It looks careful. It is actually stuck,
and the difference is invisible.

A guard was built earlier today that refuses the build when a feature's document names an
address that does not exist. That guard works.

## What was wrong with it

It only looked at features marked `active`.

Feature documents also come marked `composed`, which means the feature graduates alongside
a bigger parent feature rather than on its own. It is easy to read that as "somebody else's
problem, skip it".

That reading is wrong, and I checked the documents rather than assuming. A `composed`
feature still states its own graduation condition, still names an address to read it from,
and in one case still carries numeric thresholds to compare against. If its address is
missing, the condition is exactly as uncheckable, and the feature parks for exactly the
same reason. The word describes *who owns graduation*, not *whether the evidence matters*.

So the guard's scope was narrower than the problem it was built for. Three feature documents
sat outside it.

## What changed

The guard now covers both kinds, and its summary line reports the two counts separately —
so if someone later narrows it again, a number visibly drops to zero instead of the change
passing unnoticed.

## Why widening it is safe

This is the part worth understanding, because widening a guard normally means more work
forced on people.

It does not here. The guard already has an escape hatch: a list of accepted exceptions,
each of which must carry a written reason, and each of which is automatically deleted the
moment its address starts working again. So a `composed` feature whose parent was genuinely
abandoned does not have to be fixed — it has to be *declared*, with a reason, in a list that
cleans itself up.

Getting in requires evidence. Getting out happens by itself. Nobody is forced to fix
anything; they are forced to say what they decided.

## Honest limits

Nothing was broken when I checked — all eight addresses currently work. This closes a hole
in the guard rather than repairing an outage.

And this is a correction to my own work from a few hours ago. The guard I wrote said in its
own header that it had swept every relevant document. That was true of the scope I gave it,
and the scope was smaller than the class. Checking once is not the same as checking
everything, which is the discipline this whole effort is about.
