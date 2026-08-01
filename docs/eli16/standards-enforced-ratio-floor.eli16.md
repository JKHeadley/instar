# ELI16 — locking in today's constitution gain so it can't quietly slide back

We keep a constitution of 82 rules. An audit checks, for each one, whether the guard it claims actually
exists — and a build check runs that audit every time anyone pushes.

That check already had teeth in one place: if a rule points at a guard that isn't there, the build fails.
Zero tolerance, and it works.

**But the other number it measures — what fraction of rules are actually guarded — had its floor set to
zero.** So the figure was calculated and printed on every build, and nothing happened no matter what it
said. If it fell from today's level all the way back to where it started this morning, the build would still
pass.

Today that fraction moved from 53.7% to about 65%, because ten rules that were already being enforced
finally got citations the audit could see. **This change sets the floor just below where we now are**, so
that gain becomes a level every future build has to clear rather than a number someone can undo without
noticing.

## Why this can't break anyone's work

The floor is set *below* today's measured value. Any build that doesn't make things worse passes exactly as
it did before. The only thing it can newly stop is a change that lowers the fraction — someone adding a rule
with no guard, or deleting a guard a rule depends on. That is precisely what it's for, and the failure
message names both the floor and the measured value so the author can see what happened.

There's roughly one rule's worth of headroom, so it won't trip on rounding.

## The bit where I nearly got it wrong

I first set the floor from a number I'd been quoting all day — about 65.9%. Then I ran the actual build
script and it reported 65.4%, counting 81 rules where the other tool counts 82. **Two pieces of code
measuring the same thing from the same file, disagreeing by one.**

So I set the floor against the number the *build* uses, since the build is what enforces it, and left more
headroom than I'd planned. I wrote the disagreement into the code comment rather than quietly picking the
nicer figure — a future reader should know those two numbers don't match, because otherwise they'll trust
both.

## Undoing it

There's already an environment setting that overrides the floor, so it can be switched off in the build
config with no code change at all. Or revert one line. Nothing is stored, nothing migrates.

## What I checked

I proved it can actually fail, rather than only that it passes: set the floor artificially high and the
check exits with an error; set it to the real value and it passes. A guard nobody has watched fail isn't a
guard.

## What this is not

It doesn't make our rules better enforced. It measures whether each rule *names a guard that exists* — not
whether that guard genuinely does the job. This locks in bookkeeping, not safety. The real work is still the
24 rules that name no guard at all.
